#!/usr/bin/env node
/**
 * 操作站网关 (station)。
 *
 * 运行在操作员电脑上。浏览器无法直接发 UDP 广播扫描设备，因此由 station
 * 代为完成设备发现，并把浏览器的 WebSocket 连接代理到目标机器人：
 *
 *   浏览器  --ws-->  station(:8090)  --ws-->  机器人 robot-server(:8081)
 *   浏览器  --http--> station /api/devices  获取同网段设备列表
 *
 * 设备发现双通道：
 *   1. 监听机器人端 robot-server 的 UDP 信标广播（:45678）；
 *   2. HTTP API 触发时，向各子网接口发送 "discover" 探测包，收集 1s 内回应。
 *
 * 用法：node station.js [--port 8090] [--beacon-port 45678]
 */
import { createSocket } from 'dgram';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';

const args = process.argv.slice(2);
function argOf(name, def) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const HTTP_PORT = parseInt(argOf('port', '8090'), 10);
const BEACON_PORT = parseInt(argOf('beacon-port', '45678'), 10);
const DEVICE_TTL_MS = 7000; // 超过 7s 无信标视为离线

// ---------- 设备注册表 ----------
/** @type {Map<string, {id,name,model,displayName,vendor,ips,wsPort,state,lastSeen}>} */
const devices = new Map();

function upsertDevice(info) {
    const existing = devices.get(info.id) || {};
    devices.set(info.id, { ...existing, ...info, lastSeen: Date.now() });
}

function pruneDevices() {
    const now = Date.now();
    for (const [id, dev] of devices) {
        if (now - dev.lastSeen > DEVICE_TTL_MS) devices.delete(id);
    }
}

setInterval(pruneDevices, 2000);

// ---------- UDP 信标监听 + 探测 ----------
const udp = createSocket({ type: 'udp4', reuseAddr: true });

udp.on('message', (buf, rinfo) => {
    try {
        const msg = JSON.parse(buf.toString());
        if (msg.type === 'robot-beacon') {
            upsertDevice({
                id: msg.id,
                name: msg.name,
                model: msg.model,
                displayName: msg.displayName || msg.name,
                vendor: msg.vendor,
                ips: msg.ips || [rinfo.address],
                wsPort: msg.wsPort,
                state: msg.state,
                source: 'beacon',
                address: rinfo.address
            });
        }
    } catch { /* ignore malformed */ }
});

udp.bind(BEACON_PORT, () => {
    udp.setBroadcast(true);
    console.log(`[station] UDP beacon listener on :${BEACON_PORT}`);
});

function getLocalIPs() {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const net of list || []) {
            if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
        }
    }
    return ips;
}

function sendDiscoverProbes() {
    const payload = JSON.stringify({ type: 'discover', t: Date.now() });
    for (const ip of getLocalIPs()) {
        const broadcastAddr = ip.split('.').slice(0, 3).concat('255').join('.');
        udp.send(payload, BEACON_PORT, broadcastAddr, () => {});
    }
}

// 主动探测（触发时向全网段广播 discover，机器人单播回应）
function probeAsync() {
    sendDiscoverProbes();
}

// ---------- HTTP API ----------
const httpServer = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.url === '/api/health') {
        res.end(JSON.stringify({ ok: true, devices: devices.size }));
        return;
    }

    if (req.url === '/api/devices' || req.url?.startsWith('/api/devices?')) {
        probeAsync(); // 顺带触发一轮主动探测，回应结果在下一次查询可见
        const url = new URL(req.url, 'http://localhost');
        const includeOffline = url.searchParams.get('includeOffline') === '1';
        const now = Date.now();
        const list = [...devices.values()]
            .filter(dev => includeOffline || now - dev.lastSeen <= DEVICE_TTL_MS)
            .map(dev => ({
                id: dev.id,
                name: dev.name,
                model: dev.model,
                displayName: dev.displayName,
                vendor: dev.vendor,
                ip: dev.ips?.[0] || dev.address,
                wsPort: dev.wsPort,
                state: dev.state,
                online: now - dev.lastSeen <= DEVICE_TTL_MS,
                lastSeenMsAgo: now - dev.lastSeen,
                // 浏览器可直接连接的两种地址：经 station 代理 / 直连机器人
                proxyUrl: `ws://${req.headers.host}/ws?device=${encodeURIComponent(dev.id)}`,
                directUrl: `ws://${dev.ips?.[0] || dev.address}:${dev.wsPort}`
            }));
        res.end(JSON.stringify({ ok: true, devices: list }));
        return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

// ---------- WebSocket 代理 ----------
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (clientWs, req) => {
    const url = new URL(req.url, 'http://localhost');
    const deviceId = url.searchParams.get('device');
    const device = devices.get(deviceId);

    if (!device) {
        clientWs.close(4004, `device "${deviceId}" not found or offline`);
        return;
    }

    const targetIp = device.ips?.[0] || device.address;
    const robotUrl = `ws://${targetIp}:${device.wsPort}`;
    console.log(`[proxy] client -> ${device.name} (${robotUrl})`);

    const robotWs = new WebSocket(robotUrl);
    let open = false;

    robotWs.on('open', () => { open = true; });
    robotWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data.toString());
    });
    robotWs.on('close', (code, reason) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1010, `robot closed: ${code} ${reason}`);
    });
    robotWs.on('error', (err) => {
        console.error(`[proxy] robot error: ${err.message}`);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'robot connection error');
    });

    clientWs.on('message', (data) => {
        if (!open) return; // 机器人连接建立前丢弃，避免乱序
        if (robotWs.readyState === WebSocket.OPEN) robotWs.send(data.toString());
    });
    clientWs.on('close', () => robotWs.close());
    clientWs.on('error', () => robotWs.close());
});

httpServer.listen(HTTP_PORT, () => {
    console.log(`[station] HTTP  API  http://localhost:${HTTP_PORT}/api/devices`);
    console.log(`[station] WS proxy  ws://localhost:${HTTP_PORT}/ws?device=<deviceId>`);
});

process.on('SIGINT', () => { udp.close(); process.exit(0); });
