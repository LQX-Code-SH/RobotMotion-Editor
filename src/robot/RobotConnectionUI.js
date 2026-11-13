import { RobotBridgeClient, scanDevices } from './RobotBridgeClient.js';
import { evaluateClip } from '../animation/core/BezierEvaluator.js';

/**
 * 真机控制模块：设备搜索、连接管理、关节状态同步、
 * 关键帧轨迹下发与真机播放，并挂载到"真机控制"悬浮面板。
 *
 * 编辑工作流（与现有动画编辑器打通）：
 *  1. 在 3D 视口 / 关节面板 / 动画编辑器中编辑动作；
 *  2. "发送当前位姿"：把 PoseController 当前位姿作为 follow 模式单步目标下发；
 *  3. "播放到真机"：把当前选中动画 clip 按 fps 采样成关键帧轨迹下发执行；
 *  4. follow 同步模式：机器人关节状态实时回灌到 3D 视口（真机姿态镜像）。
 */
export class RobotConnectionUI {
    /**
     * @param {object} deps
     * @param {object} deps.poseController 位姿控制器（唯一写路径）
     * @param {object} deps.animationWorkspace 动画工作区（clip 数据源）
     * @param {object} deps.sceneManager 场景管理器
     */
    constructor({ poseController, animationWorkspace, sceneManager }) {
        this.poseController = poseController;
        this.animationWorkspace = animationWorkspace;
        this.sceneManager = sceneManager;

        this.client = new RobotBridgeClient();
        this.device = null;              // 当前连接的设备档案
        this.followEnabled = false;      // 真机状态 -> 视口同步
        this.logLines = [];
        this.maxLogLines = 200;

        this._wireClientEvents();
    }

    // ---------- 初始化 ----------

    init() {
        this._bindPanel();
        this.appendLog('system', '真机控制模块就绪。请先启动 bridge/station.js，再搜索设备。');
        // 初始 station 地址：与页面同主机 + 默认端口 8090
        const input = document.getElementById('robot-station-url');
        if (input && !input.value) {
            const host = window.location.hostname || 'localhost';
            input.value = `http://${host}:8090`;
        }
        // 记住上次使用的地址
        const saved = localStorage.getItem('robot-station-url');
        if (saved && input) input.value = saved;
    }

    _bindPanel() {
        const $ = (id) => document.getElementById(id);
        $('robot-scan-btn')?.addEventListener('click', () => this.scan());
        $('robot-connect-btn')?.addEventListener('click', () => this.connectSelected());
        $('robot-disconnect-btn')?.addEventListener('click', () => this.disconnect());
        $('robot-enable-btn')?.addEventListener('click', () => this.enableRobot());
        $('robot-disable-btn')?.addEventListener('click', () => this.disableRobot());
        $('robot-follow-toggle')?.addEventListener('change', (e) => {
            this.followEnabled = e.target.checked;
            this.appendLog('system', this.followEnabled
                ? '视口同步已开启：真机状态将实时映射到 3D 视口。'
                : '视口同步已关闭。');
        });
        $('robot-send-pose-btn')?.addEventListener('click', () => this.sendCurrentPose());
        $('robot-play-clip-btn')?.addEventListener('click', () => this.playSelectedClip());
        $('robot-stop-btn')?.addEventListener('click', () => this.stopRobot());
        $('robot-estop-btn')?.addEventListener('click', () => this.emergencyStop());
        $('robot-station-url')?.addEventListener('change', (e) => {
            localStorage.setItem('robot-station-url', e.target.value.trim());
        });
        $('robot-device-list')?.addEventListener('click', (e) => {
            const item = e.target.closest('[data-device-id]');
            if (item) {
                this.selectedDeviceId = item.getAttribute('data-device-id');
                this._highlightSelection();
            }
        });
    }

    // ---------- 设备搜索与连接 ----------

    async scan() {
        const urlInput = document.getElementById('robot-station-url');
        const listEl = document.getElementById('robot-device-list');
        const stationUrl = (urlInput?.value || '').trim();
        if (!stationUrl) {
            this.appendLog('error', '请先填写操作站网关地址（station.js 的 HTTP 地址）');
            return;
        }
        localStorage.setItem('robot-station-url', stationUrl);
        listEl.innerHTML = '<div class="robot-device-placeholder">搜索中…</div>';
        try {
            const devices = await scanDevices(stationUrl);
            this.renderDeviceList(devices);
            this.appendLog('system', `发现 ${devices.length} 台设备。`);
        } catch (err) {
            listEl.innerHTML = '<div class="robot-device-placeholder">搜索失败</div>';
            this.appendLog('error', `搜索失败：${err.message}（请确认 bridge/station.js 已启动且地址正确）`);
        }
    }

    renderDeviceList(devices) {
        const listEl = document.getElementById('robot-device-list');
        if (!devices.length) {
            listEl.innerHTML = '<div class="robot-device-placeholder">未发现设备。请确认机器人端 robot-server.js 已启动。</div>';
            return;
        }
        listEl.innerHTML = devices.map(dev => `
            <div class="robot-device-item${dev.online ? '' : ' offline'}" data-device-id="${dev.id}">
                <div class="robot-device-name">${escapeHtml(dev.name)}</div>
                <div class="robot-device-meta">${escapeHtml(dev.displayName || dev.model)} · ${escapeHtml(dev.ip || '')} · ${dev.online ? '在线' : '离线'}</div>
            </div>
        `).join('');
        this._devices = devices;
    }

    _highlightSelection() {
        document.querySelectorAll('#robot-device-list .robot-device-item').forEach(el => {
            el.classList.toggle('selected', el.getAttribute('data-device-id') === this.selectedDeviceId);
        });
    }

    async connectSelected() {
        if (!this.selectedDeviceId) {
            this.appendLog('error', '请先在列表中选择一台设备。');
            return;
        }
        const dev = (this._devices || []).find(d => d.id === this.selectedDeviceId);
        if (!dev) {
            this.appendLog('error', '所选设备已失效，请重新搜索。');
            return;
        }

        // 优先直连机器人，失败回退经 station 代理
        const urls = dev.directUrl ? [dev.directUrl, dev.proxyUrl] : [dev.proxyUrl];
        for (const url of urls) {
            if (!url) continue;
            try {
                this.appendLog('system', `连接 ${dev.name} (${url})…`);
                const welcome = await this.client.connect(url);
                this.device = welcome;
                this._onConnected(welcome, url);
                return;
            } catch (err) {
                this.appendLog('system', `连接失败：${err.message}`);
            }
        }
        this.appendLog('error', '所有连接方式均失败。');
    }

    _onConnected(welcome, url) {
        this.appendLog('system', `已连接 ${welcome.displayName || welcome.name}（${welcome.model}，${welcome.joints?.length || 0} 关节，适配器：${welcome.adapter}）`);
        this.updateConnectionInfo();
        this.validateJointMatch();
    }

    disconnect() {
        this.client.close();
        this.device = null;
        this.followEnabled = false;
        const toggle = document.getElementById('robot-follow-toggle');
        if (toggle) toggle.checked = false;
        this.appendLog('system', '已断开连接。');
        this.updateConnectionInfo();
    }

    updateConnectionInfo() {
        const infoEl = document.getElementById('robot-connection-info');
        if (!infoEl) return;
        if (!this.device) {
            infoEl.innerHTML = '<span class="robot-status-disconnected">未连接</span>';
            return;
        }
        const status = this.client.status;
        infoEl.innerHTML = `
            <span class="robot-status-connected">${escapeHtml(this.device.displayName || this.device.name)}</span>
            <span class="robot-status-detail">状态：${status ? status.state : '-'} · 模式：${status ? status.mode : '-'} · 使能：${status ? (status.enabled ? '是' : '否') : '-'}</span>
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

    // ---------- 使能 / 模式 ----------

    async enableRobot() {
        if (!this._requireConnected()) return;
        const ack = await this.client.enable();
        if (ack.accepted) this.appendLog('system', '机器人已上电使能。');
        else this.appendLog('error', `使能失败：${ack.reason || '未知原因'}`);
    }

    async disableRobot() {
        if (!this._requireConnected()) return;
        const ack = await this.client.disable();
        if (ack.accepted) this.appendLog('system', '机器人已下电失能。');
        else this.appendLog('error', `失能失败：${ack.reason || '未知原因'}`);
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
            this.appendLog('system', `已下发当前位姿（${Object.keys(ack.applied || pose).length} 关节）。`);
        } else {
            this.appendLog('error', `位姿下发失败：${ack.reason || '未知原因'}`);
        }
    }

    /**
     * 把动画编辑器当前选中 clip 采样为关键帧轨迹并下发真机播放。
     */
    async playSelectedClip() {
        if (!this._requireConnected()) return;
        const store = this.animationWorkspace?.store;
        const project = store?.project;
        const clip = project?.clips?.find(c => c.id === project.activeClipId) || project?.clips?.[0];
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
        await this.client.setMode('execute');
        const ack = await this.client.playTrajectory(frames, fps, !!clip.loop);
        if (ack.accepted) {
            this.appendLog('system', `真机开始执行轨迹 ${ack.trajectoryId}（${ack.frameCount ?? frames.length} 帧）。`);
        } else {
            this.appendLog('error', `轨迹下发失败：${ack.reason || '未知原因'}`);
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
        if (this.followEnabled) {
            this.followEnabled = false;
            const toggle = document.getElementById('robot-follow-toggle');
            if (toggle) toggle.checked = false;
        }
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
            this.appendLog('system', '与机器人的连接已断开。');
            this.device = null;
            this.updateConnectionInfo();
        };

        this.client.onStatus = (status) => {
            this.updateConnectionInfo();
            if (this.followEnabled && status.jointStates) {
                const pose = {};
                for (const [name, state] of Object.entries(status.jointStates)) {
                    if (typeof state?.position === 'number') pose[name] = state.position;
                }
                if (Object.keys(pose).length) {
                    this.poseController.applyPose(pose, { source: 'robot' });
                }
            }
            this._updateTelemetry(status);
        };

        this.client.onTrajectoryDone = (msg) => {
            this.appendLog('system', `轨迹 ${msg.trajectoryId} 执行完成。`);
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
        el.textContent = `遥测：${count} 关节 · ${status.state} · ${status.mode}${maxTemp !== null ? ` · 最高温度 ${maxTemp}°C` : ''}`;
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
