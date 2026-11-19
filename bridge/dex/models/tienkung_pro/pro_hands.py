#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TienKung Pro 6 通道 Inspire 手（JointState 归一化 0..1）。

复用 BaseHands 接口；协议类型 pro-6-norm。
⚠️ 真机待核对：/inspire_hand/ctrl/{left,right}_hand 的 JointState 字段名与顺序。
"""

from __future__ import annotations

import threading

from joint_map import hands_joint_map

CHANNELS = 6


class BaseHands:
    vendor = 'none'
    hand_type = 'none'

    def __init__(self, node, logger=print):
        self.node = node
        self.log = logger
        self._lock = threading.Lock()
        self._state = {'left': [0.0] * CHANNELS, 'right': [0.0] * CHANNELS}
        self._pubs = {}
        self._subs = []

    def describe(self):
        return {
            'vendor': self.vendor,
            'type': self.hand_type,
            'sides': {
                side: {
                    'count': CHANNELS,
                    'names': [],
                    'jointMap': hands_joint_map(self.vendor, side),
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

    def shutdown(self):
        self._pubs.clear()
        self._subs.clear()

    def set_normalized(self, side, values):
        return False

    def clear_error(self, side):
        return False


class ProHands(BaseHands):
    vendor = 'inspire'
    hand_type = 'pro-6-norm'

    def __init__(self, node, logger=print):
        super().__init__(node, logger)
        self._setup_io()

    def _setup_io(self):
        try:
            from sensor_msgs.msg import JointState
        except Exception as exc:
            raise RuntimeError(f'sensor_msgs 不可导入（{exc}）')
        for side in ('left', 'right'):
            topic = f'/inspire_hand/ctrl/{side}_hand'
            self._pubs[side] = self.node.create_publisher(JointState, topic, 10)
        self.log('[pro-hands] 6 通道 JointState 已就绪')

    def set_normalized(self, side, values):
        if side not in self._pubs:
            return False
        vals = [max(0.0, min(1.0, float(v))) for v in (values or [])][:CHANNELS]
        vals += [0.0] * (CHANNELS - len(vals))
        from sensor_msgs.msg import JointState
        msg = JointState()
        msg.position = vals
        self._pubs[side].publish(msg)
        with self._lock:
            self._state[side] = vals
        return True

    def clear_error(self, side):
        return False


def create_hands(node, vendor='auto', logger=print):
    if vendor == 'none':
        return BaseHands(node, logger)
    return ProHands(node, logger)
