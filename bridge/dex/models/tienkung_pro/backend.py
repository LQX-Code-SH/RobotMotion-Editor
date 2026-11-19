#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TienKung Pro 后端工厂。"""

from __future__ import annotations

from models.contracts import BackendBundle


class _NoCamera:
    """Pro 相机待适配：当前禁用，不阻断桥接启动。"""
    available = False

    def describe(self):
        return []

    def info(self, camera_id):
        return {'topic': None, 'transport': None}

    def subscribe(self, camera_id, token, fps, callback):
        return False, 'Pro 相机尚未适配'

    def unsubscribe(self, camera_id, token):
        pass

    def unsubscribe_token(self, token):
        pass

    def shutdown(self):
        pass


def create_backends(node, args, log=print) -> BackendBundle:
    from .pro_robot import ProRobot
    from .pro_hands import create_hands

    robot = ProRobot(
        node,
        rate_hz=args.rate,
        max_joint_speed=args.max_speed,
        spd=args.spd,
        cur=args.cur,
        release_after_s=args.release_after_s,
        logger=log,
    )
    hands = create_hands(node, args.hand, log)
    return BackendBundle(robot, hands, _NoCamera())
