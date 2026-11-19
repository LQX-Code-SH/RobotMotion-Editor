#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""天工 DEX（TienKung Dex）真机桥接服务。

与 RobotMotion-Editor 网页端、bridge/station.js 使用同一套发现与 WebSocket
协议（见 bridge/README.md），并扩展了灵巧手与相机消息：

  网页端 --WS--> 本服务 --ROS2 topics--> 天工 DEX 真机

功能：
  - 关节：/arm|head|waist/cmd 周期下发（默认 50Hz）、/robot_state 状态回传
  - 灵巧手：BrainCo（6 电机）/ Inspire（13 关节）归一化控制 + 状态回读
  - 相机：head / waist / wrist_left / wrist_right 彩色流按需推流（JPEG）
  - 安全：限位裁剪、速度斜坡、急停话题守卫、腿部拒绝直控

运行环境：机器人算力主机（Ubuntu 24.04 + ROS 2 Jazzy），建议 nvidia 用户：

  source /opt/ros/jazzy/setup.bash
  source /opt/humanoid/install/setup.bash
  source ~/xos/setup.bash
  python3 dex_bridge.py --hand brainco        # 或 --hand inspire / auto
  python3 dex_bridge.py --dry-run             # 无 ROS 环境下的协议联调

前置条件（真机）：遥控器切入 topic 控制模式（G 中 + E 上），机器人先进入归零姿态。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import signal
import socket
import sys
import threading
import time

# 机型适配目录：在 import joint_map 之前，根据 --model 注入对应机型目录到 sys.path。
# 预扫描 argv 只取 --model 的值；完整参数解析仍在 parse_args() 中完成。
from models import MODEL_DIRS, DEFAULT_MODEL, bootstrap as _bootstrap_models

_pre_model = DEFAULT_MODEL
for _i, _arg in enumerate(sys.argv):
    if _arg == '--model' and _i + 1 < len(sys.argv):
        _pre_model = sys.argv[_i + 1]
        break
    if _arg.startswith('--model='):
        _pre_model = _arg.split('=', 1)[1]
        break
_bootstrap_models(_pre_model)

from joint_map import (
    ALL_GROUPS,
    CONTROLLABLE_GROUPS,
    JOINT_TABLE,
    clamp,
    urdf_joint_names,
)


PROTOCOL_VERSION = 1

# 机型档案：优先读部署目录，其次源码目录；读不到时用内置默认值。
# 注意：profile.json 只提供展示元数据与能力声明，不提供 joints（joints 仍来自 joint_map）。
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROFILE_SEARCH_DIRS = (
    '/var/www/robot-editor',                       # .deb 部署（前端 dist 根）
    os.path.abspath(os.path.join(_HERE, '..', '..')),  # 源码运行（仓库根）
)

_DEFAULT_PROFILE = {
    'displayName': 'TienKung Dex',
    'vendor': 'UBTech',
    'backend': 'dex',
    'capabilities': {},
    'endEffectors': {},
}


def load_profile(model):
    """读取 robot/<model>/profile.json 的 bridge 段与 assets.endEffectors。

    只取展示/能力相关字段；任何读取失败都回退到内置默认值，绝不让桥接启动失败。
    """
    result = dict(_DEFAULT_PROFILE)
    for base in _PROFILE_SEARCH_DIRS:
        path = os.path.join(base, 'robot', model, 'profile.json')
        try:
            with open(path, 'r', encoding='utf-8') as fp:
                profile = json.load(fp)
        except (OSError, ValueError):
            continue
        bridge = profile.get('bridge') or {}
        assets = profile.get('assets') or {}
        if bridge.get('displayName'):
            result['displayName'] = bridge['displayName']
        if bridge.get('backend'):
            result['backend'] = bridge['backend']
        if profile.get('vendor'):
            result['vendor'] = profile['vendor']
        if isinstance(bridge.get('capabilities'), dict):
            result['capabilities'] = bridge['capabilities']
        if isinstance(assets.get('endEffectors'), dict):
            result['endEffectors'] = assets['endEffectors']
        return result
    return result


# 通道划分：控制 / 状态 / 相机使用独立固定端口。
# 控制通道保持向后兼容（接受全部消息），状态与相机通道只读。
CHANNEL_CONTROL = 'control'
CHANNEL_STATUS = 'status'
CHANNEL_CAMERA = 'camera'

BROADCAST_STATUS = (CHANNEL_CONTROL, CHANNEL_STATUS)

STATUS_CHANNEL_TYPES = {'hello', 'get_status'}
CAMERA_CHANNEL_TYPES = {'hello', 'get_status', 'camera_list', 'camera_subscribe', 'camera_unsubscribe'}


# ============================================================
# 参数
# ============================================================

def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='TienKung Dex robot bridge')
    parser.add_argument('--ws-port', type=int, default=8081, help='控制通道端口（接受全部消息）')
    parser.add_argument('--status-port', type=int, default=8082, help='状态通道端口（只读遥测，0=禁用）')
    parser.add_argument('--camera-port', type=int, default=8083, help='相机通道端口（只读推流，0=禁用）')
    parser.add_argument('--beacon-port', type=int, default=45678)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--model', default=DEFAULT_MODEL,
                        choices=sorted(MODEL_DIRS),
                        help='机型 ID（可选：%(choices)s）')
    parser.add_argument('--name', default=None)
    # gripper 仅 Walker S2 使用（PGC 1DOF 夹爪），其余机型忽略该值
    parser.add_argument('--hand', default='auto',
                        choices=['auto', 'brainco', 'inspire', 'none', 'gripper'])
    parser.add_argument('--rate', type=float, default=50.0, help='关节命令下发频率 Hz')
    parser.add_argument('--telemetry-hz', type=float, default=20.0)
    parser.add_argument('--max-speed', type=float, default=1.2, help='关节目标斜坡最大角速度 rad/s')
    parser.add_argument('--spd', type=float, default=0.3,
                        help='驱动侧速度参数 rad/s（位置模式下生效；实测 0.3 → 0.29 rad/s）')
    parser.add_argument('--cur', type=float, default=10.0,
                        help='驱动侧电流限幅 A（厂商头/腰 demo 用 40）')
    parser.add_argument('--release-after-s', type=float, default=5.0,
                        help='轨迹结束/停止后静置多少秒自动失能释放双臂（0=不自动释放，会一直保持）')
    parser.add_argument('--camera-width', type=int, default=640)
    parser.add_argument('--dry-run', action='store_true', help='不连接 ROS，仅验证协议')
    parser.add_argument('--trace', action='store_true',
                        help='status 里附带原始关节目标（调试跟踪误差，只读）')
    return parser.parse_args(argv)


# ============================================================
# dry-run 机器人（无 ROS 环境下的协议联调）
# ============================================================

class FakeDexRobot:
    """以简单运动学模拟真机行为，接口与 DexRobot 一致。"""

    def __init__(self, rate_hz=50.0, max_joint_speed=1.2, release_after_s=5.0, logger=print):
        self.rate_hz = rate_hz
        self.max_joint_speed = max_joint_speed
        self.release_after_s = max(0.0, float(release_after_s or 0.0))
        self.log = logger
        self.enabled = False
        self.mode = 'idle'
        self.estop = False
        self.estop_reason = None
        self._lock = threading.RLock()
        self._targets = {}
        self._command = {}
        self._release_at = None
        self._state = {
            row[2]: {'position': 0.0, 'velocity': 0.0, 'effort': 0.0}
            for rows in JOINT_TABLE.values() for row in rows
        }
        self._last_state_at = time.monotonic()
        self._trajectory = None
        self._traj_done = None
        self._events = []
        self._thread = None
        self._running = True
        self._start_loop()

    def _start_loop(self):
        def loop():
            dt = 1.0 / self.rate_hz
            while self._running:
                with self._lock:
                    self._advance_trajectory()
                    if self.enabled and not self.estop:
                        if self._release_at is not None and time.monotonic() >= self._release_at:
                            # 静置超时：停止"保持"（相当于 DexRobot.disable）
                            self._release_at = None
                            self.enabled = False
                            self._trajectory = None
                            self._targets = {}
                            self.mode = 'idle'
                            self._events.append({
                                'level': 'system',
                                'message': f'轨迹结束静置 {self.release_after_s:g}s，已自动失能（释放双臂保持）',
                            })
                            continue
                        max_delta = self.max_joint_speed * dt
                        for name, target in self._targets.items():
                            state = self._state.setdefault(name, {'position': 0.0, 'velocity': 0.0, 'effort': 0.0})
                            delta = target - state['position']
                            step = max(-max_delta, min(max_delta, delta))
                            state['position'] += step
                            state['velocity'] = step / dt
                            self._command[name] = state['position']
                time.sleep(dt)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def _advance_trajectory(self):
        traj = self._trajectory
        if traj is None:
            return
        elapsed = (time.monotonic() - traj['start']) * 1000.0
        frames = traj['frames']
        if elapsed >= frames[-1]['t']:
            if traj['loop']:
                traj['start'] = time.monotonic()
                traj['idx'] = 0
                self._targets.update(frames[0]['targets'])
                return
            self._targets.update(frames[-1]['targets'])
            self._traj_done = traj['id']
            self._trajectory = None
            self.mode = 'idle'
            self._release_at = (time.monotonic() + self.release_after_s
                                if self.release_after_s > 0 else None)
            return
        idx = traj['idx']
        while idx + 1 < len(frames) and frames[idx + 1]['t'] <= elapsed:
            idx += 1
        traj['idx'] = idx
        left = frames[min(idx, len(frames) - 1)]
        right = frames[min(idx + 1, len(frames) - 1)]
        span = right['t'] - left['t']
        ratio = 0.0 if span <= 0 else (elapsed - left['t']) / span
        pose = {}
        for name, value in left['targets'].items():
            target = right['targets'].get(name, value)
            pose[name] = value + (target - value) * ratio
        self._targets.update(pose)

    # --- 与 DexRobot 相同的外部接口 ---
    def enable(self):
        if self.estop:
            return False, '急停激活中，无法使能'
        with self._lock:
            if not self.enabled:
                self._targets = {}
            self.enabled = True
            self._release_at = None
        return True, ''

    def disable(self):
        with self._lock:
            self.enabled = False
            self._trajectory = None
            self._targets = {}
            self.mode = 'idle'
            self._release_at = None
        return True, ''

    def set_mode(self, mode):
        if mode not in ('idle', 'follow', 'execute'):
            return False, f'不支持的模式 {mode}'
        with self._lock:
            if mode != 'execute':
                self._trajectory = None
            self.mode = mode
            self._release_at = None
        return True, ''

    def set_joint_targets(self, targets):
        if self.estop:
            return {'accepted': False, 'reason': '急停激活中'}
        if not self.enabled:
            return {'accepted': False, 'reason': '未使能'}
        applied, rejected = {}, {}
        for name, value in (targets or {}).items():
            from joint_map import BY_URDF
            entry = BY_URDF.get(name)
            if entry is None:
                rejected[name] = '未知关节'
                continue
            if entry['group'] not in CONTROLLABLE_GROUPS:
                rejected[name] = '腿部由运控独占'
                continue
            clamped = clamp(name, value)
            if clamped is None:
                rejected[name] = '无效数值'
                continue
            applied[name] = clamped
        if not applied:
            return {'accepted': False, 'reason': '没有可下发的关节', 'rejected': rejected}
        with self._lock:
            self._targets.update(applied)
            self._release_at = None
        return {'accepted': True, 'applied': applied, 'rejected': rejected or None}

    def start_trajectory(self, trajectory_id, frames, fps=30, loop=False):
        if self.estop:
            return {'accepted': False, 'reason': '急停激活中'}
        if not self.enabled:
            return {'accepted': False, 'reason': '未使能'}
        if not frames:
            return {'accepted': False, 'reason': '轨迹为空'}
        normalized = []
        for frame in frames:
            targets = {}
            for name, value in (frame.get('targets') or {}).items():
                from joint_map import BY_URDF
                entry = BY_URDF.get(name)
                if entry is None or entry['group'] not in CONTROLLABLE_GROUPS:
                    continue
                clamped = clamp(name, value)
                if clamped is not None:
                    targets[name] = clamped
            if targets:
                normalized.append({'t': float(frame.get('t', 0.0)), 'targets': targets})
        if not normalized:
            return {'accepted': False, 'reason': '轨迹中没有可下发关节'}
        normalized.sort(key=lambda item: item['t'])
        with self._lock:
            self._trajectory = {
                'id': trajectory_id, 'frames': normalized,
                'loop': bool(loop), 'start': time.monotonic(), 'idx': 0,
            }
            self.mode = 'execute'
            self._release_at = None
        return {'accepted': True, 'frameCount': len(normalized), 'durationMs': normalized[-1]['t']}

    def stop(self):
        with self._lock:
            self._trajectory = None
            self._targets = dict(self._command)
            self.mode = 'idle'
            self._release_at = (time.monotonic() + self.release_after_s
                                if self.release_after_s > 0 else None)
        return True

    def emergency_stop(self):
        with self._lock:
            self.enabled = False
            self._trajectory = None
            self.estop = True
            self.estop_reason = 'software'
            self.mode = 'idle'
            self._release_at = None
        self._events.append({'level': 'warning', 'message': '软件急停：已停止下发'})
        return True

    def get_joint_states(self):
        with self._lock:
            return {name: dict(value) for name, value in self._state.items()}

    def snapshot_targets(self):
        with self._lock:
            return dict(self._targets)

    def state_age(self):
        return 0.0

    def take_trajectory_done(self):
        with self._lock:
            done = self._traj_done
            self._traj_done = None
            return done

    def drain_events(self):
        with self._lock:
            events = self._events
            self._events = []
            return events

    def trajectory_progress(self):
        with self._lock:
            traj = self._trajectory
            if traj is None:
                return None
            return {'id': traj['id'], 'frameIndex': traj['idx'], 'frameCount': len(traj['frames'])}


class FakeHands:
    vendor = 'mock'
    hand_type = 'mock-6'   # dry-run 通配：前端识别 mock-* 跳过末端匹配

    def __init__(self, logger=print):
        self.log = logger
        self._state = {'left': [0.0] * 6, 'right': [0.0] * 6}

    def describe(self):
        from joint_map import hands_joint_map
        return {
            'vendor': self.vendor,
            'type': self.hand_type,
            'sides': {
                side: {
                    'count': 6,
                    'names': ['thumb_flex', 'thumb_rotate', 'index', 'middle', 'ring', 'pinky'],
                    'jointMap': hands_joint_map('brainco', side),
                } for side in ('left', 'right')
            },
        }

    def get_state(self):
        return {side: {'vendor': self.vendor, 'values': list(vals), 'names': []}
                for side, vals in self._state.items()}

    def set_normalized(self, side, values):
        values = [max(0.0, min(1.0, float(v))) for v in (values or [])][:6]
        values += [0.0] * (6 - len(values))
        self._state[side] = values
        return True

    def clear_error(self, side):
        return True

    def shutdown(self):
        pass


class FakeCameraManager:
    def __init__(self, logger=print):
        self.log = logger

    @property
    def available(self):
        return False

    def subscribe(self, camera_id, token, fps, callback):
        return False, 'dry-run 模式无相机'

    def unsubscribe(self, camera_id, token):
        pass

    def unsubscribe_token(self, token):
        pass

    def describe(self):
        return []

    def info(self, camera_id):
        return {'topic': None, 'transport': None}

    def shutdown(self):
        pass


# ============================================================
# WebSocket 桥接
# ============================================================

def get_local_ips():
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.') and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    if not ips:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.connect(('8.8.8.8', 80))
            ips.append(sock.getsockname()[0])
            sock.close()
        except Exception:
            ips.append('127.0.0.1')
    return ips


def joint_descriptors():
    descriptors = []
    for group, rows in JOINT_TABLE.items():
        for sdk_id, sdk_name, urdf_name, lower, upper in rows:
            descriptors.append({
                'name': urdf_name,
                'type': 'revolute',
                'lower': lower,
                'upper': upper,
                'group': group,
                'sdkId': sdk_id,
                'sdkName': sdk_name,
                'controllable': group in CONTROLLABLE_GROUPS,
            })
    return descriptors


class DexBridge:
    def __init__(self, args):
        self.args = args
        self.model = args.model
        self.profile = load_profile(self.model)
        self.name = args.name or self.profile['displayName']
        self.device_id = f'{self.model}-{os.getpid():x}'
        self.started_at = time.time()
        self.clients = {}  # ws -> channel（control/status/camera）
        self.loop = None
        self.ros_node = None
        self.ros_thread = None
        self.executor = None
        self._camera_pending = {}   # ws -> 上一帧是否仍在发送（帧推送背压）
        self._camera_dropped = {}   # ws -> 因背压丢弃的帧数（诊断用）

        self.log = print
        self.robot = None
        self.hands = None
        self.cameras = None

        self._setup_backends()

    @staticmethod
    def _local_ipv4_addresses():
        """枚举本机网卡的 IPv4 地址（不引入第三方依赖）。"""
        import fcntl
        import struct

        addrs = []
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            for _, name in socket.if_nameindex():
                try:
                    packed = fcntl.ioctl(
                        sock.fileno(), 0x8915,  # SIOCGIFADDR
                        struct.pack('256s', name.encode('utf-8')[:15]))
                except OSError:
                    continue
                addrs.append(socket.inet_ntoa(packed[20:24]))
        finally:
            sock.close()
        return addrs

    def _wait_for_ipv4(self, timeout_s=120.0, interval_s=0.5):
        """等本机有非环回 IPv4 后再初始化 DDS。

        Fast DDS 只在构造 UDPv4 transport 时枚举一次网卡：若此刻网卡尚未配好
        IP（开机自启动常见，本服务可能早于 NetworkManager 抢到 IP），所有候选
        接口会被 netmask 规则过滤掉，日志打印
        ``[TRANSPORT_UDPV4 Error] All whitelist interfaces were filtered out``，
        并且**不会重试**。结果是该进程的节点不在 ROS 图里、相机帧和关节状态
        全部静默，而 WebSocket 侧一切正常，很难被发现。这里在 rclpy.init 之前
        显式等待，把竞态挡在 DDS 初始化之前。
        """
        deadline = time.monotonic() + timeout_s
        started = time.monotonic()
        while True:
            try:
                addrs = [a for a in self._local_ipv4_addresses() if not a.startswith('127.')]
            except Exception as exc:
                self.log(f'[bridge] 网卡枚举失败，跳过网络等待：{exc}')
                return True
            if addrs:
                waited = time.monotonic() - started
                if waited >= 1.0:
                    self.log(f'[bridge] 网络就绪（等待 {waited:.1f}s）：{", ".join(addrs)}')
                return True
            if time.monotonic() >= deadline:
                self.log(f'[bridge] 警告：{timeout_s:.0f}s 内未检测到可用 IPv4 网卡，'
                         'DDS 可能无法建立传输（检查网卡 / 共享内存）')
                return False
            time.sleep(interval_s)

    def _setup_backends(self):
        if self.args.dry_run:
            self.log('[bridge] dry-run 模式：不连接 ROS，仅验证协议')
            self.robot = FakeDexRobot(self.args.rate, self.args.max_speed,
                                      self.args.release_after_s, self.log)
            self.hands = FakeHands(self.log)
            self.cameras = FakeCameraManager(self.log)
            return

        import rclpy
        # 机型后端由 models/<model>/backend.py 提供，协议层保持机型无关。
        import backend as model_backend

        # 必须先等网络：rclpy.init 会立刻建 DDS 参与者，网卡没 IP 时传输永久残缺。
        self._wait_for_ipv4()

        rclpy.init(args=None)
        self.ros_node = rclpy.create_node('robot_motion_dex_bridge')
        self.robot, self.hands, self.cameras = model_backend.create_backends(
            self.ros_node, self.args, self.log)

        # 相机回调在独立的可重入回调组里（见 dex_camera），这里必须用多线程执行器：
        # 单线程时一帧 11~35ms 的解码会直接顶掉 50Hz 的 /arm/cmd 定时器。
        from rclpy.executors import MultiThreadedExecutor
        self.executor = MultiThreadedExecutor(num_threads=3)
        self.executor.add_node(self.ros_node)

        def spin():
            try:
                self.executor.spin()
            except Exception as exc:
                # 走到这里是"服务假死"：WS 还连着，但所有 ROS 回调（遥测/关节/相机）都停了
                self.log(f'[ros] 严重：ROS 执行器退出，关节/相机回调已停止（需重启服务）：{exc}')

        self.ros_thread = threading.Thread(target=spin, daemon=True)
        self.ros_thread.start()

        def dds_selfcheck():
            # DDS 传输残缺时进程照常运行、WS 照常应答，只是 ROS 图里什么都看不到，
            # 表现为网页相机黑屏且关节状态全空。留一条可检索的日志避免静默失联。
            time.sleep(8.0)
            try:
                topics = self.ros_node.get_topic_names_and_types()
                nodes = self.ros_node.get_node_names()
                pubs = self.ros_node.count_publishers('/ob_camera_head/color/image_raw')
            except Exception as exc:
                self.log(f'[ros] DDS 自检异常：{exc}')
                return
            if not topics and len(nodes) <= 1:
                self.log('[ros] 警告：ROS 图为空，DDS 传输可能未建立'
                         '（检查网卡就绪 / "All whitelist interfaces were filtered out"）')
            else:
                self.log(f'[ros] DDS 自检：话题 {len(topics)} 个，节点 {len(nodes)} 个，'
                         f'头部相机发布端 {pubs} 个')

        threading.Thread(target=dds_selfcheck, daemon=True).start()

    # ---------- 消息载荷 ----------

    def welcome_payload(self, channel=CHANNEL_CONTROL):
        hands = self.hands.describe() if self.hands else {'vendor': 'none', 'sides': {}}
        cameras = self.cameras.describe() if (self.cameras and self.cameras.available) else []

        # 手部关节不参与关节目标协议，但需出现在 joints 列表里，
        # 以免网页端把模型中的手指关节误判为"真机上不存在"。
        joints = joint_descriptors()
        for side_info in (hands.get('sides') or {}).values():
            for name in side_info.get('jointMap') or []:
                joints.append({
                    'name': name,
                    'type': 'revolute',
                    'lower': -1.5,
                    'upper': 1.5,
                    'group': 'hand',
                    'controllable': False,
                })

        return {
            'type': 'welcome',
            'protocol': PROTOCOL_VERSION,
            'id': self.device_id,
            'name': self.name,
            'model': self.model,
            'vendor': self.profile['vendor'],
            'displayName': self.profile['displayName'],
            'adapter': self.profile['backend'],
            'capabilities': dict(self.profile['capabilities']),
            'channel': channel,
            'wsPort': self.args.ws_port,
            'statusPort': self.args.status_port,
            'cameraPort': self.args.camera_port,
            'beaconPort': self.args.beacon_port,
            'joints': joints,
            'controllableGroups': list(CONTROLLABLE_GROUPS),
            'legLocked': True,
            'releaseAfterS': self.args.release_after_s,
            'hands': hands,
            'cameras': cameras,
            'uptimeMs': int((time.time() - self.started_at) * 1000),
        }

    def status_payload(self):
        states = self.robot.get_joint_states() if self.robot else {}
        hands = self.hands.get_state() if self.hands else None
        payload = {
            'type': 'status',
            'id': self.device_id,
            'name': self.name,
            'state': 'estop' if self.robot and self.robot.estop else (
                'executing' if self.robot and self.robot.mode == 'execute' else
                ('ready' if self.robot and self.robot.enabled else 'idle')),
            'mode': self.robot.mode if self.robot else 'idle',
            'enabled': bool(self.robot.enabled) if self.robot else False,
            'estop': bool(self.robot.estop) if self.robot else False,
            'jointStates': states,
            'trajectory': self.robot.trajectory_progress() if self.robot else None,
            't': int(time.time() * 1000),
        }
        if hands is not None:
            payload['hands'] = hands
        if self.args.trace and self.robot is not None:
            payload['targets'] = self.robot.snapshot_targets()
        return payload

    # ---------- WS ----------

    async def send(self, ws, payload):
        try:
            await ws.send(json.dumps(payload, ensure_ascii=False))
        except Exception as exc:
            self.clients.pop(ws, None)
            # 静默吞掉发送异常会表现成"服务端在收帧、网页端收不到"，必须留痕
            self.log(f'[ws] 发送失败：{type(exc).__name__}: {exc}')

    async def broadcast(self, payload, skip=None, channels=(CHANNEL_CONTROL,)):
        targets = [
            ws for ws, channel in list(self.clients.items())
            if ws is not skip and channel in channels
        ]
        if not targets:
            return
        data = json.dumps(payload, ensure_ascii=False)
        for ws in targets:
            try:
                await ws.send(data)
            except Exception:
                self.clients.pop(ws, None)

    def handler_for(self, channel):
        """为指定通道生成 websockets 处理函数。"""
        async def handler(ws, *args):
            await self.handler(ws, channel)
        return handler

    async def handler(self, ws, channel=CHANNEL_CONTROL):
        self.clients[ws] = channel
        peer = getattr(ws, 'remote_address', None)
        self.log(f'[ws] {channel} 通道客户端连接 {peer}（当前 {len(self.clients)}）')
        token = id(ws)
        await self.send(ws, self.welcome_payload(channel))
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                kind = msg.get('type')
                allowed = None
                if channel == CHANNEL_STATUS:
                    allowed = STATUS_CHANNEL_TYPES
                elif channel == CHANNEL_CAMERA:
                    allowed = CAMERA_CHANNEL_TYPES
                if allowed is not None and kind not in allowed:
                    await self.send(ws, {
                        'type': 'error',
                        'code': 'readonly',
                        'message': f'{channel} 通道只读，拒绝消息 {kind}',
                    })
                    continue
                try:
                    await self.handle(ws, token, msg)
                except Exception as exc:
                    self.log(f'[ws] 处理 {msg.get("type")} 失败：{exc}')
                    await self.send(ws, {'type': 'error', 'code': 'handler', 'message': str(exc)})
        except Exception:
            pass
        finally:
            self.clients.pop(ws, None)
            if self.cameras:
                self.cameras.unsubscribe_token(token)
            if channel == CHANNEL_CONTROL:
                self._release_when_no_control_client()
            self._camera_pending.pop(ws, None)
            self._camera_dropped.pop(ws, None)
            self.log(f'[ws] 客户端断开（当前 {len(self.clients)}）')

    def _release_when_no_control_client(self):
        """最后一个控制通道客户端断开时自动失能。

        否则使能状态和最后一组目标会留在进程里：_tick 仍以 50Hz 重发同样的
        位置目标，网页关掉以后双臂依旧被顶住（改不了手、别的程序也抢不到），
        只有重启桥接或按急停才松。状态/相机通道是只读的，不计入。
        """
        if any(ch == CHANNEL_CONTROL for ch in list(self.clients.values())):
            return
        if self.robot is None or not self.robot.enabled:
            return
        self.robot.disable()
        self.log('[bridge] 控制通道已无客户端，自动失能（停止关节保持流）')

    def _push_camera_frame(self, ws, payload):
        """从 ROS 回调线程把帧投递到 asyncio 事件循环。

        run_coroutine_threadsafe 返回的 future 若没人取异常就会被静默丢弃，
        表现为"相机在收帧但网页端一帧也收不到"，因此这里必须留痕。

        背压：同一连接上一帧还没发完就直接丢弃本帧。预览只关心最新画面，
        而弱网/浏览器卡顿时若每帧都排一个 task，队列会无限增长（内存与事件循环双爆）。
        """
        if not self.loop or self.loop.is_closed():
            return
        if self._camera_pending.get(ws):
            self._camera_dropped[ws] = self._camera_dropped.get(ws, 0) + 1
            return
        self._camera_pending[ws] = True
        future = asyncio.run_coroutine_threadsafe(self.send(ws, payload), self.loop)

        def _report(done):
            error = None
            try:
                error = done.exception()
            except Exception:
                error = None
            # 连接已断开时不再保留状态，避免表无限增长
            if ws in self.clients:
                self._camera_pending[ws] = False
            else:
                self._camera_pending.pop(ws, None)
            if error is not None:
                self.log(f'[camera] 帧推送失败：{type(error).__name__}: {error}')

        future.add_done_callback(_report)

    async def handle(self, ws, token, msg):
        kind = msg.get('type')

        if kind in ('hello', 'get_status'):
            await self.send(ws, self.welcome_payload() if kind == 'hello' else self.status_payload())
            return

        if kind == 'set_mode':
            ok, reason = self.robot.set_mode(msg.get('mode'))
            if not ok:
                await self.send(ws, {'type': 'error', 'code': 'bad_mode', 'message': reason})
            else:
                await self.broadcast({'type': 'ack', 'for': 'set_mode', 'accepted': True,
                                      'mode': msg.get('mode')})
            return

        if kind == 'enable':
            ok, reason = self.robot.enable()
            await self.broadcast({'type': 'ack', 'for': 'enable', 'accepted': ok, 'reason': reason or None})
            return

        if kind == 'disable':
            self.robot.disable()
            await self.broadcast({'type': 'ack', 'for': 'disable', 'accepted': True})
            return

        if kind == 'joint_targets':
            if self.robot is not None and self.robot.mode != 'follow':
                await self.send(ws, {'type': 'error', 'code': 'wrong_mode',
                                     'message': '请先切换到 follow 模式'})
                return
            result = self.robot.set_joint_targets(msg.get('targets') or {})
            await self.send(ws, {'type': 'ack', 'for': 'joint_targets', **result})
            return

        if kind == 'play_trajectory':
            result = self.robot.start_trajectory(
                msg.get('trajectoryId') or f'traj-{int(time.time() * 1000)}',
                msg.get('frames') or [],
                msg.get('fps') or 30,
                bool(msg.get('loop')),
            )
            await self.send(ws, {'type': 'ack', 'for': 'play_trajectory',
                                  'trajectoryId': msg.get('trajectoryId'), **result})
            return

        if kind == 'stop':
            self.robot.stop()
            await self.broadcast({'type': 'ack', 'for': 'stop', 'accepted': True})
            return

        if kind == 'estop':
            self.robot.emergency_stop()
            await self.broadcast({'type': 'ack', 'for': 'estop', 'accepted': True})
            return

        if kind == 'hand_targets':
            side = msg.get('side')
            ok = bool(self.hands and side in ('left', 'right') and
                      self.hands.set_normalized(side, msg.get('values') or []))
            await self.send(ws, {'type': 'ack', 'for': 'hand_targets', 'side': side,
                                 'accepted': ok, 'reason': None if ok else '手部不可用'})
            return

        if kind == 'hand_clear_error':
            side = msg.get('side')
            ok = bool(self.hands and self.hands.clear_error(side))
            await self.send(ws, {'type': 'ack', 'for': 'hand_clear_error', 'side': side, 'accepted': ok})
            return

        if kind == 'camera_list':
            await self.send(ws, {'type': 'cameras', 'cameras': self.welcome_payload()['cameras']})
            return

        if kind == 'camera_subscribe':
            camera = msg.get('camera')
            fps = msg.get('fps') or 10

            def on_frame(data, width, height, stamp, size):
                payload = {
                    'type': 'camera_frame', 'camera': camera, 'format': 'jpeg',
                    'width': width, 'height': height, 'stamp': stamp,
                    'bytes': size, 'data': data,
                }
                self._push_camera_frame(ws, payload)

            ok, reason = self.cameras.subscribe(camera, token, fps, on_frame)
            await self.send(ws, {'type': 'ack', 'for': 'camera_subscribe',
                                 'camera': camera, 'accepted': ok, 'reason': reason or None,
                                 **self.cameras.info(camera)})
            return

        if kind == 'camera_unsubscribe':
            camera = msg.get('camera')
            self.cameras.unsubscribe(camera, token)
            await self.send(ws, {'type': 'ack', 'for': 'camera_unsubscribe',
                                 'camera': camera, 'accepted': True})
            return

        await self.send(ws, {'type': 'error', 'code': 'unknown_type',
                             'message': f'未知消息类型 {kind}'})

    async def telemetry_loop(self):
        interval = 1.0 / max(1.0, self.args.telemetry_hz)
        while True:
            await asyncio.sleep(interval)
            if not self.clients:
                continue
            await self.broadcast(self.status_payload(), channels=BROADCAST_STATUS)
            for event in self.robot.drain_events() if self.robot else []:
                await self.broadcast({'type': 'robot_event', **event, 't': int(time.time() * 1000)},
                                     channels=BROADCAST_STATUS)
            done = self.robot.take_trajectory_done() if self.robot else None
            if done:
                await self.broadcast({'type': 'trajectory_done', 'trajectoryId': done},
                                     channels=BROADCAST_STATUS)

    # ---------- UDP 发现 ----------

    def beacon_payload(self):
        return json.dumps({
            'type': 'robot-beacon',
            'protocol': PROTOCOL_VERSION,
            'id': self.device_id,
            'name': self.name,
            'model': self.model,
            'displayName': self.profile['displayName'],
            'vendor': self.profile['vendor'],
            'ips': get_local_ips(),
            'wsPort': self.args.ws_port,
            'statusPort': self.args.status_port,
            'cameraPort': self.args.camera_port,
            'beaconPort': self.args.beacon_port,
            'state': 'ready' if self.robot and self.robot.enabled else 'idle',
            'hands': self.hands.vendor if self.hands else 'none',
            't': int(time.time() * 1000),
        })

    def start_udp(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(('', self.args.beacon_port))

        def receive():
            while True:
                try:
                    data, addr = sock.recvfrom(4096)
                    msg = json.loads(data.decode('utf-8', 'ignore'))
                    if msg.get('type') == 'discover':
                        sock.sendto(self.beacon_payload().encode('utf-8'), addr)
                except Exception:
                    continue

        threading.Thread(target=receive, daemon=True).start()

        def broadcast():
            while True:
                payload = self.beacon_payload().encode('utf-8')
                for ip in get_local_ips():
                    subnet = '.'.join(ip.split('.')[:3]) + '.255'
                    try:
                        sock.sendto(payload, (subnet, self.args.beacon_port))
                    except Exception:
                        pass
                time.sleep(2.0)

        threading.Thread(target=broadcast, daemon=True).start()
        self.log(f'[udp] 发现服务监听 :{self.args.beacon_port}')

    # ---------- 运行 ----------

    async def run(self):
        import websockets
        from contextlib import AsyncExitStack

        self.loop = asyncio.get_running_loop()
        self.start_udp()
        asyncio.create_task(self.telemetry_loop())

        servers = (
            (self.args.ws_port, CHANNEL_CONTROL, '控制'),
            (self.args.status_port, CHANNEL_STATUS, '状态'),
            (self.args.camera_port, CHANNEL_CAMERA, '相机'),
        )
        used_ports = set()
        ips = get_local_ips()
        host_ip = ips[0] if ips else '127.0.0.1'

        async with AsyncExitStack() as stack:
            for port, channel, label in servers:
                if not port:
                    self.log(f'[bridge] {label}通道已禁用（端口 0）')
                    continue
                if port in used_ports:
                    self.log(f'[bridge] {label}通道端口 {port} 与其他通道冲突，已跳过')
                    continue
                used_ports.add(port)
                await stack.enter_async_context(
                    websockets.serve(self.handler_for(channel), self.args.host, port,
                                     max_size=8 * 1024 * 1024))
                self.log(f'[bridge] {label}通道 ws://{host_ip}:{port}')
            self.log(f'[bridge] 机型 {self.model} | 手 {self.hands.vendor} | '
                     f'相机 {"可用" if self.cameras.available else "不可用"}')
            await asyncio.Future()


def main():
    args = parse_args()
    bridge = DexBridge(args)

    # rclpy.init() 会注册自己的 SIGTERM 处理器，但主线程此时阻塞在 asyncio
    # Future 上，收到信号也不会退出，进程会忽略 kill。这里在桥接初始化之后
    # 覆盖为抛出 KeyboardInterrupt，确保部署器的 stop/restart 能正常生效。
    def _on_terminate(signum, frame):
        # rclpy.shutdown() 偶发卡住会让进程变成"僵尸发布者"（端口已释放、
        # 定时器仍在以旧参数发 /arm/cmd），3s 后强制退出兜底。
        threading.Timer(3.0, lambda: os._exit(0)).start()
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGTERM, _on_terminate)
    except Exception:
        pass

    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        print('\n[bridge] 退出')
    finally:
        if bridge.cameras:
            bridge.cameras.shutdown()
        if bridge.hands:
            bridge.hands.shutdown()
        if bridge.executor is not None:
            try:
                bridge.executor.shutdown()
            except Exception:
                pass
        if bridge.ros_node is not None:
            try:
                bridge.ros_node.destroy_node()
                import rclpy
                rclpy.shutdown()
            except Exception:
                pass


if __name__ == '__main__':
    main()
