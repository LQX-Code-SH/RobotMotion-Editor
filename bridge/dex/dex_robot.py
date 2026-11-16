#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TienKung Dex 关节控制（ROS 2 话题 + ros2_bridge_msgs）。

控制通道（xhumanoid_sdk 实测）：
- 命令：/arm/cmd、/head/cmd、/waist/cmd，消息 ArmCtrl/HeadCtrl/WaistCtrl
  字段：header/mode/label/ctrl[]，ctrl[] 内 name=关节 ID，pos(rad)/spd/cur/kp/kd/tor。
  SDK 无内部定时器，必须由调用方以 20~50Hz 周期持续发布。
- 状态：/robot_state，RobotState.arm|head|waist|leg.status[]，status[].name 存关节 ID。
- 急停：/power/board/key_status（bodyctrl_msgs/PowerBoardKeyStatus，is_estop /
  is_remote_estop）。急停激活时拒绝任何下发。
- 腿部不可直控（行走运控独占），仅回读状态。

安全策略：
- 所有目标按 joint_map 限位裁剪；未映射关节直接拒绝。
- 目标值按最大角速度斜坡逼近（默认 1.2 rad/s，可配置），避免阶跃。
- 轨迹按控制周期插值；急停时冻结在当前读数。
"""

from __future__ import annotations

import math
import threading
import time

from joint_map import (
    ALL_GROUPS,
    CONTROLLABLE_GROUPS,
    BY_GROUP_ID,
    BY_URDF,
    clamp,
)

# 位置控制默认参数（沿用 SDK single_joint_control 示例）
DEFAULT_SPD = 0.3      # rad/s（驱动侧速度参数）
DEFAULT_CUR = 10.0     # A
WAIST_YAW_MIN_CUR = 40.0  # 腰部 yaw 负载大，SDK 实测 cur<40 到不了位

MODE_POSITION = 0
MODE_IMPEDANCE = 1


def _status_qos(depth=10):
    """状态订阅统一 BEST_EFFORT：兼容 RELIABLE / BEST_EFFORT 两种发布端。

    真机各节点 QoS 不由桥接决定；RELIABLE 订阅遇到 BEST_EFFORT 发布端会
    表现为"话题可见、echo 有数、桥接收不到"。状态是缓存语义，丢帧无影响。
    """
    from rclpy.qos import (DurabilityPolicy, HistoryPolicy, QoSProfile,
                           ReliabilityPolicy)
    return QoSProfile(
        reliability=ReliabilityPolicy.BEST_EFFORT,
        durability=DurabilityPolicy.VOLATILE,
        history=HistoryPolicy.KEEP_LAST,
        depth=depth,
    )


class DexRobot:
    """关节组控制与状态缓存。"""

    def __init__(self, node, rate_hz=50.0, max_joint_speed=1.2,
                 spd=DEFAULT_SPD, cur=DEFAULT_CUR, logger=print):
        self.node = node
        self.rate_hz = float(rate_hz)
        self.max_joint_speed = float(max_joint_speed)
        # 驱动侧参数：实测 spd 在位置模式下**生效**（0.3 rad/s 阶跃 0.3rad 用时 0.96s）
        self.spd = float(spd)
        self.cur = float(cur)
        self.log = logger

        self.enabled = False
        self.mode = 'idle'          # idle | follow | execute
        self.estop = False
        self.estop_reason = None

        self._lock = threading.RLock()
        self._targets = {}          # urdf name -> rad (期望值)
        self._command = {}          # urdf name -> rad (斜坡输出)
        self._state = {}            # urdf name -> {position, velocity, effort}
        self._last_state_at = 0.0
        self._suppressed = set()    # 不控制的关节

        self._trajectory = None     # {frames, fps, loop, start, id, idx}
        self._traj_done = None
        self._events = []

        self._pubs = {}
        self._msg_cls = {}
        self._state_sub = None
        self._estop_sub = None
        self._timer = None

        self._setup_messages()
        self._setup_io()

    # ---------- 初始化 ----------

    def _setup_messages(self):
        import importlib
        try:
            module = importlib.import_module('ros2_bridge_msgs.msg')
        except Exception as exc:  # pragma: no cover - 依赖真机环境
            raise RuntimeError(
                'ros2_bridge_msgs 不可导入，请在机器人端 source /opt/humanoid/install/setup.bash'
                f' 与 ~/xos/setup.bash（{exc}）')

        for group in CONTROLLABLE_GROUPS:
            cls = None
            for name in (f'{group.capitalize()}Ctrl', 'ArmCtrl'):
                if hasattr(module, name):
                    cls = getattr(module, name)
                    break
            if cls is None:
                raise RuntimeError(f'ros2_bridge_msgs.msg 缺少 {group} 控制消息类')
            self._msg_cls[group] = cls

        if not hasattr(module, 'RobotState'):
            raise RuntimeError('ros2_bridge_msgs.msg 缺少 RobotState')
        self._robot_state_cls = getattr(module, 'RobotState')

        if not hasattr(module, 'MotorCtrl'):
            raise RuntimeError('ros2_bridge_msgs.msg 缺少 MotorCtrl')
        self._motor_ctrl_cls = getattr(module, 'MotorCtrl')

    def _setup_io(self):
        for group in CONTROLLABLE_GROUPS:
            self._pubs[group] = self.node.create_publisher(
                self._msg_cls[group], f'/{group}/cmd', 10)
        self._state_sub = self.node.create_subscription(
            self._robot_state_cls, '/robot_state', self._on_robot_state, _status_qos())
        self._setup_estop_sub()
        period = 1.0 / self.rate_hz
        self._timer = self.node.create_timer(period, self._tick)
        self.log(f'[dex] 关节控制已就绪：{self.rate_hz:.0f}Hz，可控制组 {CONTROLLABLE_GROUPS}，'
                 f'spd={self.spd:g} rad/s，cur={self.cur:g} A')

    def _setup_estop_sub(self):
        """急停状态订阅；消息类缺失时降级为无急停守卫并告警。"""
        import importlib
        try:
            module = importlib.import_module('bodyctrl_msgs.msg')
            cls = getattr(module, 'PowerBoardKeyStatus', None)
        except Exception:
            cls = None
        if cls is None:
            self.log('[dex] 警告：未找到 bodyctrl_msgs/PowerBoardKeyStatus，急停状态无法监测')
            return
        try:
            self._estop_sub = self.node.create_subscription(
                cls, '/power/board/key_status', self._on_key_status, _status_qos())
        except Exception as exc:
            self.log(f'[dex] 警告：急停话题订阅失败：{exc}')

    # ---------- 回调 ----------

    def _on_key_status(self, msg):
        try:
            is_estop = bool(getattr(msg, 'is_estop').data)
            is_remote = bool(getattr(msg, 'is_remote_estop').data)
        except Exception:
            return
        active = is_estop or is_remote
        if active and not self.estop:
            self.log('[dex] 急停激活，停止下发')
            self._events.append({'level': 'warning', 'message': '真机急停激活'})
        self.estop = active
        self.estop_reason = 'remote' if is_remote else ('onboard' if is_estop else None)

    def _on_robot_state(self, msg):
        readings = {}
        for group in ALL_GROUPS:
            container = getattr(msg, group, None)
            statuses = getattr(container, 'status', None) if container else None
            if not statuses:
                continue
            for item in statuses:
                try:
                    sdk_id = int(getattr(item, 'name'))
                except (TypeError, ValueError):
                    continue
                entry = BY_GROUP_ID.get((group, sdk_id))
                if entry is None:
                    continue
                readings[entry['urdf']] = {
                    'position': float(getattr(item, 'pos', 0.0) or 0.0),
                    'velocity': float(getattr(item, 'vel', 0.0) or 0.0),
                    'effort': float(getattr(item, 'tor', 0.0) or 0.0),
                }
        with self._lock:
            self._state = readings
            self._last_state_at = time.monotonic()

    # ---------- 周期控制 ----------

    def _tick(self):
        if self.estop:
            return
        with self._lock:
            self._advance_trajectory()
            if not self.enabled:
                return

            groups = {}
            dt = 1.0 / self.rate_hz
            max_delta = self.max_joint_speed * dt

            for name, target in self._targets.items():
                if name in self._suppressed:
                    continue
                entry = BY_URDF.get(name)
                if entry is None:
                    continue
                current = self._command.get(name)
                if current is None:
                    state = self._state.get(name)
                    current = state['position'] if state else target
                delta = target - current
                if abs(delta) <= max_delta:
                    current = target
                else:
                    current += math.copysign(max_delta, delta)
                self._command[name] = current
                groups.setdefault(entry['group'], []).append((entry['sdk_id'], current))

            for group, items in groups.items():
                self._publish_group(group, items)

    def _publish_group(self, group, items):
        pub = self._pubs.get(group)
        cls = self._msg_cls.get(group)
        if pub is None or cls is None:
            return
        msg = cls()
        msg.header.stamp = self.node.get_clock().now().to_msg()
        msg.header.frame_id = group
        msg.mode = MODE_POSITION
        msg.label = 0
        ctrls = []
        for sdk_id, pos in items:
            ctrl = self._motor_ctrl_cls()
            ctrl.name = sdk_id
            ctrl.pos = float(pos)
            ctrl.spd = self.spd
            ctrl.cur = (max(self.cur, WAIST_YAW_MIN_CUR)
                        if (group == 'waist' and sdk_id == 33) else self.cur)
            ctrl.kp = 0.0
            ctrl.kd = 0.0
            ctrl.tor = 0.0
            ctrls.append(ctrl)
        msg.ctrl = ctrls
        pub.publish(msg)

    # ---------- 轨迹 ----------

    def _advance_trajectory(self):
        traj = self._trajectory
        if traj is None:
            return
        elapsed = (time.monotonic() - traj['start']) * 1000.0
        frames = traj['frames']
        if elapsed >= frames[-1]['t']:
            if traj['loop']:
                # 回到首帧重新播放：必须同时重置 idx，否则会卡在末帧永远不动
                traj['start'] = time.monotonic()
                traj['idx'] = 0
                self._targets.update(frames[0]['targets'])
                return
            self._targets.update(frames[-1]['targets'])
            traj['idx'] = len(frames)
            self._traj_done = traj['id']
            self._trajectory = None
            self.mode = 'idle'
            return

        # 线性插值
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

    # ---------- 对外 API ----------

    def enable(self):
        if self.estop:
            return False, '急停激活中，无法使能'
        with self._lock:
            # 从当前读数初始化命令值，避免使能瞬间跳变
            self._command = {name: state['position'] for name, state in self._state.items()}
            self.enabled = True
        return True, ''

    def disable(self):
        with self._lock:
            self.enabled = False
            self._trajectory = None
            self.mode = 'idle'
        return True, ''

    def set_mode(self, mode):
        if mode not in ('idle', 'follow', 'execute'):
            return False, f'不支持的模式 {mode}'
        with self._lock:
            if mode != 'execute':
                self._trajectory = None
            self.mode = mode
        return True, ''

    def set_joint_targets(self, targets):
        """targets: {urdf_name: rad}；leg 与未映射关节拒绝。"""
        if self.estop:
            return {'accepted': False, 'reason': '急停激活中'}
        if not self.enabled:
            return {'accepted': False, 'reason': '未使能'}

        applied = {}
        rejected = {}
        for name, value in (targets or {}).items():
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
            reason = '没有可下发的关节' if not rejected else \
                f'全部关节被拒绝（示例：{next(iter(rejected.items()))}）'
            return {'accepted': False, 'reason': reason, 'rejected': rejected}

        with self._lock:
            self._targets.update(applied)
        result = {'accepted': True, 'applied': applied}
        if rejected:
            result['rejected'] = rejected
        return result

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
                'id': trajectory_id,
                'frames': normalized,
                'loop': bool(loop),
                'start': time.monotonic(),
                'idx': 0,
            }
            self.mode = 'execute'
        return {
            'accepted': True,
            'frameCount': len(normalized),
            'durationMs': normalized[-1]['t'],
        }

    def stop(self):
        with self._lock:
            self._trajectory = None
            # 冻结在最后命令值（相当于僵停保持）
            self._targets = dict(self._command)
            self.mode = 'idle'
        return True

    def emergency_stop(self):
        with self._lock:
            self.enabled = False
            self._trajectory = None
            self._targets = {name: state['position'] for name, state in self._state.items()}
            self._command = dict(self._targets)
            self.mode = 'idle'
            self.estop = True
            self.estop_reason = 'software'
        self._events.append({'level': 'warning', 'message': '软件急停：已停止下发'})
        return True

    def get_joint_states(self):
        with self._lock:
            return dict(self._state)

    def snapshot_targets(self):
        """当前原始目标（rad，未经过斜坡），调试跟踪误差用。"""
        with self._lock:
            return dict(self._targets)

    def state_age(self):
        with self._lock:
            return None if self._last_state_at == 0 else time.monotonic() - self._last_state_at

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
            return {
                'id': traj['id'],
                'frameIndex': traj['idx'],
                'frameCount': len(traj['frames']),
            }
