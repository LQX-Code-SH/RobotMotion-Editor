/**
 * 真机桥接 WebSocket 客户端。
 *
 * 支持两种连接方式（由 URL 决定）：
 *  - 经操作站网关代理：ws://<station-host>:8090/ws?device=<deviceId>
 *  - 直连机器人桥接：  ws://<robot-ip>:8081
 *
 * 协议见 bridge/README.md。
 */
export class RobotBridgeClient {
    constructor() {
        this.ws = null;
        this.url = null;
        this.welcome = null;       // 机器人档案（welcome 消息）
        this.status = null;        // 最近一次 status
        this.connected = false;
        this._seq = 0;
        this._pendingAck = new Map(); // for -> {resolve, timer}
        this._cameraWaiters = new Set(); // 相机 ack 按 camera 精确匹配

        // 事件回调（由上层设置）
        this.onOpen = null;
        this.onClose = null;
        this.onError = null;
        this.onWelcome = null;
        this.onStatus = null;
        this.onTrajectoryDone = null;
        this.onRobotEvent = null;
        this.onBridgeError = null;  // 协议错误（wrong_mode / not enabled / estop…）
        this.onCameras = null;     // 相机清单（cameras）
        this.onCameraFrame = null; // 相机帧（camera_frame，JPEG base64）
        this.onMessage = null;     // 兜底：所有消息
    }

    /**
     * 建立 WebSocket 连接。
     * @param {string} url ws:// 地址
     * @param {object} options { timeoutMs: 8000 }
     * @returns {Promise<object>} 机器人 welcome 档案
     */
    connect(url, options = {}) {
        this.close();
        this.url = url;
        const timeoutMs = options.timeoutMs || 8000;

        return new Promise((resolve, reject) => {
            let settled = false;
            let welcomeTimer = null;

            const fail = (message) => {
                if (settled) return;
                settled = true;
                clearTimeout(welcomeTimer);
                try { this.ws?.close(); } catch { /* ignore */ }
                this.ws = null;
                reject(new Error(message));
            };

            let ws;
            try {
                ws = new WebSocket(url);
            } catch (err) {
                fail(`invalid url: ${err.message}`);
                return;
            }
            this.ws = ws;

            welcomeTimer = setTimeout(() => fail('connection timeout: no welcome message'), timeoutMs);

            ws.onopen = () => {
                this.connected = true;
                this._send({ type: 'hello' });
                this.onOpen?.();
            };

            ws.onclose = (event) => {
                const wasConnected = this.connected;
                this.connected = false;
                this.ws = null;
                this.onClose?.(event);
                if (!settled) fail(wasConnected ? 'connection closed' : `connection refused (${url})`);
            };

            ws.onerror = () => {
                this.onError?.(new Error(`websocket error (${url})`));
                if (!settled) fail(`cannot connect to ${url}`);
            };

            ws.onmessage = (event) => {
                let msg;
                try { msg = JSON.parse(event.data); } catch { return; }
                this._handleMessage(msg, resolve, () => { settled = true; clearTimeout(welcomeTimer); });
            };
        });
    }

    _handleMessage(msg, connectResolve, markConnected) {
        switch (msg.type) {
            case 'welcome':
                this.welcome = msg;
                markConnected();
                connectResolve?.(msg);
                this.onWelcome?.(msg);
                break;
            case 'status':
                this.status = msg;
                this.onStatus?.(msg);
                break;
            case 'ack': {
                // 相机 ack 先按 camera 匹配，避免并发探测时串台
                for (const waiter of [...this._cameraWaiters]) {
                    if (waiter(msg)) {
                        this._cameraWaiters.delete(waiter);
                        break;
                    }
                }
                const pending = this._pendingAck.get(msg.for);
                if (pending) {
                    clearTimeout(pending.timer);
                    this._pendingAck.delete(msg.for);
                    pending.resolve(msg);
                }
                break;
            }
            case 'trajectory_done':
                this.onTrajectoryDone?.(msg);
                break;
            case 'robot_event':
                this.onRobotEvent?.(msg);
                break;
            case 'cameras':
                this.onCameras?.(msg);
                break;
            case 'camera_frame':
                this.onCameraFrame?.(msg);
                break;
            case 'error':
                console.warn(`[robot-bridge] error from robot: ${msg.code}: ${msg.message}`);
                this.onBridgeError?.(msg);
                break;
        }
        this.onMessage?.(msg);
    }

    _send(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    /** 发送指令并等待 ack。超时返回 { accepted:false, reason:'timeout' } */
    request(type, fields = {}, timeoutMs = 5000) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this._pendingAck.delete(type);
                resolve({ accepted: false, reason: 'timeout' });
            }, timeoutMs);
            this._pendingAck.set(type, { resolve, timer });
            this._send({ type, ...fields });
        });
    }

    setMode(mode) { return this.request('set_mode', { mode }); }
    enable() { return this.request('enable'); }
    disable() { return this.request('disable'); }

    /**
     * 失能但不等待 ack：关闭同步控制 / 断开连接时用于"立即撒手"。
     * 等待 ack 会拖住断开流程，而失能本身是幂等的。
     */
    disableNoAck() { this._send({ type: 'disable' }); }

    sendJointTargets(targets) { return this.request('joint_targets', { targets }); }

    /**
     * follow 单步目标，不等待 ack（50Hz 流式专用）。
     * request() 以消息 type 作为 pending key，高频并发会互相覆盖。
     */
    sendJointTargetsNoAck(targets) {
        this._send({ type: 'joint_targets', targets });
    }

    /**
     * 下发关键帧轨迹。
     * @param {Array<{t:number, targets:Object<string,number>}>} frames
     * @param {number} fps 采样帧率
     * @param {boolean} loop
     */
    playTrajectory(frames, fps = 30, loop = false) {
        const trajectoryId = `traj-${Date.now()}-${this._seq++}`;
        return this.request('play_trajectory', { trajectoryId, frames, fps, loop }, 10000)
            .then(ack => ({ trajectoryId, ...ack }));
    }

    /**
     * 手部归一化目标（0..1）。高频时序下发（约 20Hz），
     * 不等 ack，避免每帧占用 request 队列；桥接仍会回 ack，无人认领即丢弃。
     */
    sendHandTargets(side, values) {
        this._send({ type: 'hand_targets', side, values });
    }

    stop() { return this.request('stop'); }
    emergencyStop() { return this.request('estop'); }
    getStatus() { this._send({ type: 'get_status' }); }

    // ---------- 相机（TienKung Dex 扩展） ----------

    /** 请求相机清单，结果通过 onCameras 回调。 */
    listCameras() { this._send({ type: 'camera_list' }); }

    /** 订阅某路相机推流；帧通过 onCameraFrame 回调。 */
    subscribeCamera(camera, fps = 10) {
        return this.request('camera_subscribe', { camera, fps });
    }

    /** 取消订阅某路相机。 */
    unsubscribeCamera(camera) {
        return this.request('camera_unsubscribe', { camera });
    }

    close() {
        if (this.ws) {
            try { this.ws.close(1000, 'client closed'); } catch { /* ignore */ }
            this.ws = null;
        }
        this.connected = false;
        this.welcome = null;
        this.status = null;
        for (const [, pending] of this._pendingAck) {
            clearTimeout(pending.timer);
            pending.resolve({ accepted: false, reason: 'closed' });
        }
        this._pendingAck.clear();
        for (const waiter of [...this._cameraWaiters]) {
            this._cameraWaiters.delete(waiter);
        }
    }
}

/**
 * 通过操作站网关 HTTP API 搜索同网段设备。
 * @param {string} stationHttpUrl 如 http://192.168.1.100:8090
 * @returns {Promise<Array>} 设备列表
 */
export async function scanDevices(stationHttpUrl, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${stationHttpUrl.replace(/\/$/, '')}/api/devices`, {
            signal: controller.signal
        });
        const data = await res.json();
        if (!data.ok) throw new Error('station returned error');
        return data.devices;
    } finally {
        clearTimeout(timer);
    }
}
