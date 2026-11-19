"""机型后端行为契约测试。

用 fake ROS 消息/节点在离线环境验证四款机型的 create_backends() 与
关节控制/轨迹推进语义。已知缺口用 expectedFailure 显式标注，修复后移除装饰器即可。
"""

from __future__ import annotations

import importlib
import sys
import time
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
DEX_DIR = ROOT / 'bridge' / 'dex'


class FakeMsg:
    def __init__(self):
        self.header = SimpleNamespace(stamp=None, frame_id=None)
        self.ctrl = []
        self.joint_cmd = []


class FakePublisher:
    def __init__(self, msg_cls, topic, qos):
        self.msg_cls = msg_cls
        self.topic = topic
        self.qos = qos
        self.messages = []

    def publish(self, msg):
        self.messages.append(msg)


class FakeTimer:
    def __init__(self, period, callback):
        self.period = period
        self.callback = callback
        self.cancelled = False

    def fire(self):
        if not self.cancelled:
            self.callback()

    def cancel(self):
        self.cancelled = True


class FakeClock:
    def now(self):
        return self

    def to_msg(self):
        return object()


class FakeNode:
    def __init__(self):
        self.publishers = []
        self.subscriptions = []
        self.timers = []

    def create_publisher(self, msg_cls, topic, qos):
        pub = FakePublisher(msg_cls, topic, qos)
        self.publishers.append(pub)
        return pub

    def create_subscription(self, msg_cls, topic, callback, qos):
        sub = SimpleNamespace(msg_cls=msg_cls, topic=topic, callback=callback, qos=qos)
        self.subscriptions.append(sub)
        return sub

    def create_timer(self, period, callback):
        timer = FakeTimer(period, callback)
        self.timers.append(timer)
        return timer

    def get_clock(self):
        return FakeClock()

    def destroy_timer(self, timer):
        timer.cancel()
        if timer in self.timers:
            self.timers.remove(timer)

    def destroy_subscription(self, sub):
        if sub in self.subscriptions:
            self.subscriptions.remove(sub)

    def destroy_publisher(self, pub):
        if pub in self.publishers:
            self.publishers.remove(pub)


def install_fake_modules():
    def make_module(name, **attrs):
        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        sys.modules[name] = module
        return module

    qos_cls = lambda **kwargs: SimpleNamespace(**kwargs)  # noqa: E731
    policy = lambda: SimpleNamespace(BEST_EFFORT=object(), VOLATILE=object(), KEEP_LAST=object())  # noqa: E731
    rclpy = make_module('rclpy')
    rclpy.qos = make_module(
        'rclpy.qos',
        DurabilityPolicy=policy(),
        HistoryPolicy=policy(),
        ReliabilityPolicy=policy(),
        QoSProfile=qos_cls,
    )

    make_module('bodyctrl_msgs')
    make_module(
        'bodyctrl_msgs.msg',
        CmdSetMotorPosition=FakeMsg,
        MotorStatusMsg=FakeMsg,
        PowerBoardKeyStatus=FakeMsg,
    )
    make_module('ros2_bridge_msgs')
    make_module(
        'ros2_bridge_msgs.msg',
        ArmCtrl=FakeMsg,
        HeadCtrl=FakeMsg,
        WaistCtrl=FakeMsg,
        RobotState=FakeMsg,
        MotorCtrl=FakeMsg,
    )
    make_module('mc_task_msgs')
    make_module(
        'mc_task_msgs.msg',
        RobotCommand=FakeMsg,
        JointCmd=FakeMsg,
        JointCommand=FakeMsg,
    )
    make_module('mc_state_msgs')
    make_module('mc_state_msgs.msg', RobotState=FakeMsg)


class BackendContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        install_fake_modules()
        if str(DEX_DIR) not in sys.path:
            sys.path.insert(0, str(DEX_DIR))
        cls.models = importlib.import_module('models')
        cls.backends = {}
        for model_id, dirname in cls.models.MODEL_DIRS.items():
            cls.models.bootstrap(model_id)
            cls.backends[model_id] = importlib.import_module(f'models.{dirname}.backend')

    def make_backends(self, model_id, hand='none'):
        # 生产进程只加载一个机型；测试需清理扁平模块缓存以模拟独立进程。
        for name in ('joint_map', 'dex_robot', 'dex_hands', 'dex_camera', 'pro_robot', 'pro_hands'):
            sys.modules.pop(name, None)
        self.models.bootstrap(model_id)
        import joint_map as jm

        node = FakeNode()
        args = SimpleNamespace(
            rate=50.0,
            max_speed=1.2,
            spd=0.3,
            cur=10.0,
            release_after_s=5.0,
            hand=hand,
            dry_run=False,
        )
        robot, hands, cameras = self.backends[model_id].create_backends(
            node, args, lambda *_args, **_kwargs: None)
        return node, robot, hands, cameras, jm

    @staticmethod
    def fire_timers(node):
        for timer in node.timers:
            timer.fire()

    @staticmethod
    def controllable_joint(jm):
        for name, entry in jm.BY_URDF.items():
            if entry.get('group') in jm.CONTROLLABLE_GROUPS:
                return name
        raise AssertionError('joint_map 中没有可控关节')

    def test_all_backends_create_expected_triple(self):
        expected_robot_methods = (
            'enable', 'disable', 'set_mode', 'set_joint_targets', 'start_trajectory',
            'stop', 'emergency_stop', 'get_joint_states', 'snapshot_targets',
            'drain_events', 'take_trajectory_done', 'trajectory_progress',
        )
        expected_hands_methods = ('describe', 'get_state', 'set_normalized', 'clear_error', 'shutdown')
        expected_camera_methods = ('describe', 'info', 'subscribe', 'unsubscribe', 'shutdown')

        for model_id in self.backends:
            with self.subTest(model=model_id):
                _node, robot, hands, cameras, _jm = self.make_backends(model_id)
                for name in expected_robot_methods:
                    self.assertTrue(callable(getattr(robot, name, None)), f'{model_id} robot 缺少 {name}')
                for name in expected_hands_methods:
                    self.assertTrue(callable(getattr(hands, name, None)), f'{model_id} hands 缺少 {name}')
                for name in expected_camera_methods:
                    self.assertTrue(callable(getattr(cameras, name, None)), f'{model_id} cameras 缺少 {name}')

    def test_dex_robot_shutdown_releases_resources(self):
        node, robot, _hands, _cameras, _jm = self.make_backends('walker-tienkung-dex')
        robot.enable()
        self.assertTrue(node.timers)
        self.assertTrue(node.publishers)
        self.assertTrue(node.subscriptions)

        robot.shutdown()

        self.assertFalse(robot.enabled)
        self.assertEqual(node.timers, [])
        self.assertEqual(node.publishers, [])
        self.assertEqual(node.subscriptions, [])

    def test_dex_set_joint_targets_publishes_on_tick(self):
        node, robot, _hands, _cameras, jm = self.make_backends('walker-tienkung-dex')
        robot.enable()
        robot.set_joint_targets({self.controllable_joint(jm): 0.1})

        self.fire_timers(node)

        self.assertTrue(any(pub.messages for pub in node.publishers), 'Dex 周期 tick 未发布关节命令')

    def test_dex_trajectory_completes(self):
        node, robot, _hands, _cameras, jm = self.make_backends('walker-tienkung-dex')
        joint = self.controllable_joint(jm)
        robot.enable()
        robot.start_trajectory('dex-traj', [
            {'t': 0, 'targets': {joint: 0.0}},
            {'t': 1, 'targets': {joint: 0.1}},
        ])

        time.sleep(0.01)
        self.fire_timers(node)

        self.assertIsNone(robot.trajectory_progress())
        self.assertEqual(robot.take_trajectory_done(), 'dex-traj')

    def test_walker_set_joint_targets_publishes_immediately(self):
        node, robot, _hands, _cameras, jm = self.make_backends('walker-s2')
        robot.enable()
        robot.set_joint_targets({self.controllable_joint(jm): 0.1})

        self.assertTrue(any(pub.messages for pub in node.publishers), 'Walker 未立即发布关节命令')

    def test_pro_set_joint_targets_publishes(self):
        node, robot, _hands, _cameras, jm = self.make_backends('walker-tienkung-pro')
        robot.enable()
        robot.set_joint_targets({self.controllable_joint(jm): 0.1})

        self.fire_timers(node)

        self.assertTrue(any(pub.messages for pub in node.publishers), 'Pro 未发布关节命令')

    def test_pro_trajectory_completes(self):
        node, robot, _hands, _cameras, jm = self.make_backends('walker-tienkung-pro')
        joint = self.controllable_joint(jm)
        robot.enable()
        robot.start_trajectory('pro-traj', [
            {'t': 0, 'targets': {joint: 0.0}},
            {'t': 1, 'targets': {joint: 0.1}},
        ])

        time.sleep(0.01)
        self.fire_timers(node)

        self.assertIsNone(robot.trajectory_progress())
        self.assertEqual(robot.take_trajectory_done(), 'pro-traj')

    def test_walker_trajectory_completes(self):
        for model_id in ('walker-c1', 'walker-s2'):
            with self.subTest(model=model_id):
                node, robot, _hands, _cameras, jm = self.make_backends(model_id)
                joint = self.controllable_joint(jm)
                traj_id = f'{model_id}-traj'
                robot.enable()
                robot.start_trajectory(traj_id, [
                    {'t': 0, 'targets': {joint: 0.0}},
                    {'t': 1, 'targets': {joint: 0.1}},
                ])

                time.sleep(0.01)
                self.fire_timers(node)

                self.assertIsNone(robot.trajectory_progress())
                self.assertEqual(robot.take_trajectory_done(), traj_id)


if __name__ == '__main__':
    unittest.main()
