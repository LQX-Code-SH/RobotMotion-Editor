#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""天工 DEX 灵巧手控制：BrainCo（6 电机）与 Inspire（13 关节）。

BrainCo:
  命令 /{side}_hand/set_motor_multi（brainco_hand_msgs/SetMotorMulti）
        mode=1，positions[6] 1..1000（1=完全伸直，1000=完全弯曲），speeds/currents/pwms/durations
  反馈 /{side}_hand/motor_status（MotorStatus.positions）
  电机索引：0 拇指弯曲 / 1 拇指旋转 / 2 食指 / 3 中指 / 4 无名指 / 5 小指

Inspire:
  命令 /{side}_hand/angle_set（inspire_hand_msgs/SetAngle）
        hand_id（1=左 2=右），joint_values[13] 为 0.1° 角码（不是 0..1000）
  反馈 /{side}_hand/angle_actual（GetAngleAct.joint_values + joint_names[13]）
  清错 /inspire_hand/set_clear_error/{side}_hand（bodyctrl_msgs/SetClearError）

因时 13 通道每个通道有独立的码上下限/零位/方向（见 INSPIRE_CHANNELS），
不能按统一 0..1000 线性换算；本文件按 Thinker-IL-LAB 的通道表逐通道映射。

对外统一使用归一化 0..1（屈曲通道 0=伸直、1=闭合；侧摆通道 0=下限、1=上限），
桥接层负责单位换算；手型由 --hand 或自动探测决定。
"""

from __future__ import annotations

import importlib
import threading

from joint_map import hands_joint_map

BRAINCO_MOTORS = 6
INSPIRE_JOINTS = 13
BRAINCO_INDEX = ['thumb_flex', 'thumb_rotate', 'index', 'middle', 'ring', 'pinky']

# 因时 RH56 系列 13 通道：(通道名, 码下限, 码上限, 0 rad 对应码, 方向)。
# 码值单位 0.1°，与 inspire_hand_msgs/SetAngle、GetAngleAct 一致。
# 屈曲通道码值越大越伸直（方向 -1）；侧摆通道零位 0、方向 +1。
# 口径来源：Thinker-IL-LAB ubt_IL/tienkung_dex（真机实采）。
INSPIRE_CHANNELS = (
    ('pinky_mcp', 900, 1650, 1650, -1),    # 0  小拇指指根
    ('ring_mcp', 900, 1650, 1650, -1),     # 1  无名指指根
    ('middle_mcp', 900, 1650, 1650, -1),   # 2  中指指根
    ('middle_yaw', -150, 150, 0, +1),      # 3  中指侧摆
    ('index_mcp', 900, 1650, 1650, -1),    # 4  食指指根
    ('index_yaw', -150, 150, 0, +1),       # 5  食指侧摆
    ('pinky_pip', 1150, 1900, 1900, -1),   # 6  小拇指指中
    ('ring_pip', 1150, 1900, 1900, -1),    # 7  无名指指中
    ('middle_pip', 1150, 1900, 1900, -1),  # 8  中指指中
    ('index_pip', 1150, 1900, 1900, -1),   # 9  食指指中
    ('thumb_yaw', 650, 1750, 1750, -1),    # 10 大拇指侧摆
    ('thumb_mcp', 1250, 1600, 1600, -1),   # 11 大拇指一关节弯曲
    ('thumb_pip', 1500, 2040, 2040, -1),   # 12 大拇指二关节弯曲
)


def _to_list(value):
    """安全地把 ROS 序列字段转成 list。

    驱动进程若用 numpy 构造消息，rclpy 交付的 sequence 字段可能是
    numpy.ndarray；此时 `value or []` 会抛 "truth value of an array is
    ambiguous" 的 ValueError，回调被 except 吞掉后状态就永远停在初值。
    """
    if value is None:
        return []
    try:
        return list(value)
    except TypeError:
        return []


def _try_import(package):
    try:
        return importlib.import_module(f'{package}.msg')
    except Exception:
        return None


def _status_qos(depth=10):
    """手部状态订阅统一用 BEST_EFFORT。

    QoS 兼容性是单向的：BEST_EFFORT 订阅能收 RELIABLE 与 BEST_EFFORT 两种
    发布端，反之收不到。手部反馈是缓存语义，丢一帧无影响。
    """
    from rclpy.qos import (DurabilityPolicy, HistoryPolicy, QoSProfile,
                           ReliabilityPolicy)
    return QoSProfile(
        reliability=ReliabilityPolicy.BEST_EFFORT,
        durability=DurabilityPolicy.VOLATILE,
        history=HistoryPolicy.KEEP_LAST,
        depth=depth,
    )


def inspire_code_to_norm(channel, code):
    """因时通道码（0.1°）-> 归一化 0..1。

    屈曲通道 0=伸直（码上限）、1=闭合（码下限）；侧摆通道按行程线性映射。
    码值低于通道下限（驱动读失败时常见 -1）返回 None，由调用方保留上次值。
    """
    _, low, high, _zero, direction = INSPIRE_CHANNELS[int(channel)]
    try:
        value = float(code)
    except (TypeError, ValueError):
        return None
    if value < low:
        return None
    value = min(value, high)
    if direction < 0:
        return (high - value) / float(high - low)
    return (value - low) / float(high - low)


def inspire_norm_to_code(channel, value):
    """归一化 0..1 -> 因时通道码（0.1°），超出通道行程时夹到上下限。"""
    _, low, high, _zero, direction = INSPIRE_CHANNELS[int(channel)]
    try:
        ratio = max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        ratio = 0.0
    if direction < 0:
        return int(round(high - ratio * (high - low)))
    return int(round(low + ratio * (high - low)))


class BaseHands:
    vendor = 'none'

    def __init__(self, node, logger=print):
        self.node = node
        self.log = logger
        self._lock = threading.Lock()
        self._state = {'left': [0.0], 'right': [0.0]}
        self._names = {'left': [], 'right': []}
        self._matrix = {'left': [], 'right': []}
        self._pubs = {}
        self._subs = []

    # ---- 通用 ----
    def describe(self):
        return {
            'vendor': self.vendor,
            'sides': {
                side: {
                    'count': len(self._names.get(side) or []),
                    'names': self._names.get(side) or [],
                    'jointMap': self._matrix.get(side) or [],
                }
                for side in ('left', 'right')
            },
        }

    def get_state(self):
        with self._lock:
            return {
                side: {
                    'vendor': self.vendor,
                    'values': list(self._state.get(side) or []),
                    'names': list(self._names.get(side) or []),
                }
                for side in ('left', 'right')
            }

    def set_normalized(self, side, values):
        """values: 0..1 归一化电机/关节值，长度按手型补齐/截断。"""
        raise NotImplementedError

    def clear_error(self, side):
        return False

    def shutdown(self):
        self._pubs = {}
        self._subs = []


class BrainCoHands(BaseHands):
    vendor = 'brainco'

    def __init__(self, node, logger=print):
        super().__init__(node, logger)
        module = _try_import('brainco_hand_msgs')
        if module is None or not hasattr(module, 'SetMotorMulti'):
            raise RuntimeError('brainco_hand_msgs 不可导入，请 source ~/xos/setup.bash')
        self._cmd_cls = getattr(module, 'SetMotorMulti')
        self._status_cls = getattr(module, 'MotorStatus', None)

        for side in ('left', 'right'):
            self._pubs[side] = node.create_publisher(
                self._cmd_cls, f'/{side}_hand/set_motor_multi', 10)
            self._names[side] = list(BRAINCO_INDEX)
            self._matrix[side] = hands_joint_map('brainco', side)
            if self._status_cls is not None:
                self._subs.append(node.create_subscription(
                    self._status_cls, f'/{side}_hand/motor_status',
                    (lambda msg, s=side: self._on_status(s, msg)), _status_qos()))
        self.log('[hands] BrainCo 6 电机双手已就绪')
        self._wait_publishers()

    def _wait_publishers(self, timeout=3.0):
        """等待驱动侧订阅者（Fast-DDS discovery 约 1.7s），避免首帧丢失。"""
        import time
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if all(pub.get_subscription_count() > 0 for pub in self._pubs.values()):
                    return
            except Exception:
                pass
            time.sleep(0.1)
        self.log('[hands] 警告：hand 驱动订阅者未全部就绪，仍尝试下发')

    def _on_status(self, side, msg):
        try:
            positions = list(getattr(msg, 'positions', []) or [])[:BRAINCO_MOTORS]
        except Exception:
            return
        with self._lock:
            self._state[side] = [max(0.0, min(1.0, (float(p) - 1.0) / 999.0)) for p in positions]

    def set_normalized(self, side, values):
        if side not in self._pubs:
            return False
        padded = list(values or [])[:BRAINCO_MOTORS]
        padded += [0.0] * (BRAINCO_MOTORS - len(padded))
        msg = self._cmd_cls()
        msg.mode = 1
        for i in range(BRAINCO_MOTORS):
            ratio = max(0.0, min(1.0, float(padded[i])))
            msg.positions[i] = int(round(1 + ratio * 999))
            msg.speeds[i] = 0
            msg.currents[i] = 0
            msg.pwms[i] = 0
            msg.durations[i] = 0
        self._pubs[side].publish(msg)
        with self._lock:
            self._state[side] = [max(0.0, min(1.0, float(v))) for v in padded]
        return True


class InspireHands(BaseHands):
    vendor = 'inspire'

    def __init__(self, node, logger=print):
        super().__init__(node, logger)
        module = _try_import('inspire_hand_msgs')
        if module is None or not hasattr(module, 'SetAngle'):
            raise RuntimeError('inspire_hand_msgs 不可导入，请启动 inspire hand 驱动并 source 环境')
        self._cmd_cls = getattr(module, 'SetAngle')
        self._status_cls = getattr(module, 'GetAngleAct', None)

        for side in ('left', 'right'):
            self._pubs[side] = node.create_publisher(
                self._cmd_cls, f'/{side}_hand/angle_set', 10)
            self._names[side] = [f'joint_{i}' for i in range(INSPIRE_JOINTS)]
            self._matrix[side] = hands_joint_map('inspire', side)
            if self._status_cls is not None:
                self._subs.append(node.create_subscription(
                    self._status_cls, f'/{side}_hand/angle_actual',
                    (lambda msg, s=side: self._on_status(s, msg)), _status_qos()))
        self._clear_cli = {}
        self._setup_clear_error()
        self.log('[hands] Inspire 13 关节双手已就绪')

    def _setup_clear_error(self):
        try:
            srv_mod = importlib.import_module('bodyctrl_msgs.srv')
            srv_cls = getattr(srv_mod, 'SetClearError', None)
            if srv_cls is None:
                return
            for side in ('left', 'right'):
                self._clear_cli[side] = self.node.create_client(
                    srv_cls, f'/inspire_hand/set_clear_error/{side}_hand')
        except Exception:
            self._clear_cli = {}

    def _on_status(self, side, msg):
        values = _to_list(getattr(msg, 'joint_values', None))[:INSPIRE_JOINTS]
        names = _to_list(getattr(msg, 'joint_names', None))[:INSPIRE_JOINTS]
        if not values:
            return
        with self._lock:
            previous = self._state.get(side) or []
            normalized = []
            for index, code in enumerate(values):
                value = inspire_code_to_norm(index, code)
                if value is None:
                    # 驱动读失败时常见 -1，保留上次值，避免手指显示成完全闭合
                    value = previous[index] if index < len(previous) else 0.0
                normalized.append(max(0.0, min(1.0, value)))
            self._state[side] = normalized
            if names:
                self._names[side] = [str(n) for n in names]

    def set_normalized(self, side, values):
        if side not in self._pubs:
            return False
        padded = list(values or [])[:INSPIRE_JOINTS]
        padded += [0.0] * (INSPIRE_JOINTS - len(padded))
        msg = self._cmd_cls()
        msg.hand_id = 1 if side == 'left' else 2
        # 0..1 -> 每通道 0.1° 角码；0 = 伸直（码上限）、1 = 闭合（码下限）
        msg.joint_values = [inspire_norm_to_code(i, v) for i, v in enumerate(padded)]
        self._pubs[side].publish(msg)
        with self._lock:
            self._state[side] = [max(0.0, min(1.0, float(v))) for v in padded]
        return True

    def clear_error(self, side):
        client = self._clear_cli.get(side)
        if client is None:
            return False
        try:
            if not client.wait_for_service(timeout_sec=1.0):
                return False
            client.call_async(client.srv_type.Request())
            return True
        except Exception:
            return False


class NoHands(BaseHands):
    """未安装灵巧手或未启用时使用。"""

    vendor = 'none'

    def set_normalized(self, side, values):
        return False


def create_hands(node, vendor='auto', logger=print):
    """按 vendor 创建手部控制器；auto 时依次探测 brainco / inspire。"""
    if vendor == 'none':
        return NoHands(node, logger)
    if vendor == 'brainco':
        return BrainCoHands(node, logger)
    if vendor == 'inspire':
        return InspireHands(node, logger)
    # auto
    try:
        return BrainCoHands(node, logger)
    except Exception as exc:
        logger(f'[hands] BrainCo 不可用：{exc}')
    try:
        return InspireHands(node, logger)
    except Exception as exc:
        logger(f'[hands] Inspire 不可用：{exc}')
    logger('[hands] 未探测到灵巧手驱动，手部功能禁用')
    return NoHands(node, logger)
