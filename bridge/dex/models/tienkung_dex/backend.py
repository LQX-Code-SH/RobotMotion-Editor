#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TienKung Dex 后端工厂。

协议层 dex_bridge.py 只调用 create_backends()，不关心机型内部实现。
"""

from __future__ import annotations

from models.contracts import BackendBundle


def create_backends(node, args, log=print) -> BackendBundle:
    from .dex_robot import DexRobot
    from .dex_hands import create_hands
    from .dex_camera import CameraManager

    robot = DexRobot(
        node,
        rate_hz=args.rate,
        max_joint_speed=args.max_speed,
        spd=args.spd,
        cur=args.cur,
        release_after_s=args.release_after_s,
        logger=log,
    )
    hands = create_hands(node, args.hand, log)
    cameras = CameraManager(node, log)
    return BackendBundle(robot, hands, cameras)
