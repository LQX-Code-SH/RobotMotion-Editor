#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Walker C1 后端工厂。

⚠️ 真机待核对：启动前必须切 half_sdk 模式（scripts/deploy/walker_c1/sdk_mode.sh）。
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
        return False, 'C1 相机 relay 尚未适配（阶段 3）'

    def unsubscribe(self, camera_id, token):
        pass

    def unsubscribe_token(self, token):
        pass

    def shutdown(self):
        pass


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
    hands = WalkerHands(node, joint_map, log)
    return robot, hands, _NoCamera()
