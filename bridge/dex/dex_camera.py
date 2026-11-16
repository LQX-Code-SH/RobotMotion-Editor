#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""天工 DEX 相机话题订阅与 JPEG 推流。

相机话题（xhumanoid_sdk/core/topics.py）：
  /ob_camera_head/color/image_raw
  /ob_camera_waist/color/image_raw
  /ob_camera_wrist_left/color/image_raw
  /ob_camera_wrist_right/color/image_raw

传输选择（真机实测口径，参考 Thinker-IL-LAB 的 ros2_deploy_bridge）：
- 优先订阅 ``<topic>/compressed``（``sensor_msgs/CompressedImage``）。raw
  1280x720 在 rclpy 里反序列化约 35 ms/帧，桥接只能转出 10~16 fps；
  compressed 解码+缩放+重编码约 11 ms/帧，可稳定 ~20 fps。
- 该路没有 compressed 发布端时回退 raw。
- 已经是 JPEG 且宽度不超过上限时直接透传，不再解码重编码。

QoS：相机流统一 BEST_EFFORT + KEEP_LAST(10)。BEST_EFFORT 订阅能兼容
RELIABLE 与 BEST_EFFORT 两种发布端，反向不成立。

编码：优先使用 OpenCV（cv2.imencode）转 JPEG；未安装 cv2 时相机功能禁用并告警。
按需订阅：有客户端请求某路相机时才创建订阅，全部取消后销毁，避免占用带宽。
"""

from __future__ import annotations

import base64
import threading
import time

CAMERAS = {
    'head': '/ob_camera_head/color/image_raw',
    'waist': '/ob_camera_waist/color/image_raw',
    'wrist_left': '/ob_camera_wrist_left/color/image_raw',
    'wrist_right': '/ob_camera_wrist_right/color/image_raw',
}

COMPRESSED_TOPICS = {key: f'{topic}/compressed' for key, topic in CAMERAS.items()}

DEFAULT_FPS = 10
MAX_WIDTH = 640
JPEG_QUALITY = 70


def camera_list():
    return [
        {
            'id': key,
            'topic': topic,
            'compressedTopic': COMPRESSED_TOPICS[key],
            'type': 'color',
        }
        for key, topic in CAMERAS.items()
    ]


def _jpeg_size(data):
    """从 JPEG 数据里读 SOF 段拿 (width, height)；解析失败返回 None。"""
    if len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None
    index = 2
    length = len(data)
    while index + 9 < length:
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        # SOF0-SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height = (data[index + 5] << 8) | data[index + 6]
            width = (data[index + 7] << 8) | data[index + 8]
            return width, height
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        segment = (data[index + 2] << 8) | data[index + 3]
        if segment <= 0:
            return None
        index += 2 + segment
    return None


class CameraManager:
    """多客户端共享的按需相机订阅。"""

    def __init__(self, node, logger=print):
        self.node = node
        self.log = logger
        self._lock = threading.Lock()
        self._entries = {}        # camera_id -> {sub, transport, topic, viewers, lastFrameAt}
        self._cv2 = None
        self._qos = None
        try:
            import cv2  # noqa: F401
            self._cv2 = cv2
        except Exception:
            self.log('[camera] 未安装 cv2，相机推流不可用（可 apt install python3-opencv）')

    @property
    def available(self):
        return self._cv2 is not None

    def describe(self):
        """相机清单 + 运行期状态（供 welcome / camera_list 下发）。"""
        now = time.monotonic()
        cameras = []
        for key, topic in CAMERAS.items():
            entry = self._entries.get(key)
            last = entry.get('lastFrameAt') if entry else None
            cameras.append({
                'id': key,
                'topic': topic,
                'compressedTopic': COMPRESSED_TOPICS[key],
                'type': 'color',
                'subscribed': entry is not None,
                'transport': entry.get('transport') if entry else None,
                'lastFrameAgeMs': None if not last else int((now - last) * 1000),
            })
        return cameras

    def info(self, camera_id):
        entry = self._entries.get(camera_id)
        if entry is None:
            return {'topic': CAMERAS.get(camera_id), 'transport': None}
        return {'topic': entry.get('topic'), 'transport': entry.get('transport')}

    def _camera_qos(self):
        if self._qos is None:
            from rclpy.qos import (DurabilityPolicy, HistoryPolicy, QoSProfile,
                                   ReliabilityPolicy)
            self._qos = QoSProfile(
                reliability=ReliabilityPolicy.BEST_EFFORT,
                history=HistoryPolicy.KEEP_LAST,
                depth=10,
                durability=DurabilityPolicy.VOLATILE,
            )
        return self._qos

    def _has_publisher(self, topic, wait_s=0.6):
        """短暂等待图发现，判断某话题是否有发布端。"""
        deadline = time.monotonic() + wait_s
        while True:
            try:
                if self.node.count_publishers(topic) > 0:
                    return True
            except Exception:
                return False
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.1)

    # ---------- 订阅管理 ----------

    def _create_subscription(self, camera_id):
        """优先 compressed，缺发布端时回退 raw。"""
        compressed_topic = COMPRESSED_TOPICS[camera_id]
        if self._has_publisher(compressed_topic):
            from sensor_msgs.msg import CompressedImage
            sub = self.node.create_subscription(
                CompressedImage, compressed_topic,
                (lambda msg, cid=camera_id: self._on_compressed(cid, msg)),
                self._camera_qos())
            return sub, 'compressed', compressed_topic

        from sensor_msgs.msg import Image
        raw_topic = CAMERAS[camera_id]
        sub = self.node.create_subscription(
            Image, raw_topic,
            (lambda msg, cid=camera_id: self._on_image(cid, msg)),
            self._camera_qos())
        return sub, 'raw', raw_topic

    def subscribe(self, camera_id, token, fps, callback):
        """订阅相机；callback(jpeg_bytes, width, height, stamp_sec, jpeg_size)。"""
        if not self.available:
            return False, 'cv2 未安装'
        if camera_id not in CAMERAS:
            return False, f'未知相机 {camera_id}'

        with self._lock:
            entry = self._entries.get(camera_id)
            if entry is None:
                try:
                    sub, transport, topic = self._create_subscription(camera_id)
                except Exception as exc:
                    return False, f'订阅失败：{exc}'
                entry = {
                    'sub': sub,
                    'transport': transport,
                    'topic': topic,
                    'viewers': {},
                    'lastFrameAt': 0.0,
                }
                self._entries[camera_id] = entry
                self.log(f'[camera] 订阅 {topic}（{transport}）')
            entry['viewers'][token] = {
                'cb': callback,
                'fps': max(1, min(30, int(fps or DEFAULT_FPS))),
                'last': 0.0,
            }
        return True, ''

    def unsubscribe(self, camera_id, token):
        with self._lock:
            entry = self._entries.get(camera_id)
            if entry is None:
                return
            entry['viewers'].pop(token, None)
            if not entry['viewers']:
                try:
                    self.node.destroy_subscription(entry['sub'])
                except Exception:
                    pass
                self._entries.pop(camera_id, None)
                self.log(f'[camera] 取消订阅 {camera_id}')

    def unsubscribe_token(self, token):
        for camera_id in list(self._entries):
            self.unsubscribe(camera_id, token)

    def shutdown(self):
        for camera_id in list(self._entries):
            try:
                self.node.destroy_subscription(self._entries[camera_id]['sub'])
            except Exception:
                pass
        self._entries = {}

    # ---------- 帧处理 ----------

    def _take_viewers(self, camera_id):
        """按各路 fps 节流，返回本轮要推送的回调列表。"""
        entry = self._entries.get(camera_id)
        if entry is None or not entry['viewers']:
            return None, []
        now = time.monotonic()
        targets = []
        with self._lock:
            for viewer in entry['viewers'].values():
                interval = 1.0 / viewer['fps']
                if now - viewer['last'] >= interval:
                    viewer['last'] = now
                    targets.append(viewer['cb'])
            if targets:
                entry['lastFrameAt'] = now
        return entry, targets

    def _deliver(self, targets, jpeg, width, height, stamp):
        # 协议里 data 是 base64 字符串（JSON 不接受 bytes）；每帧只编码一次
        data = base64.b64encode(jpeg).decode('ascii')
        for cb in targets:
            try:
                cb(data, width, height, stamp, len(jpeg))
            except Exception as exc:
                self.log(f'[camera] 推流回调异常：{exc}')

    @staticmethod
    def _stamp(msg):
        try:
            return msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
        except Exception:
            return 0.0

    def _on_compressed(self, camera_id, msg):
        cv2 = self._cv2
        if cv2 is None:
            return
        entry, targets = self._take_viewers(camera_id)
        if not targets:
            return

        data = bytes(msg.data)
        size = _jpeg_size(data)
        fmt = (getattr(msg, 'format', '') or '').lower()
        # JPEG 且无需缩放时直接透传，省掉一次解码+重编码
        if size and size[0] <= MAX_WIDTH and ('jpeg' in fmt or 'jpg' in fmt):
            self._deliver(targets, data, size[0], size[1], self._stamp(msg))
            return

        frame = self._decode_compressed(cv2, data)
        if frame is None:
            return
        self._encode_and_deliver(cv2, targets, frame, self._stamp(msg))

    def _on_image(self, camera_id, msg):
        cv2 = self._cv2
        if cv2 is None:
            return
        entry, targets = self._take_viewers(camera_id)
        if not targets:
            return

        frame = self._decode(cv2, msg)
        if frame is None:
            return
        self._encode_and_deliver(cv2, targets, frame, self._stamp(msg))

    def _encode_and_deliver(self, cv2, targets, frame, stamp):
        image, width, height = frame
        ok, encoded = cv2.imencode(
            '.jpg', image, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        if not ok:
            return
        self._deliver(targets, encoded.tobytes(), width, height, stamp)

    def _decode_compressed(self, cv2, data):
        try:
            import numpy as np
            image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                return None
            return self._resize(cv2, image)
        except Exception:
            return None

    def _resize(self, cv2, image):
        height, width = image.shape[:2]
        if width > MAX_WIDTH:
            scale = MAX_WIDTH / float(width)
            image = cv2.resize(image, (MAX_WIDTH, int(height * scale)),
                               interpolation=cv2.INTER_AREA)
        return image, image.shape[1], image.shape[0]

    def _decode(self, cv2, msg):
        """sensor_msgs/Image -> (BGR ndarray, width, height)。"""
        try:
            encoding = msg.encoding
            height, width = int(msg.height), int(msg.width)
            if encoding in ('rgb8', 'RGB8'):
                import numpy as np
                img = np.frombuffer(msg.data, dtype=np.uint8).reshape(height, width, 3)
                img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            elif encoding in ('bgr8', 'BGR8'):
                import numpy as np
                img = np.frombuffer(msg.data, dtype=np.uint8).reshape(height, width, 3).copy()
            elif encoding in ('rgba8', 'RGBA8'):
                import numpy as np
                img = np.frombuffer(msg.data, dtype=np.uint8).reshape(height, width, 4)
                img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
            elif encoding in ('bgra8', 'BGRA8'):
                import numpy as np
                img = np.frombuffer(msg.data, dtype=np.uint8).reshape(height, width, 4)
                img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
            else:
                return None
            return self._resize(cv2, img)
        except Exception:
            return None
