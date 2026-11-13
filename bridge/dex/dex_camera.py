#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""天工 DEX 相机话题订阅与 JPEG 推流。

相机话题（xhumanoid_sdk/core/topics.py）：
  /ob_camera_head/color/image_raw
  /ob_camera_waist/color/image_raw
  /ob_camera_wrist_left/color/image_raw
  /ob_camera_wrist_right/color/image_raw
QoS：BEST_EFFORT + KEEP_LAST(10)（相机数据流专用，与关节的 RELIABLE 不同）。

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

DEFAULT_FPS = 10
MAX_WIDTH = 640
JPEG_QUALITY = 70


def camera_list():
    return [{'id': key, 'topic': topic, 'type': 'color'} for key, topic in CAMERAS.items()]


class CameraManager:
    """多客户端共享的按需相机订阅。"""

    def __init__(self, node, logger=print):
        self.node = node
        self.log = logger
        self._lock = threading.Lock()
        self._entries = {}        # camera_id -> {sub, viewers: {token: {cb, fps, last}}}
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

    # ---------- 订阅管理 ----------

    def subscribe(self, camera_id, token, fps, callback):
        """订阅相机；callback(jpeg_bytes, width, height, stamp_sec)。"""
        if not self.available:
            return False, 'cv2 未安装'
        topic = CAMERAS.get(camera_id)
        if topic is None:
            return False, f'未知相机 {camera_id}'

        with self._lock:
            entry = self._entries.get(camera_id)
            if entry is None:
                try:
                    from sensor_msgs.msg import Image
                    sub = self.node.create_subscription(
                        Image, topic,
                        (lambda msg, cid=camera_id: self._on_image(cid, msg)),
                        self._camera_qos())
                except Exception as exc:
                    return False, f'订阅失败：{exc}'
                entry = {'sub': sub, 'viewers': {}}
                self._entries[camera_id] = entry
                self.log(f'[camera] 订阅 {topic}')
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

    def _on_image(self, camera_id, msg):
        cv2 = self._cv2
        if cv2 is None:
            return

        entry = self._entries.get(camera_id)
        if entry is None or not entry['viewers']:
            return

        now = time.monotonic()
        targets = []
        with self._lock:
            for token, viewer in entry['viewers'].items():
                interval = 1.0 / viewer['fps']
                if now - viewer['last'] >= interval:
                    viewer['last'] = now
                    targets.append(viewer['cb'])
        if not targets:
            return

        frame = self._decode(cv2, msg)
        if frame is None:
            return
        image, width, height = frame

        ok, encoded = cv2.imencode(
            '.jpg', image, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        if not ok:
            return
        jpeg = encoded.tobytes()
        data = base64.b64encode(jpeg).decode('ascii')
        stamp = 0.0
        try:
            stamp = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
        except Exception:
            pass

        for cb in targets:
            try:
                cb(data, width, height, stamp, len(jpeg))
            except Exception as exc:
                self.log(f'[camera] 推流回调异常：{exc}')

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

            if width > MAX_WIDTH:
                scale = MAX_WIDTH / float(width)
                img = cv2.resize(img, (MAX_WIDTH, int(height * scale)),
                                 interpolation=cv2.INTER_AREA)
            return img, img.shape[1], img.shape[0]
        except Exception:
            return None
