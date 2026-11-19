#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Walker 家族 6 通道压缩手（/mc/{side}_hand/command JointCommand）。

协议类型 walker-6-mcp。复用 BaseHands 接口形状。
⚠️ 真机待核对：JointCommand 的 position 模式数值（推测 5）与通道顺序。
"""

from __future__ import annotations

import threading

CHANNELS = 6
MODE_POSITION = 5


class WalkerHands:
    vendor = 'walker'
    hand_type = 'walker-6-mcp'

    def __init__(self, node, joint_map, logger=print):
        self.node = node
        self.jm = joint_map
        self.log = logger
        self._lock = threading.Lock()
        self._state = {'left': [0.0] * CHANNELS, 'right': [0.0] * CHANNELS}
        self._pubs = {}
        self._setup_io()

    def _setup_io(self):
        try:
            from mc_task_msgs.msg import JointCommand
        except Exception as exc:
            raise RuntimeError(f'Walker 手部消息不可导入（{exc}）')
        for side in ('left', 'right'):
            topic = f'/mc/{side}_hand/command'
            self._pubs[side] = self.node.create_publisher(JointCommand, topic, 10)
        self.log('[walker-hands] 6 通道手已就绪')

    def describe(self):
        return {
            'vendor': self.vendor,
            'type': self.hand_type,
            'sides': {
                side: {
                    'count': CHANNELS,
                    'names': [],
                    'jointMap': self.jm.hands_joint_map(self.vendor, side),
                }
                for side in ('left', 'right')
            },
        }

    def get_state(self):
        with self._lock:
            return {
                side: {'vendor': self.vendor, 'values': list(vals), 'names': []}
                for side, vals in self._state.items()
            }

    def set_normalized(self, side, values):
        if side not in self._pubs:
            return False
        vals = [max(0.0, min(1.0, float(v))) for v in (values or [])][:CHANNELS]
        vals += [0.0] * (CHANNELS - len(vals))
        from mc_task_msgs.msg import JointCommand
        msg = JointCommand()
        msg.mode = MODE_POSITION
        msg.position = vals
        self._pubs[side].publish(msg)
        with self._lock:
            self._state[side] = vals
        return True

    def clear_error(self, side):
        return False

    def shutdown(self):
        self._pubs.clear()
