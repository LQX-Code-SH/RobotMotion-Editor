#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TienKung Pro 关节控制（bodyctrl_msgs / CmdSetMotorPosition）。

接口与 DexRobot 对齐（供 dex_bridge.py 协议层直接调用）：
  enable / disable / set_mode / set_joint_targets / start_trajectory /
  stop / emergency_stop / get_joint_states / snapshot_targets /
  drain_events / take_trajectory_done / trajectory_progress

⚠️ 真机适配待核对项（离线无法验证）：
- ROS2 话题名：/arm/cmd_pos /head/cmd_pos /waist/cmd_pos /leg/cmd_pos
  状态 /arm/status /head/status /waist/status（消息 MotorStatusMsg）
- spd 单位是 rpm（Dex 是 rad/s），需按真机重新标定默认值
- 急停话题与控制模式（Pro 依赖话题控制模式，非独立急停话题）
"""

from __future__ import annotations

import threading
import time

from joint_map import (
    CONTROLLABLE_GROUPS,
    BY_GROUP_ID,
    BY_URDF,
    clamp,
)

DEFAULT_SPD = 0.2   # rpm（ubt_sim 默认值），真机需标定
DEFAULT_CUR = 5.0   # A


class ProRobot:
    """Pro 关节控制与状态缓存。轨迹/斜坡逻辑与 DexRobot 同构。"""

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
        self.log(f'[pro] 已订阅 {len(self._state_subs)} 路状态，'
                 f'发布 {len(self._pubs)} 路命令')

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

    # ---------- 对外接口（与 DexRobot 对齐）----------
    def enable(self):
        with self._lock:
            if self.estop:
                return False, '急停激活中'
            self.enabled = True
        return True, None

    def disable(self):
        with self._lock:
            self.enabled = False
            self._targets.clear()
            self._command.clear()
        return True

    def set_mode(self, mode):
        if mode not in ('idle', 'follow', 'execute'):
            return False, f'不支持的模式 {mode}'
        with self._lock:
            if self.mode == 'execute' and mode != 'execute':
                self._trajectory = None
            self.mode = mode
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
        return {'accepted': accepted}

    def start_trajectory(self, trajectory_id, frames, fps=30, loop=False):
        if not self.enabled:
            return {'accepted': False, 'reason': '未使能'}
        with self._lock:
            self._trajectory = {
                'id': trajectory_id, 'frames': frames or [], 'fps': fps,
                'loop': bool(loop), 'idx': 0, 'start': time.monotonic(),
            }
            self._traj_done = None
            self.mode = 'execute'
        return {'accepted': True}

    def stop(self):
        with self._lock:
            self._trajectory = None
            self.mode = 'idle'
        return True

    def emergency_stop(self):
        with self._lock:
            self.estop = True
            self.enabled = False
            self._trajectory = None
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
        self._pubs.clear()
        self._state_subs.clear()
