#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Walker S2 后端工厂。

末端由 --hand 选择：
- inspire/brainco/auto → 6 通道手（walker-6-mcp）
- gripper → PGC 1 DOF 夹爪（pgc-gripper，独立话题 GripCmd）
- none → 无末端

⚠️ 真机待核对：需切 SDK 控制器才能接收 ROS 指令；夹爪话题 /ecat/{side}_grip/cmd。
"""

from __future__ import annotations

import joint_map


class _NoCamera:
    available = False

    def describe(self):
        return []

    def info(self, camera_id):
        return {'topic': None, 'transport': None}

    def subscribe(self, camera_id, token, fps, callback):
        return False, 'S2 相机 relay 尚未适配（阶段 3）'

    def unsubscribe(self, camera_id, token):
        pass

    def unsubscribe_token(self, token):
        pass

    def shutdown(self):
        pass


class _GripperHands:
    """PGC 1 DOF 夹爪，前端按标量 0..1 换算。"""

    vendor = 'gripper'
    hand_type = 'pgc-gripper'

    def __init__(self, node, logger=print):
        self.log = logger
        self._pubs = {}
        self._state = {'left': [0.0], 'right': [0.0]}
        try:
            from ecat_task_msgs.msg import GripCmd
        except Exception as exc:
            raise RuntimeError(f'夹爪消息不可导入（{exc}）')
        for side in ('left', 'right'):
            self._pubs[side] = node.create_publisher(
                GripCmd, f'/ecat/{side}_grip/cmd', 10)

    def describe(self):
        return {
            'vendor': self.vendor,
            'type': self.hand_type,
            'sides': {
                side: {'count': 1, 'names': [], 'jointMap': [f'{side}_grip_joint']}
                for side in ('left', 'right')
            },
        }

    def get_state(self):
        return {side: {'vendor': self.vendor, 'values': list(vals), 'names': []}
                for side, vals in self._state.items()}

    def set_normalized(self, side, values):
        if side not in self._pubs:
            return False
        value = max(0.0, min(1.0, float((values or [0.0])[0])))
        from ecat_task_msgs.msg import GripCmd
        self._pubs[side].publish(GripCmd(position=value))
        self._state[side] = [value]
        return True

    def clear_error(self, side):
        return False

    def shutdown(self):
        self._pubs.clear()


def create_backends(node, args, log=print):
    from models._walker_common.walker_robot import WalkerRobot
    from models._walker_common.walker_hands import WalkerHands

    robot = WalkerRobot(
        node, joint_map,
        rate_hz=args.rate,
        max_joint_speed=args.max_speed,
        release_after_s=args.release_after_s,
        logger=log,
    )
    if args.hand == 'gripper':
        hands = _GripperHands(node, log)
    elif args.hand == 'none':
        from models._walker_common.walker_hands import WalkerHands as WH
        hands = WH(node, joint_map, log)
        hands.hand_type = 'none'
    else:
        hands = WalkerHands(node, joint_map, log)
    return robot, hands, _NoCamera()
