#!/usr/bin/env node
/**
 * 机器人端桥接服务 (robot-server)。
 *
 * 部署在机器人板载计算机（或与机器人同机的工控机）上，职责：
 * 1. UDP 设备发现：周期性向本网段广播设备信标，并响应"discover"探测请求；
 * 2. WebSocket 控制服务：接收 RobotMotion-Editor 网页端的控制指令；
 * 3. 适配器管理：把协议指令路由到具体机型的适配器（优必选 Walker 等）。
 *
 * 用法：
 *   node robot-server.js                          # 默认 walker-s2 模拟器
 *   node robot-server.js --adapter mock --model walker-c1 --name "Walker C1 #01"
 *   node robot-server.js --adapter ubtech --model walker-s2 --sdk-module ./ubtech-sdk-impl.js
 *
 * 协议详见 bridge/README.md。
 */
import { WebSocketServer } from 'ws';
import { createSocket } from 'dgram';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { MockAdapter } from './adapters/MockAdapter.js';
import { createUbtechAdapter } from './adapters/UbtechAdapter.js';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = 1;

// ---------- 参数解析 ----------
function parseArgs(argv) {
    const args = {
        adapter: 'mock', model: 'walker-s2', name: null,
        wsPort: 8081, statusPort: 8082, beaconPort: 45678, host: '0.0.0.0'
    };
    const explicit = new Set();
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i]?.replace(/^--/, '');
        if (key === 'mock') { args.adapter = 'mock'; explicit.add('adapter'); continue; }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            if (key === 'ubtech') { args.adapter = 'ubtech'; explicit.add('adapter'); continue; }
            continue;
        }
        switch (key) {
            case 'adapter': args.adapter = next; explicit.add('adapter'); break;
            case 'model': args.model = next; explicit.add('model'); break;
            case 'name': args.name = next; break;
            case 'ws-port': args.wsPort = parseInt(next, 10); explicit.add('ws-port'); break;
            case 'status-port': args.statusPort = parseInt(next, 10); explicit.add('status-port'); break;
            case 'beacon-port': args.beaconPort = parseInt(next, 10); explicit.add('beacon-port'); break;
            case 'host': args.host = next; break;
            case 'sdk-module': args.sdkModule = next; break;
        }
        if (key !== 'ubtech' && key !== 'mock' && next !== undefined && !next.startsWith('--')) i++;
    }
    args._explicit = explicit;
    return args;
}

const args = parseArgs(process.argv);

// ---------- 机器人资源目录（robot/<机型>/profile.json） ----------
const ROBOT_DIR = join(__dirname, '..', 'robot');

function listProfiles() {
    try {
        return readdirSync(ROBOT_DIR, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && existsSync(join(ROBOT_DIR, entry.name, 'profile.json')))
            .map(entry => entry.name);
    } catch {
        return [];
    }
}

function loadProfile(model) {
    const file = join(ROBOT_DIR, model, 'profile.json');
    if (!existsSync(file)) return null;
    const profile = JSON.parse(readFileSync(file, 'utf-8'));
    profile.dir = join(ROBOT_DIR, model);
    return profile;
}

const profile = loadProfile(args.model);
if (!profile) {
    console.error(`Unknown model "${args.model}". Available: ${listProfiles().join(', ') || '(none)'}`);
    console.error(`Expected: robot/${args.model}/profile.json`);
    process.exit(1);
}

// 命令行未显式指定时，采用机型档案中的桥接默认配置
if (!args._explicit.has('adapter') && profile.bridge?.adapter) args.adapter = profile.bridge.adapter;
if (!args._explicit.has('ws-port') && profile.bridge?.wsPort) args.wsPort = profile.bridge.wsPort;
if (!args._explicit.has('beacon-port') && profile.bridge?.beaconPort) args.beaconPort = profile.bridge.beaconPort;

const deviceName = args.name || `${profile.displayName} #01`;
const deviceId = `${profile.model}-${process.pid.toString(36)}`;

// ---------- 适配器 ----------
async function createAdapter() {
    const options = { sdkModule: args.sdkModule };
    if (args.adapter === 'ubtech') return createUbtechAdapter(profile, options);
    if (args.adapter === 'mock') return new MockAdapter(profile, options);
    throw new Error(`Unknown adapter "${args.adapter}" (available: mock, ubtech)`);
}

const adapter = await createAdapter();
await adapter.init();
console.log(`[bridge] adapter=${args.adapter} model=${profile.model} device=${deviceName} (${deviceId})`);

// ---------- 本机 IP 收集（用于信标与日志） ----------
function getLocalIPs() {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const net of list || []) {
            if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
        }
    }
    return ips.length ? ips : ['127.0.0.1'];
}

// ---------- WebSocket 控制服务 ----------
const wss = new WebSocketServer({ port: args.wsPort, host: args.host });
const clients = new Set();

// 状态通道（只读）：独立端口，避免遥测与相机流挤占控制连接
const statusWss = args.statusPort > 0
    ? new WebSocketServer({ port: args.statusPort, host: args.host })
    : null;
const statusClients = new Set();

function welcomePayload(channel = 'control') {
    return {
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        id: deviceId,
        name: deviceName,
        model: profile.model,
        vendor: profile.vendor,
        displayName: profile.displayName,
        adapter: args.adapter,
        channel,
        wsPort: args.wsPort,
        statusPort: args.statusPort,
        cameraPort: 0, // Node 版桥接不提供相机推流
        beaconPort: args.beaconPort,
        joints: profile.joints,
        uptimeMs: Date.now() - adapter.startedAt
    };
}

function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(data);
    }
}

function broadcastStatus(payload) {
    const data = JSON.stringify(payload);
    for (const ws of [...clients, ...statusClients]) {
        if (ws.readyState === ws.OPEN) ws.send(data);
    }
}

wss.on('connection', (ws, req) => {
    clients.add(ws);
    console.log(`[ws] control client connected from ${req.socket.remoteAddress} (total ${clients.size})`);

    ws.send(JSON.stringify(welcomePayload('control')));

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        handleMessage(ws, msg).catch(err => {
            ws.send(JSON.stringify({ type: 'error', code: 'handler', message: err.message }));
        });
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`[ws] control client disconnected (total ${clients.size})`);
    });
    ws.on('error', () => clients.delete(ws));
});

if (statusWss) {
    statusWss.on('connection', (ws, req) => {
        statusClients.add(ws);
        console.log(`[ws] status client connected from ${req.socket.remoteAddress} (total ${statusClients.size})`);
        ws.send(JSON.stringify(welcomePayload('status')));

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.type === 'hello') {
                ws.send(JSON.stringify(welcomePayload('status')));
            } else if (msg.type === 'get_status') {
                sendStatus(ws);
            } else {
                ws.send(JSON.stringify({
                    type: 'error', code: 'readonly',
                    message: `status channel is read-only, rejected "${msg.type}"`
                }));
            }
        });

        ws.on('close', () => statusClients.delete(ws));
        ws.on('error', () => statusClients.delete(ws));
    });
    console.log(`[ws] status channel listening on :${args.statusPort} (read-only)`);
}

async function handleMessage(ws, msg) {
    switch (msg.type) {
        case 'hello':
            ws.send(JSON.stringify(welcomePayload('control')));
            break;

        case 'get_status':
            sendStatus(ws);
            break;

        case 'set_mode': {
            if (!['idle', 'follow', 'execute'].includes(msg.mode)) {
                ws.send(JSON.stringify({ type: 'error', code: 'bad_mode', message: `invalid mode ${msg.mode}` }));
                return;
            }
            adapter.setMode(msg.mode);
            broadcast({ type: 'ack', for: 'set_mode', accepted: true, mode: msg.mode });
            break;
        }

        case 'enable': {
            const ok = await adapter.enable();
            broadcast({ type: 'ack', for: 'enable', accepted: ok });
            break;
        }

        case 'disable': {
            const ok = await adapter.disable();
            broadcast({ type: 'ack', for: 'disable', accepted: ok });
            break;
        }

        case 'joint_targets': {
            if (adapter.mode !== 'follow') {
                ws.send(JSON.stringify({ type: 'error', code: 'wrong_mode', message: 'switch to follow mode first' }));
                return;
            }
            const result = await adapter.setJointTargets(msg.targets || {});
            ws.send(JSON.stringify({ type: 'ack', for: 'joint_targets', ...result }));
            break;
        }

        case 'play_trajectory': {
            if (!Array.isArray(msg.frames)) {
                ws.send(JSON.stringify({ type: 'error', code: 'bad_trajectory', message: 'frames required' }));
                return;
            }
            const result = await adapter.startTrajectory(
                msg.trajectoryId || `traj-${Date.now()}`,
                msg.frames,
                msg.fps || 30,
                !!msg.loop
            );
            ws.send(JSON.stringify({ type: 'ack', for: 'play_trajectory', trajectoryId: msg.trajectoryId, ...result }));
            break;
        }

        case 'stop':
            await adapter.stop();
            broadcast({ type: 'ack', for: 'stop', accepted: true });
            break;

        case 'estop':
            await adapter.emergencyStop();
            broadcast({ type: 'ack', for: 'estop', accepted: true, state: adapter.state });
            break;

        default:
            ws.send(JSON.stringify({ type: 'error', code: 'unknown_type', message: `unknown message type "${msg.type}"` }));
    }
}

function sendStatus(ws) {
    ws.send(JSON.stringify(statusPayload()));
}

function statusPayload() {
    return {
        type: 'status',
        id: deviceId,
        name: deviceName,
        state: adapter.state,
        mode: adapter.mode,
        enabled: adapter.enabled,
        jointStates: adapter.getJointStates(),
        trajectory: adapter.getTrajectoryProgress?.() || null,
        t: Date.now()
    };
}

// ---------- 遥测与事件推送 ----------
const telemetryHz = adapter.getTelemetryHz();
setInterval(() => {
    if (clients.size === 0 && statusClients.size === 0) return;
    broadcastStatus(statusPayload());
    for (const event of adapter.drainEvents?.() || []) {
        broadcastStatus({ type: 'robot_event', ...event, t: Date.now() });
    }
    const doneId = adapter.consumeTrajectoryDone?.();
    if (doneId) broadcastStatus({ type: 'trajectory_done', trajectoryId: doneId });
}, Math.round(1000 / telemetryHz));

// ---------- UDP 设备发现 ----------
const udp = createSocket({ type: 'udp4', reuseAddr: true });

function beaconPayload() {
    return JSON.stringify({
        type: 'robot-beacon',
        protocol: PROTOCOL_VERSION,
        id: deviceId,
        name: deviceName,
        model: profile.model,
        displayName: profile.displayName,
        vendor: profile.vendor,
        ips: getLocalIPs(),
        wsPort: args.wsPort,
        statusPort: args.statusPort,
        cameraPort: 0,
        beaconPort: args.beaconPort,
        state: adapter.state,
        t: Date.now()
    });
}

udp.on('message', (buf, rinfo) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (msg.type === 'discover') {
        // 操作站探测：单播回应信标
        udp.send(beaconPayload(), rinfo.port, rinfo.address);
    }
});

udp.bind(args.beaconPort, () => {
    udp.setBroadcast(true);
    console.log(`[udp] discovery listening on :${args.beaconPort}`);
});

// 周期广播信标（兼容不支持探测响应的网络）
setInterval(() => {
    const payload = beaconPayload();
    for (const ip of getLocalIPs()) {
        const broadcastAddr = ip.split('.').slice(0, 3).concat('255').join('.');
        udp.send(payload, args.beaconPort, broadcastAddr, () => {});
    }
}, 2000);

// ---------- 退出清理 ----------
async function shutdown() {
    console.log('\n[bridge] shutting down...');
    try { await adapter.dispose(); } catch { /* ignore */ }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[bridge] WebSocket control server listening on ws://${getLocalIPs()[0]}:${args.wsPort}`);
console.log(`[bridge] broadcasting beacon every 2s on UDP :${args.beaconPort}`);
