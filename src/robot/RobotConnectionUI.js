import { RobotBridgeClient, scanDevices } from './RobotBridgeClient.js';
import { evaluateClip } from '../animation/core/BezierEvaluator.js';
import { filterSyncPose, hasPoseChanged, SYNC_SEND_INTERVAL_MS } from './robotSync.js';

/**
 * 真机控制模块：按设备地址连接、关节状态同步、位姿/回零下发、
 * 动画轨迹播放，并挂载到"真机控制"悬浮面板。
 *
 * 编辑工作流（与现有动画编辑器打通）：
 *  1. 在 3D 视口 / 关节面板 / 动画编辑器中编辑动作；
 *  2. "发送当前位姿"：把 PoseController 当前位姿作为 follow 模式单步目标下发；
 *  3. "真机回零"：所有可直控关节下发 0 位（腿部/手部除外）；
 *  4. 动画编辑器"真机播放"：把当前 clip 按 fps 采样成关键帧轨迹下发执行（playClip）；
 *  5. follow 同步模式：机器人关节状态实时回灌到 3D 视口（真机姿态镜像）。
 */
export class RobotConnectionUI {
    /**
     * @param {object} deps
     * @param {object} deps.poseController 位姿控制器（唯一写路径）
     * @param {object} deps.animationWorkspace 动画工作区（clip 数据源）
     * @param {object} deps.sceneManager 场景管理器
     */
    constructor({
        poseController,
        animationWorkspace,
        sceneManager,
        endEffectorIKControls = null,
        robotGhost = null
    }) {
        this.poseController = poseController;
        this.animationWorkspace = animationWorkspace;
        this.sceneManager = sceneManager;
        this.endEffectorIKControls = endEffectorIKControls;
        this.robotGhost = robotGhost;
        this.ghostVisible = true;

        this.client = new RobotBridgeClient();
        this.device = null;              // 当前连接的设备档案
        this.state = 'idle';             // idle | connecting | connected | error
        this.stateMessage = '';          // 失败原因等状态说明
        this.lastJointStates = null;     // 最近一帧真机关节状态（一次性读取 / 幽灵层）
        this.syncControlEnabled = false; // 视口操作 -> 真机同步控制
        this._syncTimer = null;
        this._lastSentPose = null;
        this._syncSuspended = false;     // 轨迹执行期间暂停下发
        this._syncRejectedAt = 0;
        this._unsubscribePose = null;
        this.logLines = [];
        this.maxLogLines = 200;

        this._wireClientEvents();
    }

    // ---------- 初始化 ----------

    init() {
        this._bindPanel();
        this._unsubscribePose = this.poseController?.subscribe?.((event) => this._handlePoseEvent(event));
        this.appendLog('system', '真机控制模块就绪。填写设备地址后点“连接”。');

        const input = document.getElementById('robot-device-address');
        const saved = localStorage.getItem('robot-device-address');
        if (saved && input && !input.value) input.value = saved;
    }

    /** 操作站地址：显式 http 地址则用之，否则默认页面同主机 :8090 */
    get stationUrl() {
        const address = this._address();
        if (/^https?:\/\//i.test(address)) return address.replace(/\/+$/, '');
        const host = window.location.hostname || 'localhost';
        return `http://${host}:8090`;
    }

    _address() {
        return (document.getElementById('robot-device-address')?.value || '').trim();
    }

    _bindPanel() {
        const $ = (id) => document.getElementById(id);
        $('robot-connect-btn')?.addEventListener('click', () => this.connect());
        $('robot-disconnect-btn')?.addEventListener('click', () => this.disconnect());

        $('robot-sync-control-toggle')?.addEventListener('change', (e) => {
            this.setSyncControl(e.target.checked);
        });
        $('robot-keyboard-jog-toggle')?.addEventListener('change', (e) => {
            this.setKeyboardJog(e.target.checked);
        });
        $('robot-ghost-toggle')?.addEventListener('change', (e) => {
            this.setGhostVisible(e.target.checked);
        });
        if (this.endEffectorIKControls) {
            this.endEffectorIKControls.onKeyboardStateChange = (enabled) => {
                const toggle = document.getElementById('robot-keyboard-jog-toggle');
                if (toggle) toggle.checked = Boolean(enabled);
            };
        }
        $('robot-send-pose-btn')?.addEventListener('click', () => this.sendCurrentPose());
        $('robot-home-btn')?.addEventListener('click', () => this.homeRobot());
        $('robot-read-pose-btn')?.addEventListener('click', () => this.syncPoseFromRobot());
        $('robot-stop-btn')?.addEventListener('click', () => this.stopRobot());
        $('robot-estop-btn')?.addEventListener('click', () => this.emergencyStop());

        const addressInput = $('robot-device-address');
        addressInput?.addEventListener('change', (e) => {
            localStorage.setItem('robot-device-address', e.target.value.trim());
            if (this.state === 'error') this._setState('idle');
        });
        addressInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.connect();
        });
    }

    // ---------- 姿态同步 ----------

    /** 一次性把真机当前姿态读进 3D 视口（不写关键帧）。 */
    syncPoseFromRobot() {
        if (!this._requireConnected()) {
            this._updateReadPoseButton();
            return;
        }
        if (this.syncControlEnabled) {
            this.appendLog('error', '请先关闭「真机同步控制」，再读取真机姿态。');
            return;
        }
        const states = this.lastJointStates;
        if (!states || !Object.keys(states).length) {
            this.appendLog('error', '尚未收到真机遥测，无法读取姿态。');
            return;
        }

        const pose = {};
        for (const [name, state] of Object.entries(states)) {
            if (typeof state?.position === 'number') pose[name] = state.position;
        }
        if (!Object.keys(pose).length) {
            this.appendLog('error', '真机遥测中没有可用的关节位置。');
            return;
        }

        this.poseController.applyPose(pose, { source: 'robot' });
        this.robotGhost?.setPose(states);
        this.appendLog('system', `已读取真机姿态（${Object.keys(pose).length} 关节）到视口。`);
    }

    /** 「读取真机姿态」只在已连接且未开启流式同步时可用。 */
    _updateReadPoseButton() {
        const button = document.getElementById('robot-read-pose-btn');
        if (!button) return;
        const connected = Boolean(this.client.connected && this.device);
        const enabled = connected && !this.syncControlEnabled;
        button.disabled = !enabled;
        button.title = !connected
            ? '尚未连接机器人'
            : this.syncControlEnabled
                ? '请先关闭「真机同步控制」'
                : '把真机当前姿态读取到 3D 视口';
    }

    /**
     * 视口操作 -> 真机同步控制。
     * 开启后视口里拖动关节 / 末端 IK 会按约 12.5Hz 节流下发 follow 目标。
     */
    setSyncControl(enabled, { silent = false } = {}) {
        const next = Boolean(enabled);
        const toggle = document.getElementById('robot-sync-control-toggle');

        if (next && (!this.client.connected || !this.device)) {
            if (toggle) toggle.checked = false;
            this.appendLog('error', '尚未连接机器人，无法开启真机同步控制。');
            return;
        }
        if (next === this.syncControlEnabled) {
            if (toggle) toggle.checked = next;
            return;
        }

        this.syncControlEnabled = next;
        if (toggle) toggle.checked = next;

        if (next) {
            this._lastSentPose = null;
            this._syncSuspended = false;
            Promise.resolve(this.client.setMode?.('follow')).catch(() => {});
            if (!silent) {
                this.appendLog('warning', '真机同步控制已开启：视口操作会实时下发到真机，请确认机器人周围无人。');
            }
        } else {
            this._lastSentPose = null;
            if (this._syncTimer) {
                clearTimeout(this._syncTimer);
                this._syncTimer = null;
            }
            if (!silent) this.appendLog('system', '真机同步控制已关闭。');
        }
        this._updateReadPoseButton();
    }

    /** 真机姿态幽灵层显示开关。 */
    setGhostVisible(visible) {
        this.ghostVisible = Boolean(visible);
        const toggle = document.getElementById('robot-ghost-toggle');
        if (toggle) toggle.checked = this.ghostVisible;
        this.robotGhost?.setVisible(this.ghostVisible);
    }

    /** 键盘 jog：WASD/QE 平移、1-6 旋转，末端 IK 求解后走同一 PoseController 路径。 */
    setKeyboardJog(enabled) {
        const toggle = document.getElementById('robot-keyboard-jog-toggle');
        const ik = this.endEffectorIKControls;

        if (enabled) {
            if (!ik) {
                if (toggle) toggle.checked = false;
                this.appendLog('error', '末端控制模块不可用，无法开启键盘控制。');
                return;
            }
            if (!ik.model || !ik.chains.length) {
                if (toggle) toggle.checked = false;
                this.appendLog('error', '请先加载机器人模型再开启键盘控制。');
                return;
            }
            ik.setKeyboardEnabled(true);
            this.appendLog('system', '键盘控制已开启：W/S 前后、A/D 左右、Q/E 升降、1-6 旋转。');
        } else {
            ik?.setKeyboardEnabled(false);
            this.appendLog('system', '键盘控制已关闭。');
        }
    }

    /** 视口关节变化（用户拖动 / 末端 IK）→ 节流下发。 */
    _handlePoseEvent(event) {
        if (!this.syncControlEnabled || this._syncSuspended) return;
        if (event?.type !== 'jointChanged') return;
        if (!['user', 'viewport'].includes(event.source)) return;
        this._scheduleSyncSend();
    }

    _scheduleSyncSend() {
        if (this._syncTimer) return;
        this._syncTimer = setTimeout(() => {
            this._syncTimer = null;
            this._flushSyncPose();
        }, SYNC_SEND_INTERVAL_MS);
    }

    async _flushSyncPose() {
        if (!this.syncControlEnabled || this._syncSuspended) return;
        if (!this.client.connected) return;

        const targets = filterSyncPose(this.poseController?.getPose?.() || {}, this.device);
        if (!Object.keys(targets).length) return;
        if (!hasPoseChanged(this._lastSentPose, targets)) return;
        this._lastSentPose = targets;

        try {
            const ack = await this.client.sendJointTargets(targets);
            if (!ack?.accepted) this._logSyncIssue('warning', `同步指令被拒绝：${ack?.reason || '未知原因'}`);
        } catch (error) {
            this._logSyncIssue('error', `同步下发失败：${error.message}`);
        }
    }

    /** 拒绝/异常日志限频，避免每个节拍刷屏。 */
    _logSyncIssue(level, message) {
        const now = Date.now();
        if (now - this._syncRejectedAt < 3000) return;
        this._syncRejectedAt = now;
        this.appendLog(level, message);
    }

    // ---------- 连接 ----------

    async connect() {
        if (this.state === 'connecting') return;

        const address = this._address();
        if (!address) {
            this._setState('error', '请填写设备地址');
            this.appendLog('error', '请填写设备地址（机器人 IP，或操作站 http 地址）。');
            return;
        }
        localStorage.setItem('robot-device-address', address);

        // 先清空 device，避免 close 触发“掉线”事件
        this.device = null;
        this.client.close();
        this._updateReadPoseButton();

        this._setState('connecting');
        this.appendLog('system', `连接 ${address}…`);

        try {
            if (/^https?:\/\//i.test(address)) {
                await this._connectViaStation(address.replace(/\/+$/, ''));
            } else {
                await this._connectDirect(address);
            }
        } catch (err) {
            this._setState('error', err.message);
            this.appendLog('error', `连接失败：${err.message}`);
        }
    }

    /** 经操作站发现唯一设备后连接（一个地址只会有一台设备） */
    async _connectViaStation(stationUrl) {
        const devices = await this._onlineDevices(stationUrl);
        if (!devices.length) throw new Error('未发现设备');

        const device = devices[0];
        const urls = [device.directUrl, device.proxyUrl].filter(Boolean);
        if (!urls.length) throw new Error('未发现设备（设备没有可用连接地址）');

        let lastError = null;
        for (const url of urls) {
            try {
                const welcome = await this.client.connect(url, { timeoutMs: 8000 });
                this.device = welcome;
                this._onConnected(welcome, url);
                return;
            } catch (err) {
                lastError = err;
                this.appendLog('system', `连接 ${url} 失败：${err.message}`);
            }
        }
        throw lastError || new Error('未发现设备');
    }

    /** 直连机器人控制端口；必要时用操作站补上该地址注册的端口 */
    async _connectDirect(address) {
        const { host, port } = this._parseHostPort(address);
        const urls = [`ws://${host}:${port || 8081}`];

        try {
            const devices = await this._onlineDevices(this.stationUrl);
            const device = devices.find(d => d.ip === host || d.directUrl?.includes(`//${host}:`));
            if (device) {
                for (const url of [device.directUrl, device.proxyUrl].filter(Boolean)) {
                    if (!urls.includes(url)) urls.push(url);
                }
            }
        } catch { /* 操作站不可用不影响直连 */ }

        let lastError = null;
        for (const url of urls) {
            try {
                const welcome = await this.client.connect(url, { timeoutMs: 6000 });
                this.device = welcome;
                this._onConnected(welcome, url);
                return;
            } catch (err) {
                lastError = err;
                this.appendLog('system', `连接 ${url} 失败：${err.message}`);
            }
        }
        throw new Error(`未发现设备（直连 ${urls[0]} 失败：${lastError?.message || '无响应'}）`);
    }

    _parseHostPort(address) {
        const value = address.replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
        const [hostPart, portPart] = value.split(':');
        const host = hostPart || 'localhost';
        const port = portPart && /^\d+$/.test(portPart) ? Number(portPart) : null;
        return { host, port };
    }

    async _onlineDevices(stationUrl) {
        if (!stationUrl) throw new Error('未配置操作站地址');
        let devices;
        try {
            devices = await scanDevices(stationUrl);
        } catch (err) {
            throw new Error(`无法访问操作站 ${stationUrl}（${err.message}）`);
        }
        return (devices || []).filter(device => device.online);
    }

    _onConnected(welcome, url) {
        this._setState('connected');
        this.appendLog('system', `连接成功：${welcome.displayName || welcome.name}-${welcome.id}`
            + `（${welcome.model}，${welcome.joints?.length || 0} 关节，适配器：${welcome.adapter}）`);
        this.validateJointMatch();
        // 面板不再提供使能按钮：连接后自动使能，失败只告警不阻断连接
        this._autoEnable();
    }

    async _autoEnable() {
        if (!this.client.connected) return;
        const ack = await this.client.enable();
        if (ack?.accepted) {
            this.appendLog('system', '已自动使能。');
        } else {
            this.appendLog('warning', `自动使能未成功：${ack?.reason || '未知原因'}（需在机器人侧确认使能状态后再下发动作）`);
        }
    }

    _setState(state, message = '') {
        this.state = state;
        this.stateMessage = message;
        this.updateConnectionInfo();
        // 动画编辑器的“真机播放”按钮跟随连接状态
        this.animationWorkspace?.setRobotAvailable?.(state === 'connected');
        this._updateReadPoseButton();
    }

    disconnect() {
        const wasConnected = Boolean(this.device);
        this.setSyncControl(false, { silent: true });
        this.robotGhost?.clear();
        this.lastJointStates = null;
        this.device = null;
        this.client.close();
        this._setState('idle');
        if (wasConnected) this.appendLog('system', '已断开连接。');
    }

    updateConnectionInfo() {
        const infoEl = document.getElementById('robot-connection-info');
        if (!infoEl) return;

        if (!this.device) {
            if (this.state === 'connecting') {
                infoEl.innerHTML = '<span class="robot-status-connecting">连接中…</span>';
            } else if (this.state === 'error') {
                infoEl.innerHTML = `<span class="robot-status-error">连接失败：${escapeHtml(this.stateMessage || '未知原因')}</span>`;
            } else {
                infoEl.innerHTML = '<span class="robot-status-disconnected">未连接</span>';
            }
            return;
        }

        const status = this.client.status;
        const name = this.device.displayName || this.device.name || '设备';
        const id = this.device.id || '-';
        infoEl.innerHTML = `
            <span class="robot-status-connected">连接成功：${escapeHtml(name)}-${escapeHtml(id)}</span>
            <span class="robot-status-detail">状态：${status ? status.state : '-'} · 模式：${status ? status.mode : '-'}</span>
        `;
    }

    /** 机器人关节定义与当前模型关节名一致性校验 */
    validateJointMatch() {
        const robotJoints = new Set((this.device?.joints || []).map(j => j.name));
        if (!robotJoints.size) return true;
        const modelJoints = this._getModelJointNames();
        if (!modelJoints.size) return true;

        const missingOnRobot = [...modelJoints].filter(name => !robotJoints.has(name));
        if (missingOnRobot.length) {
            this.appendLog('warning', `以下 ${missingOnRobot.length} 个模型关节在真机上不存在，将不会下发：${missingOnRobot.slice(0, 8).join(', ')}${missingOnRobot.length > 8 ? ' …' : ''}`);
            return false;
        }
        this.appendLog('system', '模型关节与真机关节定义完全匹配。');
        return true;
    }

    _getModelJointNames() {
        const names = new Set();
        const clips = this.animationWorkspace?.store?.project?.clips || [];
        for (const clip of clips) {
            for (const track of clip.tracks || []) {
                if (track.type === 'joint' && track.jointName) names.add(track.jointName);
            }
        }
        if (!names.size && this.poseController) {
            const pose = this.poseController.getPose?.() || {};
            Object.keys(pose).forEach(name => names.add(name));
        }
        return names;
    }

    // ---------- 动作下发 ----------

    /** 把当前视口位姿下发为 follow 模式单步目标 */
    async sendCurrentPose() {
        if (!this._requireConnected()) return;
        const pose = this.poseController.getPose();
        if (!pose || Object.keys(pose).length === 0) {
            this.appendLog('error', '当前模型没有可下发的关节。');
            return;
        }
        await this.client.setMode('follow');
        const ack = await this.client.sendJointTargets(pose);
        if (ack.accepted) {
            this._lastSentPose = null;
            this.appendLog('system', `已下发当前位姿（${Object.keys(ack.applied || pose).length} 关节）。`);
        } else {
            this.appendLog('error', `位姿下发失败：${ack.reason || '未知原因'}`);
        }
    }

    /**
     * 把指定动画 clip 采样为关键帧轨迹并下发真机播放。
     * 入口在动画编辑器工具栏的“真机播放”，由 main.js 注入本方法。
     */
    async playClip(clip) {
        if (!this._requireConnected()) return;
        if (!clip) {
            this.appendLog('error', '没有可播放的动画 clip。请先在动画编辑器中录制或编辑动作。');
            return;
        }

        const robotJoints = new Set((this.device?.joints || []).map(j => j.name));
        const fps = Math.max(1, Math.min(120, clip.fps || 30));
        const startMs = clip.playRange?.startMs ?? 0;
        const endMs = clip.playRange?.endMs ?? clip.durationMs ?? 0;
        if (endMs <= startMs) {
            this.appendLog('error', 'clip 播放区间无效。');
            return;
        }

        // 按固定帧率采样，并过滤真机上不存在的关节
        const frames = [];
        let filtered = 0;
        for (let t = startMs; t <= endMs; t += 1000 / fps) {
            const pose = evaluateClip(clip, t);
            const targets = {};
            for (const [name, value] of Object.entries(pose)) {
                if (robotJoints.size && !robotJoints.has(name)) { filtered++; continue; }
                targets[name] = value;
            }
            frames.push({ t: Math.round(t - startMs), targets });
        }
        if (!frames.length) {
            this.appendLog('error', '轨迹采样结果为空。');
            return;
        }
        if (filtered > 0) {
            this.appendLog('warning', `已过滤 ${filtered} 个真机上不存在的关节采样点。`);
        }

        this.appendLog('system', `下发轨迹：clip "${clip.name}"，${frames.length} 帧 @ ${fps}fps，时长 ${((endMs - startMs) / 1000).toFixed(1)}s…`);
        // 轨迹执行期间暂停视口同步控制，避免与轨迹目标互相覆盖
        this._syncSuspended = true;
        await this.client.setMode('execute');
        const ack = await this.client.playTrajectory(frames, fps, !!clip.loop);
        if (ack.accepted) {
            this.appendLog('system', `真机开始执行轨迹 ${ack.trajectoryId}（${ack.frameCount ?? frames.length} 帧）。`);
        } else {
            this._syncSuspended = false;
            this.appendLog('error', `轨迹下发失败：${ack.reason || '未知原因'}`);
        }
    }

    /**
     * 真机回零：所有可直控关节下发 0 位（follow 单步目标，服务端限位限速）。
     * 腿部由运控独占、手部走独立通道，均排除。
     */
    async homeRobot() {
        if (!this._requireConnected(true)) return;

        const joints = (this.device?.joints || []).filter(joint =>
            joint.controllable !== false && joint.group !== 'leg' && joint.group !== 'hand');
        if (!joints.length) {
            this.appendLog('error', '设备未提供可回零的关节定义，无法回零。');
            return;
        }

        const targets = {};
        for (const joint of joints) targets[joint.name] = 0;

        this.appendLog('system', `下发回零（${joints.length} 关节）…`);
        await this.client.setMode('follow');
        const ack = await this.client.sendJointTargets(targets);
        if (ack.accepted) {
            this._lastSentPose = null;
            const count = Object.keys(ack.applied || targets).length;
            this.appendLog('system', `回零指令已接受（${count} 关节）。`);
            if (ack.rejected && Object.keys(ack.rejected).length) {
                this.appendLog('warning', `以下关节被拒绝：${Object.keys(ack.rejected).slice(0, 8).join(', ')}`);
            }
        } else {
            this.appendLog('error', `回零失败：${ack.reason || '未知原因'}`);
        }
    }

    async stopRobot() {
        if (!this._requireConnected()) return;
        const ack = await this.client.stop();
        this.appendLog(ack.accepted ? 'system' : 'error', ack.accepted ? '已发送停止指令。' : '停止指令失败。');
    }

    async emergencyStop() {
        if (!this._requireConnected(true)) return;
        const ack = await this.client.emergencyStop();
        this.appendLog(ack.accepted ? 'warning' : 'error', ack.accepted ? '⚠ 急停已触发！机器人已失能。' : '急停指令失败，请立即使用物理急停按钮！');
        // 急停后绝不能继续下发同步目标
        this.setSyncControl(false, { silent: true });
    }

    _requireConnected(includeDevice = false) {
        if (!this.client.connected || (includeDevice && !this.device)) {
            this.appendLog('error', '尚未连接机器人。');
            return false;
        }
        return true;
    }

    // ---------- 客户端事件 ----------

    _wireClientEvents() {
        this.client.onClose = () => {
            // 连接尝试过程中的关闭不计入“掉线”
            if (!this.device) return;
            this.setSyncControl(false, { silent: true });
            this.robotGhost?.clear();
            this.lastJointStates = null;
            this.device = null;
            this._setState('idle');
            this.appendLog('system', '与机器人的连接已断开。');
        };

        this.client.onStatus = (status) => {
            this.updateConnectionInfo();
            if (status.jointStates) {
                this.lastJointStates = status.jointStates;
                if (this.robotGhost && this.ghostVisible) {
                    this.robotGhost.setPose(status.jointStates);
                }
            }
            this._updateTelemetry(status);
        };

        this.client.onTrajectoryDone = (msg) => {
            this._syncSuspended = false;
            this._lastSentPose = null;
            this.appendLog('system', `轨迹 ${msg.trajectoryId} 执行完成。`);
            // 轨迹结束真机会落到 execute/idle，继续同步前先回到 follow 模式
            if (this.syncControlEnabled) {
                Promise.resolve(this.client.setMode?.('follow')).catch(() => {});
            }
        };

        this.client.onRobotEvent = (event) => {
            this.appendLog(event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : 'system',
                `[真机] ${event.message}`);
        };
    }

    _updateTelemetry(status) {
        const el = document.getElementById('robot-telemetry');
        if (!el) return;
        const joints = Object.entries(status.jointStates || {});
        const count = joints.length;
        if (!count) {
            el.textContent = '暂无遥测数据';
            return;
        }
        const temps = joints.map(([, s]) => s.temperature).filter(t => typeof t === 'number');
        const maxTemp = temps.length ? Math.max(...temps) : null;
        // 同步控制下：视口是目标、真机是实际，差值即跟踪误差
        const maxError = this.syncControlEnabled ? this._maxTrackingError(status.jointStates) : null;
        el.textContent = `遥测：${count} 关节 · ${status.state} · ${status.mode}`
            + `${maxTemp !== null ? ` · 最高温度 ${maxTemp}°C` : ''}`
            + `${maxError !== null ? ` · 跟踪误差 ≤ ${maxError.toFixed(1)}°` : ''}`;
    }

    /** 各关节「真机实际 − 视口目标」的最大偏差（度）。 */
    _maxTrackingError(states) {
        if (!states || !this.poseController) return null;
        let max = null;
        for (const [name, state] of Object.entries(states)) {
            const target = this.poseController.getJointValue?.(name);
            if (typeof target !== 'number' || typeof state?.position !== 'number') continue;
            const diff = Math.abs(state.position - target) * 180 / Math.PI;
            if (!Number.isFinite(diff)) continue;
            max = max === null ? diff : Math.max(max, diff);
        }
        return max;
    }

    // ---------- 日志 ----------

    appendLog(level, message) {
        const time = new Date().toLocaleTimeString();
        this.logLines.push({ time, level, message });
        if (this.logLines.length > this.maxLogLines) this.logLines.shift();
        const logEl = document.getElementById('robot-log');
        if (logEl) {
            logEl.innerHTML = this.logLines
                .map(line => `<div class="robot-log-line robot-log-${line.level}"><span class="robot-log-time">${line.time}</span>${escapeHtml(line.message)}</div>`)
                .join('');
            logEl.scrollTop = logEl.scrollHeight;
        }
        console.log(`[robot:${level}] ${message}`);
    }
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
