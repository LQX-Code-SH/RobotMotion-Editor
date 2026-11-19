#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TienKung Pro 关节控制（bodyctrl_msgs / CmdSetMotorPosition）。

接口与 DexRobot 对齐（供 dex_bridge.py 协议层直接调用）：
  enable / disable / set_mode / set_joint_targets / start_trajectory /
  stop / emergency_stop / get_joint_states / snapshot_targets /
  drain_events / take_trajectory_done / trajectory_progress

周期任务与 DexRobot 同构：SDK 要求 20~50Hz 持续发布位置目标；
轨迹按控制周期插值推进，结束/停止后按 release_after_s 自动失能。

⚠️ 真机适配待核对项（离线无法验证）：
- ROS2 话题名：/arm/cmd_pos /head/cmd_pos /waist/cmd_pos /leg/cmd_pos
  状态 /arm/status /head/status /waist/status（消息 MotorStatusMsg）
- CmdSetMotorPosition 字段按 name/pos/spd/cur 并行数组写入（spd 单位 rpm）
- 急停话题与控制模式（Pro 依赖话题控制模式，非独立急停话题）
"""

from __future__ import annotations

import math
import threading
import time

from .joint_map import (
    CONTROLLABLE_GROUPS,
    BY_GROUP_ID,
    BY_URDF,
    clamp,
)

DEFAULT_SPD = 0.2   # rpm（ubt_sim 默认值），真机需标定
DEFAULT_CUR = 5.0   # A


class ProRobot:
    """Pro 关节控制与状态缓存。轨迹/斜坡/发布逻辑与 DexRobot 同构。"""

    def __init__(self, node, rate_hz=50.0, max_joint_speed=1.2,
                 spd=DEFAULT_SPD, cur=DEFAULT_CUR, release_after_s=5.0, logger=print):
        self.node = node
        self.rate_hz = float(rate_hz)
        self.max_joint_speed = float(max_joint_speed)
        self.spd = float(spd)
        self.cur = float(cur)
        self.release_after_s = max(0.0, float(release_after_s or 0.0))
        self.log = logger

        self.enabled = False
        self.mode = 'idle'      # idle | follow | execute
        self.estop = False
        self.estop_reason = None

        self._lock = threading.RLock()
        self._targets = {}
        self._command = {}
        self._state = {}
        self._last_state_at = 0.0
        self._trajectory = None
        self._traj_done = None
        self._events = []
        self._release_at = None

        self._pubs = {}
        self._state_subs = []
        self._timer = None

        self._setup_messages()
        self._setup_io()

    # ---------- 初始化 ----------
    def _setup_messages(self):
        import importlib
        try:
            self._cmd_cls = importlib.import_module(
                'bodyctrl_msgs.msg').CmdSetMotorPosition
            self._status_cls = importlib.import_module(
                'bodyctrl_msgs.msg').MotorStatusMsg
        except Exception as exc:
            raise RuntimeError(
                'bodyctrl_msgs 不可导入，请 source Pro 的 ROS2 工作空间'
                f'（{exc}）')

    def _setup_io(self):
        for group in CONTROLLABLE_GROUPS:
            topic = f'/{group}/cmd_pos'
            self._pubs[group] = self.node.create_publisher(
                self._cmd_cls, topic, 10)
            status_topic = f'/{group}/status'
            self._state_subs.append(self.node.create_subscription(
                self._status_cls, status_topic,
                lambda msg, g=group: self._on_status(g, msg), 10))
        period = 1.0 / self.rate_hz
        self._timer = self.node.create_timer(period, self._tick)
        self.log(f'[pro] 已订阅 {len(self._state_subs)} 路状态，'
                 f'发布 {len(self._pubs)} 路命令（{self.rate_hz:g}Hz）')

    def _on_status(self, group, msg):
        # MotorStatusMsg 字段待真机确认（推测 status[] / name / pos / spd）
        readings = {}
        for item in (getattr(msg, 'status', None) or []):
            sid = int(getattr(item, 'name', -1))
            entry = BY_GROUP_ID.get((group, sid))
            if not entry:
                continue
            readings[entry['urdf']] = {
                'position': float(getattr(item, 'pos', 0.0)),
                'velocity': float(getattr(item, 'spd', 0.0)),
                'effort': float(getattr(item, 'cur', 0.0)),
            }
        with self._lock:
            self._state.update(readings)
            self._last_state_at = time.monotonic()

    # ---------- 自动失能与轨迹 ----------
    def _schedule_release(self):
        self._release_at = (time.monotonic() + self.release_after_s
                            if self.release_after_s > 0 else None)

    def _release_if_due(self):
        if self._release_at is None or time.monotonic() < self._release_at:
            return False
        self._release_at = None
        self.enabled = False
        self._trajectory = None
        self._targets = {}
        self._command = {}
        self.mode = 'idle'
        return True

    def _advance_trajectory(self):
        traj = self._trajectory
        if traj is None:
            return
        frames = traj['frames']
        if not frames:
            self._trajectory = None
            return

        elapsed = (time.monotonic() - traj['start']) * 1000.0
        if elapsed >= frames[-1]['t']:
            if traj['loop']:
                traj['start'] = time.monotonic()
                traj['idx'] = 0
                self._targets.update(frames[0]['targets'])
                return
            self._targets.update(frames[-1]['targets'])
            traj['idx'] = len(frames)
            self._traj_done = traj['id']
            self._trajectory = None
            self.mode = 'idle'
            self._schedule_release()
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

    # ---------- 周期控制 ----------
    def _tick(self):
        if self.estop:
            return
        with self._lock:
            self._advance_trajectory()
            if not self.enabled:
                return
            if self._release_if_due():
                self._events.append({
                    'level': 'system',
                    'message': f'轨迹结束静置 {self.release_after_s:g}s，已自动失能',
                })
                self.log('[pro] 静置超时，自动失能：停止关节保持流')
                return

            groups = {}
            dt = 1.0 / self.rate_hz
            max_delta = self.max_joint_speed * dt
            for name, target in self._targets.items():
                entry = BY_URDF.get(name)
                if entry is None or entry['group'] not in CONTROLLABLE_GROUPS:
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
        if pub is None or not items:
            return
        msg = self._cmd_cls()
        msg.name = [sdk_id for sdk_id, _ in items]
        msg.pos = [float(pos) for _, pos in items]
        msg.spd = [float(self.spd)] * len(items)
        msg.cur = [float(self.cur)] * len(items)
        pub.publish(msg)

    # ---------- 对外接口（与 DexRobot 对齐）----------
    def enable(self):
        with self._lock:
            if self.estop:
                return False, '急停激活中'
            if not self.enabled:
                self._targets = {}
                self._command = {}
            self.enabled = True
            self._release_at = None
        return True, None

    def disable(self):
        with self._lock:
            self.enabled = False
            self._targets.clear()
            self._command.clear()
            self._trajectory = None
            self.mode = 'idle'
            self._release_at = None
        return True

    def set_mode(self, mode):
        if mode not in ('idle', 'follow', 'execute'):
            return False, f'不支持的模式 {mode}'
        with self._lock:
            if mode != 'execute':
                self._trajectory = None
            self.mode = mode
            self._release_at = None
        return True, None

    def set_joint_targets(self, targets):
        if not self.enabled:
            return {'accepted': 0, 'reason': '未使能'}
        accepted = 0
        with self._lock:
            for name, value in (targets or {}).items():
                if name not in BY_URDF:
                    continue
                # 仅可控组可下发；腿由运控独占
                if BY_URDF[name]['group'] not in CONTROLLABLE_GROUPS:
                    continue
                self._targets[name] = clamp(name, float(value))
                accepted += 1
            self._release_at = None
        self._tick()
        return {'accepted': accepted}

    def start_trajectory(self, trajectory_id, frames, fps=30, loop=False):
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
                targets[name] = clamp(name, float(value))
            if targets:
                normalized.append({'t': float(frame.get('t', 0.0)), 'targets': targets})
        if not normalized:
            return {'accepted': False, 'reason': '轨迹中没有可下发关节'}
        normalized.sort(key=lambda item: item['t'])

        with self._lock:
            self._trajectory = {
                'id': trajectory_id, 'frames': normalized, 'fps': fps,
                'loop': bool(loop), 'idx': 0, 'start': time.monotonic(),
            }
            self._traj_done = None
            self.mode = 'execute'
            self._release_at = None
        self._tick()
        return {'accepted': True}

    def stop(self):
        with self._lock:
            self._trajectory = None
            self.mode = 'idle'
            self._schedule_release()
        return True

    def emergency_stop(self):
        with self._lock:
            self.estop = True
            self.enabled = False
            self._trajectory = None
            self._release_at = None
        self.log('[pro] 急停已触发')

    def get_joint_states(self):
        with self._lock:
            return dict(self._state)

    def snapshot_targets(self):
        with self._lock:
            return dict(self._command)

    def state_age(self):
        with self._lock:
            return time.monotonic() - self._last_state_at if self._last_state_at else float('inf')

    def take_trajectory_done(self):
        with self._lock:
            done = self._traj_done
            self._traj_done = None
            return done

    def drain_events(self):
        with self._lock:
            events = list(self._events)
            self._events.clear()
            return events

    def trajectory_progress(self):
        traj = self._trajectory
        if not traj:
            return None
        return {'id': traj['id'], 'frameIndex': traj['idx'],
                'frameCount': len(traj['frames'])}

    def shutdown(self):
        self.disable()
        if self._timer is not None and hasattr(self._timer, 'cancel'):
            self._timer.cancel()
        self._timer = None
        self._pubs.clear()
        self._state_subs.clear()
