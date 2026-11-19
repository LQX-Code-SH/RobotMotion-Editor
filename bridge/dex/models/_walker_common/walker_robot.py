#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Walker 家族关节控制（mc_task_msgs / RobotCommand + JointCmd）。

按关节名寻址（control_mode=2 位置模式），非 ID 数值控制。
周期任务与 DexRobot/ProRobot 同构：按 --rate 持续发布目标、轨迹按控制周期
插值推进，结束/停止后按 release_after_s 自动失能。

⚠️ 真机待核对项：
- control_mode 数值（SDK 文档 MODE_POSITION=2）
- 末帧保持语义：C1 末帧只发一次由运控保持，S2 bridge 内部 300Hz 轨迹推进
- C1 必须 half_sdk 模式才接收 ROS 指令
"""

from __future__ import annotations

import math
import threading
import time

MODE_POSITION = 2


class WalkerRobot:
    """通用 Walker 关节控制与状态缓存，接口与 DexRobot 对齐。"""

    def __init__(self, node, joint_map, rate_hz=50.0, max_joint_speed=1.2,
                 release_after_s=5.0, logger=print, topic_cmd='/mc/sdk/robot_command',
                 topic_state='/mc/sdk/robot_state'):
        self.node = node
        self.jm = joint_map
        self.rate_hz = float(rate_hz)
        self.max_joint_speed = float(max_joint_speed)
        self.release_after_s = max(0.0, float(release_after_s or 0.0))
        self.log = logger
        self.topic_cmd = topic_cmd
        self.topic_state = topic_state

        self.enabled = False
        self.mode = 'idle'
        self.estop = False

        self._lock = threading.RLock()
        self._targets = {}
        self._command = {}
        self._state = {}
        self._last_state_at = 0.0
        self._trajectory = None
        self._traj_done = None
        self._events = []
        self._release_at = None
        self._pub = None
        self._sub = None
        self._timer = None

        self._setup_io()

    def _setup_io(self):
        try:
            from mc_task_msgs.msg import RobotCommand
            from mc_state_msgs.msg import RobotState
        except Exception as exc:
            raise RuntimeError(f'Walker 消息包不可导入（{exc}）')
        self._cmd_cls = RobotCommand
        self._pub = self.node.create_publisher(RobotCommand, self.topic_cmd, 10)
        self._sub = self.node.create_subscription(
            RobotState, self.topic_state, self._on_state, 10)
        period = 1.0 / self.rate_hz
        self._timer = self.node.create_timer(period, self._tick)
        self.log(f'[walker] 命令 {self.topic_cmd} / 状态 {self.topic_state}'
                 f'（{self.rate_hz:g}Hz）')

    def _on_state(self, msg):
        readings = {}
        for joint in (getattr(msg, 'joint_states', None) or []):
            name = getattr(joint, 'name', None)
            if name not in self.jm.BY_URDF:
                continue
            readings[name] = {
                'position': float(getattr(joint, 'position', 0.0)),
                'velocity': float(getattr(joint, 'velocity', 0.0)),
                'effort': float(getattr(joint, 'effort', 0.0)),
            }
        with self._lock:
            self._state.update(readings)
            self._last_state_at = time.monotonic()

    def _publish(self, targets):
        """下发一帧关节目标（JointCmd.name = URDF 关节名）。"""
        if self._pub is None or not targets:
            return
        from mc_task_msgs.msg import JointCmd
        msg = self._cmd_cls()
        for name, value in targets.items():
            entry = self.jm.BY_URDF.get(name)
            if not entry or entry['group'] not in self.jm.CONTROLLABLE_GROUPS:
                continue
            cmd = JointCmd()
            cmd.name = name
            cmd.control_mode = MODE_POSITION
            cmd.position = self.jm.clamp(name, float(value))
            msg.joint_cmd.append(cmd)
        self._pub.publish(msg)

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
                self.log('[walker] 静置超时，自动失能：停止关节保持流')
                return

            dt = 1.0 / self.rate_hz
            max_delta = self.max_joint_speed * dt
            ramped = {}
            for name, target in self._targets.items():
                entry = self.jm.BY_URDF.get(name)
                if entry is None or entry['group'] not in self.jm.CONTROLLABLE_GROUPS:
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
                ramped[name] = current
            self._publish(ramped)

    # ---------- 对外接口 ----------
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
                entry = self.jm.BY_URDF.get(name)
                if not entry or entry['group'] not in self.jm.CONTROLLABLE_GROUPS:
                    continue
                self._targets[name] = self.jm.clamp(name, float(value))
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
                entry = self.jm.BY_URDF.get(name)
                if entry is None or entry['group'] not in self.jm.CONTROLLABLE_GROUPS:
                    continue
                targets[name] = self.jm.clamp(name, float(value))
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
        self.log('[walker] 急停已触发')

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
        self._pub = None
        self._sub = None
