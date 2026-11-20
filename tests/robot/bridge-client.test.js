import test from 'node:test';
import assert from 'node:assert/strict';
import { RobotBridgeClient } from '../../src/features/robot/RobotBridgeClient.js';

class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        FakeWebSocket.instances.push(this);
        FakeWebSocket.last = this;
    }

    send(data) {
        this.sent.push(JSON.parse(data));
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    emit(msg) {
        this.onmessage?.({ data: JSON.stringify(msg) });
    }

    close() {
        this.readyState = 3;
        this.onclose?.({ code: 1000 });
    }
}

globalThis.WebSocket = FakeWebSocket;

function welcome(id, extra = {}) {
    return {
        type: 'welcome',
        protocol: 1,
        id,
        model: 'walker-s2',
        joints: [],
        channel: 'control',
        ...extra,
    };
}

async function connect(url = 'ws://test') {
    const client = new RobotBridgeClient();
    const promise = client.connect(url, { timeoutMs: 1000 });
    const ws = FakeWebSocket.last;
    ws.open();
    ws.emit(welcome(url));
    await promise;
    return { client, ws };
}

test('connect 校验 welcome 并发送 hello', async () => {
    const { client, ws } = await connect();
    assert.equal(client.connected, true);
    assert.equal(client.welcome.id, 'ws://test');
    assert.deepEqual(ws.sent[0], { type: 'hello' });
    client.close();
});

test('非法 welcome 直接拒绝连接', async () => {
    const client = new RobotBridgeClient();
    const promise = client.connect('ws://bad', { timeoutMs: 1000 })
        .then(() => null, err => err);
    const ws = FakeWebSocket.last;
    ws.open();
    ws.emit(welcome('bad', { protocol: 2 }));

    const err = await promise;
    assert.match(err.message, /invalid welcome: unsupported protocol 2/);
    client.close();
});

test('ack 按 requestId 精确匹配并发请求', async () => {
    const { client, ws } = await connect();
    const first = client.request('enable');
    const second = client.request('enable');
    const [firstSent, secondSent] = ws.sent.slice(-2);

    ws.emit({ type: 'ack', for: 'enable', requestId: secondSent.requestId, marker: 'b' });
    ws.emit({ type: 'ack', for: 'enable', requestId: firstSent.requestId, marker: 'a' });

    assert.equal((await first).marker, 'a');
    assert.equal((await second).marker, 'b');
    client.close();
});

test('旧桥接只有 for 时仍能按类型兼容', async () => {
    const { client, ws } = await connect();
    const pending = client.request('stop');
    ws.emit({ type: 'ack', for: 'stop', accepted: true });

    assert.equal((await pending).accepted, true);
    client.close();
});

test('旧连接回调不会污染新连接状态', async () => {
    const first = await connect('ws://first');
    first.client.close();

    const second = await connect('ws://second');
    first.ws.emit({ type: 'status', id: 'stale' });
    first.ws.onclose({ code: 1000 });

    assert.equal(second.client.status, null);
    assert.equal(second.client.connected, true);
    assert.equal(second.client.welcome.id, 'ws://second');
    second.client.close();
});
