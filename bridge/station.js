#!/usr/bin/env node
/**
 * 操作站网关 (station)。
 *
 * 运行在操作员电脑上。职责：
 * 1. 代为完成设备发现（浏览器无法发 UDP 广播），并把浏览器的 WebSocket 连接代理到目标机器人；
 * 2. 提供固件一键部署 API：浏览器提交机器人 IP/用户名/密码，由本进程通过 SSH/SFTP 推送
 *    桥接固件并拉起服务（浏览器本身不具备 SSH 能力，也不应持有凭据）。
 *
 *   浏览器  --ws-->    station(:8090)  --ws-->  机器人桥接(:8081 控制 / :8082 状态 / :8083 相机)
 *   浏览器  --http-->  station /api/devices     获取同网段设备列表
 *   浏览器  --http-->  station /api/deploy/*    一键部署与启停
 *
 * 设备发现双通道：
 *   1. 监听机器人端桥接的 UDP 信标广播（:45678）；
 *   2. HTTP API 触发时，向各子网接口发送 "discover" 探测包，收集 1s 内回应。
 *
 * 用法：node station.js [--port 8090] [--beacon-port 45678] [--host 127.0.0.1]
 *
 * 安全提示：部署接口会接收 SSH 凭据，因此默认只监听回环地址。
 * 若浏览器与 station 不在同一台机器，显式加 --host 0.0.0.0 并确保网络可信。
 */
import { createSocket } from 'dgram';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'os';
import { listFirmwares, preflight, deploy, action } from './deploy/deployer.js';

const args = process.argv.slice(2);
function argOf(name, def) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const HTTP_PORT = parseInt(argOf('port', '8090'), 10);
const BEACON_PORT = parseInt(argOf('beacon-port', '45678'), 10);
const HOST = argOf('host', '127.0.0.1');
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
                statusPort: msg.statusPort || 0,
                cameraPort: msg.cameraPort || 0,
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

// ---------- HTTP 辅助 ----------
function sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function readJsonBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                const err = new Error('请求体过大');
                err.statusCode = 413;
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!chunks.length) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch {
                const err = new Error('请求体不是合法 JSON');
                err.statusCode = 400;
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function errorMessage(err) {
    // 只回传业务错误，不泄露凭据（本模块从不把密码放进消息）
    return err?.message || String(err);
}

// 同一台机器人同时只允许一个部署任务，避免端口/进程相互覆盖
const activeDeploys = new Set();

// ---------- HTTP API ----------
const httpServer = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, devices: devices.size, activeDeploys: activeDeploys.size });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/devices') {
        probeAsync(); // 顺带触发一轮主动探测，回应结果在下一次查询可见
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
                statusPort: dev.statusPort || 0,
                cameraPort: dev.cameraPort || 0,
                state: dev.state,
                online: now - dev.lastSeen <= DEVICE_TTL_MS,
                lastSeenMsAgo: now - dev.lastSeen,
                // 浏览器可直接连接的两种地址：经 station 代理 / 直连机器人
                proxyUrl: `ws://${req.headers.host}/ws?device=${encodeURIComponent(dev.id)}`,
                directUrl: `ws://${dev.ips?.[0] || dev.address}:${dev.wsPort}`
            }));
        sendJson(res, 200, { ok: true, devices: list });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/deploy/firmwares') {
        sendJson(res, 200, { ok: true, firmwares: listFirmwares() });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/deploy/preflight') {
        try {
            const body = await readJsonBody(req);
            const result = await preflight(body);
            sendJson(res, 200, { ok: result.ok, ...result });
        } catch (err) {
            sendJson(res, err.statusCode || 500, { ok: false, error: errorMessage(err) });
        }
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/deploy/action') {
        try {
            const body = await readJsonBody(req);
            const result = await action(body);
            sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
            sendJson(res, err.statusCode || 500, { ok: false, error: errorMessage(err) });
        }
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/deploy/run') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            sendJson(res, err.statusCode || 400, { ok: false, error: errorMessage(err) });
            return;
        }

        const key = `${body.host || ''}`;
        if (activeDeploys.has(key)) {
            sendJson(res, 409, { ok: false, error: `对 ${key} 的部署正在进行中` });
            return;
        }
        activeDeploys.add(key);

        res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no'
        });

        let closed = false;
        const emit = (event) => {
            if (closed) return;
            try {
                res.write(`${JSON.stringify(event)}\n`);
            } catch {
                closed = true;
            }
        };

        res.on('close', () => { closed = true; });

        try {
            await deploy(body, emit);
        } catch (err) {
            emit({ type: 'error', message: errorMessage(err) });
        } finally {
            activeDeploys.delete(key);
            try { res.end(); } catch { /* ignore */ }
        }
        return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
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
    const channel = url.searchParams.get('channel') || 'control';
    const targetPort = channel === 'status'
        ? (device.statusPort || device.wsPort)
        : channel === 'camera'
            ? (device.cameraPort || device.wsPort)
            : device.wsPort;
    const robotUrl = `ws://${targetIp}:${targetPort}`;
    console.log(`[proxy] client -> ${device.name} (${robotUrl}, ${channel})`);

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

httpServer.listen(HTTP_PORT, HOST, () => {
    console.log(`[station] HTTP  API  http://${HOST}:${HTTP_PORT}/api/devices`);
    console.log(`[station] WS proxy   ws://${HOST}:${HTTP_PORT}/ws?device=<deviceId>`);
    console.log(`[station] deploy API ${HOST}:${HTTP_PORT}/api/deploy/{firmwares,preflight,run,action}`);
    if (HOST === '0.0.0.0' || HOST === '::') {
        console.warn('[station] 注意：部署接口已暴露到所有网卡，会接收 SSH 凭据，请确认网络可信');
    }
});

process.on('SIGINT', () => { udp.close(); process.exit(0); });
