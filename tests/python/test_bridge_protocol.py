"""桥接协议层测试：requestId 回显、channel 回显与非法消息处理。"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
DEX_DIR = ROOT / 'bridge' / 'dex'
if str(DEX_DIR) not in sys.path:
    sys.path.insert(0, str(DEX_DIR))

dex_bridge = importlib.import_module('dex_bridge')
Bridge = dex_bridge.DexBridge


class FakeWS:
    def __init__(self, raws=()):
        self.sent = []
        self.raws = list(raws)

    async def send(self, payload):
        self.sent.append(payload)

    def __aiter__(self):
        async def gen():
            for raw in self.raws:
                yield raw
        return gen()


class FakeRobot:
    def __init__(self):
        self.enabled = False
        self.mode = 'idle'
        self.estop = False
        self.last_trajectory_id = None

    def set_mode(self, mode):
        self.mode = mode
        return True, None

    def enable(self):
        self.enabled = True
        return True, None

    def disable(self):
        self.enabled = False
        return True

    def stop(self):
        return True

    def start_trajectory(self, trajectory_id, frames, fps=30, loop=False):
        self.last_trajectory_id = trajectory_id
        return {'accepted': True}

    def emergency_stop(self):
        self.estop = True

    def trajectory_progress(self):
        return None

    def drain_events(self):
        return []

    def snapshot_targets(self):
        return {}

    def get_joint_states(self):
        return {}


class FakeCameras:
    available = False

    def describe(self):
        return []

    def unsubscribe_token(self, token):
        pass

    def info(self, camera):
        return {}


class FakeHands:
    def describe(self):
        return {'vendor': 'none', 'sides': {}}

    def get_state(self):
        return {}

    def set_normalized(self, side, values):
        return False

    def clear_error(self, side):
        return False

    def shutdown(self):
        pass


class BridgeProtocolTest(unittest.TestCase):
    def make_bridge(self):
        bridge = Bridge.__new__(Bridge)
        bridge.log = lambda *_args, **_kwargs: None
        bridge.started_at = time.time()
        bridge.device_id = 'test-device'
        bridge.name = 'Test Device'
        bridge.model = 'walker-tienkung-dex'
        bridge.profile = {
            'vendor': 'UBTech',
            'displayName': 'Test Device',
            'backend': 'dex',
            'capabilities': {'cameras': 0},
        }
        bridge.args = SimpleNamespace(
            ws_port=8081, status_port=8082, camera_port=8083,
            beacon_port=45678, release_after_s=5.0, trace=False,
        )
        bridge.robot = FakeRobot()
        bridge.hands = FakeHands()
        bridge.cameras = FakeCameras()
        bridge.clients = {}
        bridge._camera_pending = {}
        bridge._camera_dropped = {}
        bridge.send = FakeWS.send
        bridge.broadcast = lambda payload, **_kwargs: self._broadcast(bridge, payload)
        return bridge

    @staticmethod
    async def _broadcast(bridge, payload):
        for ws in list(bridge.clients):
            await bridge.send(ws, payload)

    def test_ack_payload_echoes_request_id(self):
        payload = Bridge._ack_payload({'requestId': 'req-1'}, {'type': 'ack'})
        self.assertEqual(payload['requestId'], 'req-1')
        self.assertEqual(Bridge._ack_payload({}, {'type': 'ack'}), {'type': 'ack'})

    def test_handle_echoes_request_id(self):
        bridge = self.make_bridge()
        ws = FakeWS()
        bridge.clients[ws] = dex_bridge.CHANNEL_CONTROL

        asyncio.run(bridge.handle(ws, id(ws), {'type': 'enable', 'requestId': 'req-2'}))

        self.assertEqual(ws.sent[-1]['requestId'], 'req-2')
        self.assertEqual(ws.sent[-1]['for'], 'enable')

    def test_hello_welcome_echoes_channel(self):
        bridge = self.make_bridge()
        ws = FakeWS()
        bridge.clients[ws] = dex_bridge.CHANNEL_CAMERA

        asyncio.run(bridge.handle(ws, id(ws), {'type': 'hello'}))

        self.assertEqual(ws.sent[-1]['channel'], dex_bridge.CHANNEL_CAMERA)

    def test_generated_trajectory_id_is_echoed(self):
        bridge = self.make_bridge()
        ws = FakeWS()
        bridge.clients[ws] = dex_bridge.CHANNEL_CONTROL
        bridge.robot.enable()

        asyncio.run(bridge.handle(ws, id(ws), {
            'type': 'play_trajectory', 'frames': [], 'requestId': 'req-3',
        }))

        ack = ws.sent[-1]
        self.assertTrue(ack['trajectoryId'].startswith('traj-'))
        self.assertEqual(bridge.robot.last_trajectory_id, ack['trajectoryId'])

    def test_non_object_json_returns_bad_message(self):
        bridge = self.make_bridge()
        ws = FakeWS(raws=[json.dumps([1, 2, 3])])

        asyncio.run(bridge.handler(ws, dex_bridge.CHANNEL_CONTROL))

        codes = [msg.get('code') for msg in ws.sent if msg.get('type') == 'error']
        self.assertIn('bad_message', codes)


if __name__ == '__main__':
    unittest.main()
