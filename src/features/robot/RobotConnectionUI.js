import { RobotBridgeClient, scanDevices } from './RobotBridgeClient.js';
import { RobotCameraUI } from './RobotCameraUI.js';
import {
    filterSyncPose,
    hasPoseChanged,
    HAND_STREAM_INTERVAL_MS,
    HAND_SYNC_EPSILON,
    SYNC_SEND_INTERVAL_MS
} from './robotSync.js';
import {
    BRIDGE_RAMP_RAD_S,
    HAND_MIN_DURATION_MS,
    HAND_SEND_HZ,
    MOTION_DONE_MARGIN_MS,
    TELEMETRY_MAX_AGE_MS,
    TRAJECTORY_FPS,
    clampSpeedDeg,
    degToRad,
    handPoseFromState,
    homeTargetsFor,
    planClipHands,
    planHandMove,
    planHandRamp,
    planJointTrajectory,
    prependLeadIn,
    sampleClipTrajectory,
    selectUpperBodyTargets,
    upperBodyJointNames
} from './robotMotion.js';

/** 真机同步控制下的拖拽末端限速（与驱动 spd≈1.5 rad/s 匹配，避免目标跑在真机能力之外）。 */
const TELEOP_EE_MAX_SPEED = 0.3;          // m/s
const TELEOP_EE_MAX_ANGULAR_SPEED = 1.5;  // rad/s

/**
 * 真机控制模块：按设备地址连接、关节状态同步、位姿/回零下发、
 * 动画轨迹播放，并挂载到"真机控制"悬浮面板。
 *
 * 编辑工作流（与现有动画编辑器打通）：
 *  1. 在 3D 视口 / 关节面板 / 动画编辑器中编辑动作；
 *  2. "发送当前位姿"：把视口上肢（双臂 + 腰 + 头 + 手部主动关节）从真机当前位姿
 *     插值平滑下发（execute 轨迹，峰值速度受面板限速）；腿不参与；
 *  3. "真机回零"：从真机当前位姿插值回到零点（面板「重置零点」记录的当前姿态，
 *     未重置时用内置采集值），同样限速；
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
        this.onDeviceChange = null;   // (device|null) 连接建立/断开时通知外部（如部署面板同步端口）

        this.client = new RobotBridgeClient();
        this.device = null;              // 当前连接的设备档案
        this.expectedEndEffectorTypes = null; // 当前预览机型支持的末端协议类型（由 catalog 提供）
        this.state = 'idle';             // idle | connecting | connected | error
        this.stateMessage = '';          // 失败原因等状态说明
        this.lastJointStates = null;     // 最近一帧真机关节状态（一次性读取 / 幽灵层）
        this.syncControlEnabled = false; // 视口操作 -> 真机同步控制
        this._syncTimer = null;
        this._lastSentPose = null;
        this._syncSuspended = false;     // 轨迹执行期间暂停下发
        this._syncRejectedAt = 0;
        this._retryAt = 0;               // 使能/模式自动重试的限频时间戳
        this._unsubscribePose = null;
        this._motionBusy = false;        // 正在执行「发送当前位姿 / 回零」轨迹
        this._releaseOnMotionDone = false; // 本次轨迹结束后是否立即失能释放双臂
        this._motionTimer = null;        // 轨迹完成回执兜底超时
        this._handTimer = null;          // 手部归一化时序下发
        this._lastHandValues = { left: null, right: null };
        this._lastSentHandTargets = null; // 流式同步的手部归一化去重
        this._lastHandSentAt = 0;         // 手部独立通道最近一次下发时间（20Hz 限频）
        this._handStreamTimer = null;
        this._pendingHandTargets = null;
        this._lastStatusAt = 0;          // 本机收到遥测的时间（不用真机时钟，避免时钟差）
        this._autoSyncAfterMove = false; // 本次轨迹完成后自动读取真机姿态
        this._syncFromRobotTimer = null;
        this.logLines = [];
        this.maxLogLines = 200;

        this._wireClientEvents();
    }

    // ---------- 初始化 ----------

    init() {
        this._bindPanel();
        this.cameraUI = new RobotCameraUI({
            client: this.client,
            log: (level, message) => this.appendLog(level, message)
        });
        this._unsubscribePose = this.poseController?.subscribe?.((event) => this._handlePoseEvent(event));
        this.appendLog('system', '真机控制模块就绪。填写设备地址后点“连接”。');

        const input = document.getElementById('robot-device-address');
        const saved = localStorage.getItem('robot-device-address');
        if (saved && input && !input.value) input.value = saved;

        const speed = document.getElementById('robot-motion-speed');
        const savedSpeed = Number(localStorage.getItem('robot-motion-speed'));
        if (speed && Number.isFinite(savedSpeed) && savedSpeed > 0) {
            speed.value = String(clampSpeedDeg(savedSpeed));
        }
        this._restoreHelpState();
        this._updateHomeInfo();
        this._updateAnimationRobotControls();
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
        $('robot-set-home-btn')?.addEventListener('click', () => this._captureHomePose());
        $('robot-read-pose-btn')?.addEventListener('click', () => this.syncPoseFromRobot());
        $('robot-stop-btn')?.addEventListener('click', () => this.stopRobot());
        $('robot-estop-btn')?.addEventListener('click', () => this.emergencyStop());

        $('robot-motion-speed')?.addEventListener('change', (e) => {
            const value = clampSpeedDeg(e.target.value);
            e.target.value = String(value);
            localStorage.setItem('robot-motion-speed', String(value));
        });
        // 分区说明的「?」按钮：事件委托，避免每个分区各绑一次
        const panelContent = document.querySelector('.robot-panel-content');
        panelContent?.addEventListener('click', (event) => {
            const button = event.target.closest?.('.robot-help-toggle');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            this.toggleSectionHelp(button);
        });

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

    /**
     * 一次性把真机当前姿态读进 3D 视口（不写关键帧）。
     * @param {{auto?: boolean}} [options] auto=true 为动作完成后的自动同步：
     *        允许在「真机同步控制」开启时执行，且断开/无遥测时静默跳过。
     */
    syncPoseFromRobot({ auto = false } = {}) {
        if (!this.client.connected || !this.device) {
            if (!auto) this._requireConnected();
            this._updateReadPoseButton();
            return;
        }
        if (!auto && this.syncControlEnabled) {
            this.appendLog('error', '请先关闭「真机同步控制」，再读取真机姿态。');
            return;
        }
        const states = this.lastJointStates;
        if (!states || !Object.keys(states).length) {
            if (!auto) this.appendLog('error', '尚未收到真机遥测，无法读取姿态。');
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

        // 手指不在 jointStates 里，走手部归一化状态单独换算
        const hand = this._handPoseFromStatus();
        if (hand.total && !hand.matched) {
            this.appendLog('warning', `手部关节名与当前模型不匹配（真机手型 ${this.device?.hands?.vendor || 'none'}），本次未同步手指。`);
        }
        Object.assign(pose, hand.pose);

        const ghostStates = { ...states };
        for (const [name, angle] of Object.entries(hand.pose)) {
            ghostStates[name] = { position: angle };
        }

        this.poseController.applyPose(pose, { source: 'robot' });
        this.robotGhost?.setPose(ghostStates);
        this.appendLog('system', `已读取真机姿态（${Object.keys(states).length} 关节`
            + `${hand.matched ? ` + ${hand.matched} 手指` : ''}）到视口。`);
    }

    /** 手部归一化状态 → URDF 手指角（rad）。 */
    _handPoseFromStatus(status = this.client.status) {
        const hands = status?.hands;
        return handPoseFromState({
            hands: this.device?.hands,
            ranges: this._modelJointRanges(),
            valuesBySide: {
                left: hands?.left?.values,
                right: hands?.right?.values
            }
        });
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
     * 开启后视口里拖动关节 / 末端 IK 会按 50Hz 节流下发 follow 目标（手指 20Hz）。
     */
    setSyncControl(enabled, { silent = false, release = true } = {}) {
        const next = Boolean(enabled);
        const toggle = document.getElementById('robot-sync-control-toggle');

        // 真机正在执行轨迹/播放时不允许开启同步控制（两条控制通路互斥）
        if (next && this._motionBusy) {
            if (toggle) toggle.checked = false;
            this.appendLog('warning', '真机正在执行动作/播放，请等待完成或点「停止」后再开启同步控制。');
            return;
        }
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
        // 遥操作时限速拖拽目标：模型与真机走同一条受限轨迹（平时编辑不限速）
        this.endEffectorIKControls?.setTeleopLimited?.(next, {
            maxSpeed: TELEOP_EE_MAX_SPEED,
            maxAngularSpeed: TELEOP_EE_MAX_ANGULAR_SPEED
        });

        if (next) {
            this._lastSentPose = null;
            this._lastSentHandTargets = null;
            this._lastHandSentAt = 0;
            this._syncSuspended = false;
            // 桥接可能已因静置/断连自动失能：先补一次使能，再切 follow
            Promise.resolve(this.client.enable?.())
                .then(() => this.client.setMode?.('follow'))
                .catch(() => {});
            const vendor = this.device?.hands?.vendor || 'none';
            if (vendor !== 'none') {
                const handPlan = planHandMove({
                    hands: this.device?.hands,
                    ranges: this._modelJointRanges(),
                    home: false
                });
                if (!handPlan.matched) {
                    this.appendLog('warning', `手部关节名与当前模型不匹配（真机手型 ${vendor}），同步控制不会驱动手指。`);
                }
            }
            if (!silent) {
                this.appendLog('warning', '真机同步控制已开启：视口操作会实时下发到真机（关节 50Hz，手指 20Hz 走独立通道），请确认机器人周围无人。');
            }
        } else {
            this._lastSentPose = null;
            this._lastSentHandTargets = null;
            if (this._handStreamTimer) {
                clearTimeout(this._handStreamTimer);
                this._handStreamTimer = null;
            }
            this._pendingHandTargets = null;
            if (this._syncTimer) {
                clearTimeout(this._syncTimer);
                this._syncTimer = null;
            }
            // 关闭同步控制即释放双臂：否则桥接会以 50Hz 一直重发最后一组目标
            if (release && this.client.connected) this.client.disableNoAck();
            if (!silent) this.appendLog('system', '真机同步控制已关闭（已释放双臂，停止保持流）。');
        }
        this._updateReadPoseButton();
        // 「真机播放」与同步控制互斥：开关状态变了就同步动画编辑器按钮
        this._updateAnimationRobotControls();
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

    _flushSyncPose() {
        if (!this.syncControlEnabled || this._syncSuspended) return;
        if (!this.client.connected) return;

        // 模式/使能不对时目标会被桥接丢弃，提前拦一下（日志与重试均限频）
        const status = this.client.status;
        if (status?.enabled === false) {
            this._logSyncIssue('warning', '真机未使能，同步目标被丢弃（请确认使能状态）。');
            if (!status.estop) this._retryEnableOnce();
            return;
        }
        if (status?.mode && status.mode !== 'follow') {
            this._retryFollowOnce(status.mode);
            return;
        }

        const pose = this.poseController?.getPose?.() || {};
        const targets = filterSyncPose(pose, this.device);
        const jointsChanged = Object.keys(targets).length > 0
            && hasPoseChanged(this._lastSentPose, targets);

        // 手指不在 joint_targets 里：走 hand_targets 独立通道（归一化 0..1）
        const handTargets = this._handTargetsFromPose(pose);
        const handsChanged = this._hasHandTargetsChanged(handTargets);

        if (!jointsChanged && !handsChanged) return;

        if (jointsChanged) {
            this._lastSentPose = targets;
            // 50Hz 流式不等 ack：request() 以消息 type 作 key，高频会互相覆盖
            this.client.sendJointTargetsNoAck(targets);
        }

        if (handsChanged) {
            // 手驱动串口带宽有限：独立通道限 20Hz，被限频时排一次尾帧
            const wait = HAND_STREAM_INTERVAL_MS - (Date.now() - this._lastHandSentAt);
            if (wait <= 0) {
                this._sendHandStream(handTargets);
            } else {
                this._scheduleHandStream(handTargets, wait);
            }
        }
    }

    _sendHandStream(targets) {
        for (const [side, values] of Object.entries(targets)) {
            this.client.sendHandTargets(side, values);
        }
        this._lastSentHandTargets = targets;
        this._lastHandSentAt = Date.now();
    }

    /** 被 20Hz 限频时，保证最后一次手部目标不被丢掉。 */
    _scheduleHandStream(targets, delayMs) {
        this._pendingHandTargets = targets;
        if (this._handStreamTimer) return;
        this._handStreamTimer = setTimeout(() => {
            this._handStreamTimer = null;
            const pending = this._pendingHandTargets;
            this._pendingHandTargets = null;
            if (!pending || !this.syncControlEnabled || this._syncSuspended) return;
            this._sendHandStream(pending);
        }, Math.max(0, delayMs));
    }

    /** 只手部关节的限位与当前值（50Hz 流式下避免遍历整机模型）。 */
    _handJointRanges() {
        const hands = this.device?.hands;
        const joints = this.poseController?.model?.joints;
        const ranges = {};
        for (const side of ['left', 'right']) {
            for (const name of hands?.sides?.[side]?.jointMap || []) {
                const joint = joints?.get?.(name);
                ranges[name] = {
                    lower: joint?.limits?.lower,
                    upper: joint?.limits?.upper,
                    value: joint?.currentValue
                };
            }
        }
        return ranges;
    }

    /** 视口 → 手部归一化目标（按真机手型的 jointMap 顺序）。 */
    _handTargetsFromPose(pose) {
        if (this._endEffectorMismatch) return null;
        if (!this.device?.hands?.sides) return null;
        const plan = planHandMove({
            hands: this.device.hands,
            ranges: this._handJointRanges(),
            startBySide: this._currentHandValues(),
            home: false
        });
        if (!plan.matched) return null;
        const targets = {};
        for (const side of ['left', 'right']) {
            if (plan.sides[side]) targets[side] = plan.sides[side].to;
        }
        return Object.keys(targets).length ? targets : null;
    }

    _hasHandTargetsChanged(next) {
        if (!next) return false;
        const previous = this._lastSentHandTargets;
        if (!previous) return true;
        for (const [side, values] of Object.entries(next)) {
            const before = previous[side];
            if (!Array.isArray(before) || before.length !== values.length) return true;
            for (let index = 0; index < values.length; index += 1) {
                if (!Number.isFinite(before[index])) return true;
                if (Math.abs(before[index] - values[index]) > HAND_SYNC_EPSILON) return true;
            }
        }
        return false;
    }

    /**
     * 下发动作前确保真机已使能。
     * 桥接在轨迹结束静置 / 最后一个控制端断开后会自动失能释放双臂，
     * 所以不能只依赖连接时那一次自动使能，每次下发前都要补一次。
     */
    async _ensureEnabled() {
        if (this.client.status?.estop) return false;
        // 遥测有 50ms 级延迟：刚释放完立刻下发时 status.enabled 可能还是旧值，
        // 所以这里无条件补一次 enable（桥接侧幂等），而不是只看 status。
        const wasEnabled = this.client.status?.enabled;
        const ack = await this.client.enable();
        if (ack?.accepted === false) {
            this.appendLog('error', `自动使能失败：${ack.reason || '未知原因'}`);
            return false;
        }
        if (!wasEnabled) {
            this.appendLog('system', '已重新使能（上次动作结束后自动释放过双臂）。');
        }
        return true;
    }

    /** 未使能时每 3s 尝试一次重新使能（急停中由桥接拒绝，不会抢跑）。 */
    _retryEnableOnce() {
        const now = Date.now();
        if (now - this._retryAt < 3000) return;
        this._retryAt = now;
        Promise.resolve(this.client.enable?.()).catch(() => {});
    }

    /** 模式被轨迹/停止改掉后，每 3s 尝试切回 follow 一次。 */
    _retryFollowOnce(mode) {
        const now = Date.now();
        if (now - this._retryAt < 3000) return;
        this._retryAt = now;
        Promise.resolve(this.client.setMode?.('follow')).catch(() => {});
        this.appendLog('warning', `真机当前模式为 ${mode}，已尝试切回 follow，同步暂缓。`);
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
        this.lastJointStates = null;
        this._lastStatusAt = 0;
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

    /** 由机型选择器通知：当前预览机型支持的末端协议类型清单。 */
    setExpectedEndEffector(types) {
        this.expectedEndEffectorTypes = Array.isArray(types) && types.length ? types : null;
    }

    /**
     * 校验真机实装末端与预览机型是否匹配。
     * - hands.type 为 mock-*（dry-run）→ 跳过
     * - 机型未提供清单（旧版 profile）→ 跳过，保持向后兼容
     * - 真机 type 在清单内 → 通过
     * - 不匹配 → 禁用手部控制，但上肢仍可用
     */
    validateEndEffector() {
        const type = this.device?.hands?.type;
        const allowed = this.expectedEndEffectorTypes;
        // 每次校验先重置；旧档案/mock/无末端都视为通过（保持向后兼容）
        this._endEffectorMismatch = false;
        if (!type || type === 'none' || type.startsWith('mock-')) return true;
        if (!allowed) return true;   // 旧机型档案无声明，不阻断
        if (allowed.includes(type)) return true;
        this._endEffectorMismatch = true;
        this.appendLog('warning',
            `真机末端（${type}）与当前预览机型支持的末端不匹配，已禁用手部控制；上肢关节不受影响。`);
        return false;
    }

    _onConnected(welcome, url) {
        this._setState('connected');
        this.onDeviceChange?.(welcome);
        this.appendLog('system', `连接成功：${welcome.displayName || welcome.name}-${welcome.id}`
            + `（${welcome.model}，${welcome.joints?.length || 0} 关节，适配器：${welcome.adapter}）`);
        this.validateJointMatch();
        this.validateEndEffector();
        this.cameraUI?.setConnected(true, welcome.cameras);
        this._updateHomeInfo();
        // 面板不再提供使能按钮：连接后自动使能，失败只告警不阻断连接
        this._autoEnable();
        // 连接后自动读取一次真机姿态，保证 3D 视口与实际机器人一致
        this._autoSyncPoseOnce();
    }

    /**
     * 连接成功后自动读取一次真机姿态（等同点击「读取真机姿态」）。
     * 首帧遥测通常在 50~300ms 内到达，这里最多等 3s；有手型时同时等手部状态，
     * 避免自动读取漏掉手指。期间若用户已开启流式同步则跳过，避免覆盖同步控制。
     */
    async _autoSyncPoseOnce() {
        const expectHands = (this.device?.hands?.vendor || 'none') !== 'none';
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            if (!this.client.connected || !this.device) return;
            if (this.syncControlEnabled) return;
            if (this.lastJointStates && Object.keys(this.lastJointStates).length) {
                const hands = this.client.status?.hands;
                const handsReady = !expectHands
                    || ((hands?.left?.values?.length || 0) > 0
                        && (hands?.right?.values?.length || 0) > 0);
                if (handsReady) {
                    this.syncPoseFromRobot();
                    return;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (this.lastJointStates && Object.keys(this.lastJointStates).length) {
            this.syncPoseFromRobot();
            if (expectHands) {
                this.appendLog('warning', '3s 内未收到手部状态，本次读取只同步了身体关节。');
            }
            return;
        }
        this.appendLog('warning', '连接成功但 3s 内未收到真机遥测，已跳过自动读取姿态。');
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
        // 动画编辑器的“真机播放”按钮跟随连接状态与同步控制状态
        this._updateAnimationRobotControls();
        this._updateReadPoseButton();
    }

    /** 同步「真机播放」按钮与「真机同步控制」开关的可用性（两者互斥）。 */
    _updateAnimationRobotControls() {
        const connected = this.state === 'connected' && Boolean(this.device);
        this.animationWorkspace?.setRobotAvailable?.(connected);
        this.animationWorkspace?.setSyncControlActive?.(this.syncControlEnabled);
        this.animationWorkspace?.setRobotPlaybackBusy?.(this._motionBusy);
        const toggle = document.getElementById('robot-sync-control-toggle');
        if (toggle) toggle.disabled = !connected || this._motionBusy;
    }

    /**
     * 动作锁：执行轨迹（发送位姿/回零/真机播放）期间禁用「真机同步控制」，
     * 保证同一时刻只有一条控制通路在下发真机。
     */
    _setMotionBusy(busy) {
        this._motionBusy = Boolean(busy);
        this._updateAnimationRobotControls();
    }

    disconnect() {
        const wasConnected = Boolean(this.device);
        this._cancelMotion();
        // release:false：下面统一发一次失能，避免两条分支各发一遍
        this.setSyncControl(false, { silent: true, release: false });
        // 点「断开」必须撒手：否则桥接会保留使能状态继续 50Hz 保持最后一组目标
        if (this.client.connected) {
            this.client.disableNoAck();
            this.appendLog('system', '已发送失能，释放双臂（停止保持流）。');
        }
        this.robotGhost?.clear();
        this.lastJointStates = null;
        this._lastStatusAt = 0;
        this.device = null;
        this.cameraUI?.setConnected(false);
        this._updateHomeInfo();
        this.client.close();
        this._setState('idle');
        this.onDeviceChange?.(null);
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

    /** 面板上的下发峰值速度（rad/s）。 */
    _motionSpeedRadS() {
        const input = document.getElementById('robot-motion-speed');
        const deg = clampSpeedDeg(input?.value);
        if (input && input.value !== String(deg)) input.value = String(deg);
        return degToRad(deg);
    }

    _motionSpeedDeg() {
        return Math.round(this._motionSpeedRadS() * 180 / Math.PI);
    }

    /** 遥测年龄（ms）；尚未收到遥测返回 null。按本机接收时间计算，避免真机/浏览器时钟差。 */
    _telemetryAgeMs() {
        if (!this._lastStatusAt) return null;
        return Math.max(0, Date.now() - this._lastStatusAt);
    }

    /** 真机当前上肢角位置（rad）；缺失读数的关节记入 missing。 */
    _currentJointPositions(names) {
        const states = this.lastJointStates || {};
        const from = {};
        const missing = [];
        for (const name of names) {
            const position = states[name]?.position;
            if (Number.isFinite(position)) from[name] = position;
            else missing.push(name);
        }
        return { from, missing };
    }

    /** 手部当前归一化读数（遥测优先，其次上次下发值）。 */
    _currentHandValues() {
        const hands = this.client.status?.hands;
        const values = {};
        for (const side of ['left', 'right']) {
            const live = hands?.[side]?.values;
            const cached = this._lastHandValues?.[side];
            if (Array.isArray(live) && live.length) values[side] = live.map(Number);
            else if (Array.isArray(cached) && cached.length) values[side] = [...cached];
            else values[side] = null;
        }
        return values;
    }

    /** 模型关节限位 + 当前值（手部归一化用）。 */
    _modelJointRanges() {
        const ranges = {};
        this.poseController?.model?.joints?.forEach((joint, name) => {
            ranges[name] = {
                lower: joint?.limits?.lower,
                upper: joint?.limits?.upper,
                value: joint?.currentValue
            };
        });
        return ranges;
    }

    /** 视口 → 手部归一化目标（含插值起点）。 */
    _planHandFromViewport() {
        if (this._endEffectorMismatch) return null;
        return planHandMove({
            hands: this.device?.hands,
            ranges: this._modelJointRanges(),
            startBySide: this._currentHandValues(),
            home: false
        });
    }

    /** 回零 → 手部回到零点（记录值；未记录则用内置采集值）。 */
    _planHandHome(homeHands = null) {
        if (this._endEffectorMismatch) return null;
        return planHandMove({
            hands: this.device?.hands,
            ranges: null,
            startBySide: this._currentHandValues(),
            home: true,
            homeValues: homeHands
        });
    }

    _homeStorageKey() {
        return `robot-home-pose:${this.device?.model || 'default'}`;
    }

    /** 读取已记录的 home（真机当前姿态快照）；无记录返回 null。 */
    _loadHomePose() {
        try {
            const raw = localStorage.getItem(this._homeStorageKey());
            if (!raw) return null;
            const saved = JSON.parse(raw);
            return saved && typeof saved === 'object' ? saved : null;
        } catch {
            return null;
        }
    }

    _updateHomeInfo() {
        const el = document.getElementById('robot-home-info');
        if (!el) return;
        const saved = this._loadHomePose();
        if (!saved?.joints) {
            el.textContent = '零点：内置采集值（可重置）';
            return;
        }
        const count = Object.keys(saved.joints).length;
        const at = Number(saved.savedAt);
        el.textContent = `零点已重置：${count} 关节${Number.isFinite(at) ? ` · ${new Date(at).toLocaleString()}` : ''}`;
    }

    /** 把真机当前姿态设为回零零点（关节 rad + 手部归一化），持久化到 localStorage。 */
    _captureHomePose() {
        if (!this._requireConnected(true)) return null;
        const age = this._telemetryAgeMs();
        if (age === null || age > TELEMETRY_MAX_AGE_MS) {
            this.appendLog('error', '真机遥测不可用或已过期，无法重置零点。');
            return null;
        }
        const names = upperBodyJointNames(this.device);
        if (!names.length) {
            this.appendLog('error', '设备未提供可记录的关节定义，无法重置零点。');
            return null;
        }
        const { from, missing } = this._currentJointPositions(names);
        if (missing.length) {
            this.appendLog('error', `缺少 ${missing.length} 个关节读数（${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' …' : ''}），无法重置零点。`);
            return null;
        }
        const hands = this._currentHandValues();
        const hasHands = (this.device?.hands?.vendor || 'none') !== 'none';
        if (hasHands && (!hands.left || !hands.right)) {
            this.appendLog('warning', '未收到手部状态，本次零点不含手部（回零时手部用内置采集值）。');
        }
        const saved = {
            joints: from,
            hands: { left: hands.left, right: hands.right },
            vendor: this.device?.hands?.vendor || 'none',
            savedAt: Date.now()
        };
        try {
            localStorage.setItem(this._homeStorageKey(), JSON.stringify(saved));
        } catch (error) {
            this.appendLog('error', `保存零点失败：${error.message}`);
            return null;
        }
        this._updateHomeInfo();
        this.appendLog('system', `零点已重置：${Object.keys(from).length} 关节`
            + `${saved.vendor !== 'none' ? ` + ${saved.vendor} 手` : ''}。`);
        return saved;
    }

    /** 各分区说明默认收起，标题后的「?」单独控制该分区；展开状态记在 localStorage。 */
    _loadHelpState() {
        try {
            const raw = localStorage.getItem('robot-help-sections');
            const saved = raw ? JSON.parse(raw) : null;
            return saved && typeof saved === 'object' ? saved : {};
        } catch {
            return {};
        }
    }

    _saveHelpState() {
        const state = {};
        document.querySelectorAll('.robot-panel-content .robot-section[data-help-group]')
            .forEach((section) => {
                state[section.dataset.helpGroup] = section.classList.contains('robot-help-on');
            });
        try {
            localStorage.setItem('robot-help-sections', JSON.stringify(state));
        } catch { /* ignore */ }
    }

    _restoreHelpState() {
        const saved = this._loadHelpState();
        document.querySelectorAll('.robot-panel-content .robot-section[data-help-group]')
            .forEach((section) => {
                const on = Boolean(saved[section.dataset.helpGroup]);
                section.classList.toggle('robot-help-on', on);
                const button = section.querySelector('.robot-help-toggle');
                if (!button) return;
                button.setAttribute('aria-pressed', on ? 'true' : 'false');
                button.title = on ? '隐藏说明' : '显示说明';
            });
    }

    toggleSectionHelp(button) {
        const section = button?.closest?.('.robot-section');
        if (!section) return;
        const next = !section.classList.contains('robot-help-on');
        section.classList.toggle('robot-help-on', next);
        button.setAttribute('aria-pressed', next ? 'true' : 'false');
        button.title = next ? '隐藏说明' : '显示说明';
        this._saveHelpState();
    }

    /** 真机会动，二次确认始终开启。 */
    _confirmMotion(summary) {
        return window.confirm(summary);
    }

    /**
     * 发送当前位姿：视口上肢（双臂 + 腰 + 头）从真机当前位置插值下发，手部走独立通道。
     */
    async sendCurrentPose() {
        if (!this._requireConnected(true)) return;
        const pose = this.poseController?.getPose?.() || {};
        const { targets, ignored } = selectUpperBodyTargets(pose, this.device);
        if (!Object.keys(targets).length) {
            this.appendLog('error', '当前模型没有可下发的上肢关节（双臂/腰）。');
            return;
        }
        if (ignored.length) {
            this.appendLog('system', `已忽略 ${ignored.length} 个非上肢关节（腿部/手指）。`);
        }
        await this._executeMove({
            targets,
            handPlan: this._planHandFromViewport(),
            label: '当前位姿'
        });
    }

    /**
     * 把上肢目标从真机**当前位姿**插值下发（execute 轨迹），手部同步时序插值。
     * 腿不参与；动作期间暂停视口流式同步，完成后恢复 follow。
     * @returns {Promise<boolean>} 是否已开始执行
     */
    async _executeMove({ targets, handPlan, label, detail = '' }) {
        if (!this._requireConnected(true)) return false;
        if (this._motionBusy) {
            this.appendLog('warning', '上一个动作仍在执行，请等待完成或点「停止」。');
            return false;
        }
        if (this._syncSuspended) {
            this.appendLog('warning', '真机正在执行轨迹，请等待完成或点「停止」后再下发。');
            return false;
        }
        if (this.client.status?.estop) {
            this.appendLog('error', '真机急停激活中，无法下发动作。');
            return false;
        }

        const age = this._telemetryAgeMs();
        if (age === null) {
            this.appendLog('error', '尚未收到真机遥测，无法从当前位置规划平滑轨迹。');
            return false;
        }
        if (age > TELEMETRY_MAX_AGE_MS) {
            this.appendLog('error', `真机遥测已过期 ${(age / 1000).toFixed(1)}s，无法规划平滑轨迹。`);
            return false;
        }

        const names = Object.keys(targets || {});
        if (!names.length) {
            this.appendLog('error', `没有可下发的「${label}」关节目标。`);
            return false;
        }

        const { from, missing } = this._currentJointPositions(names);
        const plan = planJointTrajectory({
            from,
            to: targets,
            maxSpeedRadS: this._motionSpeedRadS(),
            fps: TRAJECTORY_FPS
        });
        const handCount = handPlan?.matched || 0;
        const seconds = (plan.durationMs / 1000).toFixed(1);
        const speedDeg = this._motionSpeedDeg();

        if (missing.length) {
            this.appendLog('warning', `${missing.length} 个关节缺少真机读数（${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' …' : ''}），将直接按目标下发，由桥接限速。`);
        }

        const summaryLines = [
            `即将下发「${label}」：`,
            `· 关节 ${names.length} 个（双臂 + 腰 + 头），手部 ${handCount} 通道`,
            `· 从真机当前位姿插值，峰值速度 ≤ ${speedDeg}°/s，预计 ${seconds}s`,
            '· 腿不参与；动作期间保持页面在前台，勿关闭或断网',
            '· 急停仍在遥控器（双击 C 键）'
        ];
        if (detail) summaryLines.push(`· ${detail}`);
        summaryLines.push('继续？');
        const summary = summaryLines.join('\n');
        if (!this._confirmMotion(summary)) {
            this.appendLog('system', '已取消下发。');
            return false;
        }

        this._setMotionBusy(true);
        this._syncSuspended = true;
        this._lastSentPose = null;
        this._clearMotionTimer();

        try {
            // 桥接可能已自动失能（上次动作结束静置 / 断连释放），下发前先补使能
            if (!(await this._ensureEnabled())) throw new Error('真机未使能（自动使能失败）');
            const modeAck = await this.client.setMode('execute');
            if (modeAck?.accepted === false) {
                throw new Error(`切换 execute 模式失败：${modeAck.reason || '未知原因'}`);
            }
            const ack = await this.client.playTrajectory(plan.frames, TRAJECTORY_FPS, false);
            if (!ack?.accepted) {
                throw new Error(ack?.reason || '轨迹被拒绝');
            }
            this.appendLog('system', `已下发${label}：${names.length} 关节 / ${seconds}s / 峰值 ≤ ${speedDeg}°/s（轨迹 ${ack.trajectoryId}）。`);
            this._autoSyncAfterMove = true;
            this._startHandMove(handPlan, plan.durationMs);
            this._armMotionTimeout(plan.durationMs);
            return true;
        } catch (error) {
            this._setMotionBusy(false);
            this._syncSuspended = false;
            this.appendLog('error', `${label}下发失败：${error.message}`);
            return false;
        }
    }

    /** 手部归一化目标按 smoothstep 时序下发（桥接侧没有手部斜坡）。 */
    _startHandMove(handPlan, durationMs) {
        this._clearHandTimer();
        const sides = Object.entries(handPlan?.sides || {});
        if (!sides.length) return;
        if (!handPlan.matched) {
            this.appendLog('warning', `手部关节名与当前模型不匹配（真机手型 ${handPlan.vendor}），本次不下发手部。`);
            return;
        }
        if (handPlan.matched < handPlan.total) {
            this.appendLog('warning', `手部仅匹配 ${handPlan.matched}/${handPlan.total} 个关节（真机手型 ${handPlan.vendor}），未匹配通道保持当前读数。`);
        }

        const handDuration = Math.max(durationMs, HAND_MIN_DURATION_MS);
        const ramps = {};
        for (const [side, { from, to }] of sides) {
            const ramp = planHandRamp({ from, to, durationMs: handDuration, hz: HAND_SEND_HZ });
            if (!ramp.frames.length) continue;
            ramps[side] = ramp.frames;
        }
        this._streamHandFrames(ramps);
    }

    /**
     * 按时间轴下发手部归一化帧（每帧 {t: ms, values}，相对下发时刻）。
     * 用已过时间选帧而不是帧号累加，避免定时器抖动导致手部越跑越快。
     */
    _streamHandFrames(sides) {
        this._clearHandTimer();
        const entries = Object.entries(sides || {})
            .filter(([, frames]) => Array.isArray(frames) && frames.length)
            .map(([side, frames]) => ({ side, frames, cursor: 0 }));
        if (!entries.length) return;

        const startedAt = performance.now();
        const endMs = Math.max(...entries.map(entry => entry.frames[entry.frames.length - 1].t));
        const tick = () => {
            const elapsed = performance.now() - startedAt;
            for (const entry of entries) {
                while (entry.cursor + 1 < entry.frames.length
                    && entry.frames[entry.cursor + 1].t <= elapsed) {
                    entry.cursor += 1;
                }
                const frame = entry.frames[entry.cursor];
                this.client.sendHandTargets(entry.side, frame.values);
                this._lastHandValues[entry.side] = [...frame.values];
                this._lastSentHandTargets = {
                    ...(this._lastSentHandTargets || {}),
                    [entry.side]: [...frame.values]
                };
            }
            if (elapsed >= endMs) this._clearHandTimer();
        };
        this._handTimer = setInterval(tick, Math.max(20, Math.round(1000 / HAND_SEND_HZ)));
        tick();
    }

    _clearHandTimer() {
        if (!this._handTimer) return;
        clearInterval(this._handTimer);
        this._handTimer = null;
    }

    _clearMotionTimer() {
        if (!this._motionTimer) return;
        clearTimeout(this._motionTimer);
        this._motionTimer = null;
    }

    /** 轨迹完成回执兜底：超时未收到就恢复视口同步并提示。 */
    _armMotionTimeout(durationMs) {
        this._clearMotionTimer();
        this._motionTimer = setTimeout(() => {
            this._motionTimer = null;
            if (!this._motionBusy) return;
            this._setMotionBusy(false);
            this._syncSuspended = false;
            this._clearHandTimer();
            this.animationWorkspace?.stopRobotPlayback?.();
            this.appendLog('warning', '未按预期收到轨迹完成回执，已恢复视口同步，请确认真机是否到位。');
            const autoSync = this._autoSyncAfterMove;
            this._autoSyncAfterMove = false;
            if (autoSync) this._scheduleSyncFromRobot(0);
            if (!this._releaseAfterMotion()) this._resumeFollowIfNeeded();
        }, Math.max(1000, durationMs + MOTION_DONE_MARGIN_MS));
    }

    _resumeFollowIfNeeded() {
        if (this.syncControlEnabled) {
            Promise.resolve(this.client.setMode?.('follow')).catch(() => {});
        }
    }

    /**
     * 动作结束后立即失能释放双臂（目前用于动画真机播放）。
     * 桥接侧还有一层"静置 N 秒自动失能"兜底；这里提前撒手，播放完就交还控制权。
     * @returns {boolean} 本次是否已释放
     */
    _releaseAfterMotion() {
        if (!this._releaseOnMotionDone) return false;
        this._releaseOnMotionDone = false;
        if (this.client.connected) this.client.disableNoAck();
        this.appendLog('system', '已释放双臂（停止关节保持流）；下次下发动作会自动重新使能。');
        return true;
    }

    /** 动作结束后稍等一帧遥测，再把真机实际姿态同步到视口（含手指）。 */
    _scheduleSyncFromRobot(delayMs = 250) {
        if (this._syncFromRobotTimer) clearTimeout(this._syncFromRobotTimer);
        this._syncFromRobotTimer = setTimeout(() => {
            this._syncFromRobotTimer = null;
            this.syncPoseFromRobot({ auto: true });
        }, Math.max(0, delayMs));
    }

    /** 停止/急停/断开时清掉动作与手部时序状态。 */
    _cancelMotion() {
        this._clearMotionTimer();
        this.animationWorkspace?.stopRobotPlayback?.();
        this._clearHandTimer();
        if (this._syncFromRobotTimer) {
            clearTimeout(this._syncFromRobotTimer);
            this._syncFromRobotTimer = null;
        }
        if (this._handStreamTimer) {
            clearTimeout(this._handStreamTimer);
            this._handStreamTimer = null;
        }
        this._pendingHandTargets = null;
        this._autoSyncAfterMove = false;
        this._releaseOnMotionDone = false;
        this._lastSentHandTargets = null;
        this._setMotionBusy(false);
        this._syncSuspended = false;
    }

    /**
     * 把动画 clip 播放到真机（**单次播放，不循环**）。
     *
     * 流程：采样上肢 → 从真机当前位姿插过渡段 → 手部按同一时间轴走 hand_targets →
     * 确认后以 execute 轨迹下发；播放期间暂停视口同步，完成后回读实际姿态并恢复 follow。
     * 入口在动画编辑器工具栏的「真机播放」，由 main.js 注入。
     *
     * @param {object} clip 动画 clip
     * @returns {Promise<boolean>} 是否已开始播放
     */
    async playClip(clip) {
        if (!this._requireConnected(true)) return false;
        if (!clip) {
            this.appendLog('error', '没有可播放的动画 clip。请先在动画编辑器中录制或编辑动作。');
            return false;
        }
        if (this._motionBusy || this._syncSuspended) {
            this.appendLog('warning', '真机正在执行动作/轨迹，请等待完成或点「停止」。');
            return false;
        }
        if (this.client.status?.estop) {
            this.appendLog('error', '真机急停激活中，无法播放动画。');
            return false;
        }
        if (this.syncControlEnabled) {
            this.appendLog('error', '「真机同步控制」开启中：动画的真机控制只用「真机播放」，请先关闭同步控制。');
            return false;
        }

        const startMs = clip.playRange?.startMs ?? 0;
        const endMs = clip.playRange?.endMs ?? clip.durationMs ?? 0;
        if (endMs <= startMs) {
            this.appendLog('error', 'clip 播放区间无效。');
            return false;
        }

        const fps = Math.min(60, Math.max(1, clip.fps || 30));
        const sample = sampleClipTrajectory({
            clip,
            startMs,
            endMs,
            fps,
            device: this.device
        });
        if (!sample.jointNames.length) {
            this.appendLog('error', '该 clip 没有双臂/腰/头关节的关键帧，真机上没有可执行内容。');
            return false;
        }
        if (!sample.frames.length) {
            this.appendLog('error', '轨迹采样结果为空。');
            return false;
        }
        this._logClipIgnored(sample.ignored);

        const age = this._telemetryAgeMs();
        if (age === null || age > TELEMETRY_MAX_AGE_MS) {
            this.appendLog('warning', '真机遥测不可用/已过期：首帧不做过渡，直接按动画轨迹播放（由桥接斜坡限速）。');
        }
        const { from, missing } = this._currentJointPositions(sample.jointNames);
        const lead = prependLeadIn({
            frames: sample.frames,
            from,
            maxSpeedRadS: this._motionSpeedRadS(),
            fps: TRAJECTORY_FPS
        });

        const handPlan = this._planHandForClip({ clip, startMs, endMs, leadInMs: lead.leadInMs });
        if (sample.ignored.hand.length) {
            if (handPlan?.hasMotion) {
                this.appendLog('system', `clip 含 ${sample.ignored.hand.length} 个手指关节：按 hand_targets 同步 ${handPlan.matched} 通道。`);
            } else {
                this.appendLog('system', `clip 含 ${sample.ignored.hand.length} 个手指关节，但手型不匹配或无变化，真机播放时手指保持不动。`);
            }
        }

        const totalMs = lead.leadInMs + sample.durationMs;
        const summary = this._clipSummary({ clip, sample, lead, handPlan, missing });
        if (!this._confirmMotion(summary)) {
            this.appendLog('system', '已取消真机播放。');
            return false;
        }

        this._setMotionBusy(true);
        this._syncSuspended = true;
        this._lastSentPose = null;
        this._clearMotionTimer();

        try {
            // 上次播放结束会释放双臂（桥接自动失能），这里必须补一次使能
            if (!(await this._ensureEnabled())) throw new Error('真机未使能（自动使能失败）');
            const modeAck = await this.client.setMode('execute');
            if (modeAck?.accepted === false) {
                throw new Error(`切换 execute 模式失败：${modeAck.reason || '未知原因'}`);
            }
            // 真机播放一律单次：无人看管时反复运动会撞到人或物
            const ack = await this.client.playTrajectory(lead.frames, fps, false);
            if (!ack?.accepted) throw new Error(ack?.reason || '轨迹被拒绝');

            this.appendLog('system', `开始真机播放「${clip.name}」：${sample.jointNames.length} 关节 / `
                + `${(sample.durationMs / 1000).toFixed(1)}s`
                + `${lead.leadInMs > 0 ? `（首段过渡 ${(lead.leadInMs / 1000).toFixed(1)}s）` : ''}`
                + `${handPlan?.hasMotion ? ` / 手部 ${handPlan.matched} 通道` : ''}`
                + `，轨迹 ${ack.trajectoryId}。`);
            if (clip.loop) {
                this.appendLog('system', '该动画设为循环，真机只播放一遍（不循环）。');
            }
            this._autoSyncAfterMove = true;
            // 动画真机播放结束即释放双臂，不等桥接静置超时
            this._releaseOnMotionDone = true;
            if (handPlan?.hasMotion) this._streamHandFrames(handPlan.sides);
            this._armMotionTimeout(totalMs);
            // 视口联动：时间轴按同一节奏单次播放（过渡段有延迟），让用户看到动画
            this.animationWorkspace?.startRobotPlayback?.(lead.leadInMs, clip);
            return true;
        } catch (error) {
            this._setMotionBusy(false);
            this._syncSuspended = false;
            this.appendLog('error', `真机播放失败：${error.message}`);
            return false;
        }
    }

    /** 说明 clip 里哪些关节不参与真机播放（腿由运控独占、其余关节真机没有）。 */
    _logClipIgnored(ignored) {
        const leg = ignored?.leg?.length || 0;
        const other = ignored?.other?.length || 0;
        if (leg) {
            this.appendLog('system', `clip 含 ${leg} 个腿部关节：腿由运控独占，真机播放不参与。`);
        }
        if (other) {
            this.appendLog('warning', `已忽略 ${other} 个真机不支持的关节：${ignored.other.slice(0, 4).join(', ')}${other > 4 ? ' …' : ''}`);
        }
    }

    /** 真机播放确认摘要：时长、过渡段、峰值速度、不参与部位。 */
    _clipSummary({ clip, sample, lead, handPlan, missing }) {
        const seconds = (sample.durationMs / 1000).toFixed(1);
        const total = ((lead.leadInMs + sample.durationMs) / 1000).toFixed(1);
        const speedDeg = this._motionSpeedDeg();
        const peakDeg = Math.round(sample.peakSpeedRadS * 180 / Math.PI);
        const rampDeg = Math.round(BRIDGE_RAMP_RAD_S * 180 / Math.PI);
        const lines = [
            `即将把动画「${clip.name}」播放到真机（只播放一次，不循环）：`,
            `· 关节 ${sample.jointNames.length} 个（双臂 + 腰 + 头），动画 ${seconds}s，合计约 ${total}s`,
            lead.leadInMs > 0
                ? `· 首段从真机当前位姿过渡 ${(lead.leadInMs / 1000).toFixed(1)}s（峰值 ≤ ${speedDeg}°/s）`
                : '· 首帧与真机当前位姿基本一致，无需过渡段',
            `· 动画峰值约 ${peakDeg}°/s`
                + `${peakDeg > rampDeg ? `（超过驱动斜坡 ${rampDeg}°/s，真机会按限速播放，比动画慢）` : ''}`,
            handPlan?.hasMotion
                ? `· 手部 ${handPlan.matched} 通道随动画同步`
                : '· 手指保持当前手型',
            '· 腿不参与；动画期间保持页面在前台，勿关闭或断网',
            '· 急停仍在遥控器（双击 C 键）'
        ];
        if (missing.length) {
            lines.splice(lines.length - 2, 0, `· ⚠ ${missing.length} 个关节缺少真机读数，过渡段直接从目标开始`);
        }
        lines.push('继续？');
        return lines.join('\n');
    }

    /** 动画播放期间的手部通道时序（相对轨迹起点，含过渡段）。 */
    _planHandForClip({ clip, startMs, endMs, leadInMs }) {
        if (this._endEffectorMismatch) return null;
        const vendor = this.device?.hands?.vendor || 'none';
        if (vendor === 'none') return null;
        return planClipHands({
            clip,
            hands: this.device?.hands,
            ranges: this._modelJointRanges(),
            startBySide: this._currentHandValues(),
            startMs,
            endMs,
            leadInMs
        });
    }

    /**
     * 真机回零：从当前位姿插值回到关节 home 点（默认 0 rad），手部张开。
     * home 值集中在 robotMotion.HOME_JOINT_VALUES，按现场要求改一处即可。
     */
    async homeRobot() {
        if (!this._requireConnected(true)) return;

        const names = upperBodyJointNames(this.device);
        if (!names.length) {
            this.appendLog('error', '设备未提供可回零的上肢关节定义，无法回零。');
            return;
        }

        const saved = this._loadHomePose();
        const vendor = this.device?.hands?.vendor || 'none';
        const handHome = saved && saved.vendor === vendor ? saved.hands : null;
        const targets = homeTargetsFor(names, saved?.joints || {});

        let detail;
        if (saved?.joints) {
            const at = Number(saved.savedAt);
            detail = `回零目标＝已重置的零点（${Object.keys(saved.joints).length} 关节`
                + `${Number.isFinite(at) ? `，${new Date(at).toLocaleString()}` : ''}）`;
            this.appendLog('system', detail);
        } else {
            detail = '回零目标＝内置零点（本机采集的真机姿态）';
            this.appendLog('system', '使用内置零点回零；如需以当前姿态为新的零点，请点「重置零点」。');
        }
        if (saved?.hands && !handHome) {
            this.appendLog('warning', `记录的零点手型（${saved.vendor}）与当前手型（${vendor}）不一致，手部按张开处理。`);
        }

        const started = await this._executeMove({
            targets,
            handPlan: this._planHandHome(handHome),
            label: '回零',
            detail
        });
        if (started) {
            // 视口同步到 home 目标，避免「真机同步控制」把旧姿态再发回去
            this.poseController.applyPose(targets, { source: 'robot' });
        }
    }

    async stopRobot() {
        if (!this._requireConnected()) return;
        const ack = await this.client.stop();
        this._cancelMotion();
        const releaseS = Number(this.device?.releaseAfterS) || 0;
        this.appendLog(ack.accepted ? 'system' : 'error', ack.accepted
            ? `已发送停止指令${releaseS > 0 ? `（静置 ${releaseS}s 后自动失能释放双臂）` : ''}。`
            : '停止指令失败。');
    }

    async emergencyStop() {
        if (!this._requireConnected(true)) return;
        const ack = await this.client.emergencyStop();
        this._cancelMotion();
        this.appendLog(ack.accepted ? 'warning' : 'error', ack.accepted ? '⚠ 急停已触发！机器人已失能。' : '急停指令失败，请立即使用物理急停按钮！');
        // 急停后绝不能继续下发同步目标（急停本身已失能，无需再发 disable）
        this.setSyncControl(false, { silent: true, release: false });
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
            this._cancelMotion();
            // 连接已断，disable 发不出去；桥接侧会在最后一个控制端断开时自动失能
            this.setSyncControl(false, { silent: true, release: false });
            this.robotGhost?.clear();
            this.lastJointStates = null;
            this._lastStatusAt = 0;
            this.device = null;
            this.cameraUI?.setConnected(false);
            this._updateHomeInfo();
            this._setState('idle');
            this.onDeviceChange?.(null);
            this.appendLog('system', '与机器人的连接已断开。');
        };

        this.client.onStatus = (status) => {
            this._lastStatusAt = Date.now();
            this.updateConnectionInfo();
            if (status.jointStates) {
                this.lastJointStates = status.jointStates;
                if (this.robotGhost && this.ghostVisible) {
                    // 幽灵层也带上手指：关节状态里没有手指，用归一化手部状态换算
                    const hand = this._handPoseFromStatus(status);
                    if (hand.matched) {
                        const merged = { ...status.jointStates };
                        for (const [name, angle] of Object.entries(hand.pose)) {
                            merged[name] = { position: angle };
                        }
                        this.robotGhost.setPose(merged);
                    } else {
                        this.robotGhost.setPose(status.jointStates);
                    }
                }
            }
            this._updateTelemetry(status);
        };

        this.client.onTrajectoryDone = (msg) => {
            this._clearMotionTimer();
            this.animationWorkspace?.stopRobotPlayback?.();
            this._setMotionBusy(false);
            this._syncSuspended = false;
            this._lastSentPose = null;
            this.appendLog('system', `轨迹 ${msg.trajectoryId} 执行完成。`);
            // 「发送当前位姿 / 回零」完成后，自动读一次真机实际姿态回填视口
            const autoSync = this._autoSyncAfterMove;
            this._autoSyncAfterMove = false;
            if (autoSync) this._scheduleSyncFromRobot();
            // 动画真机播放结束：立即失能释放双臂，不再等桥接的静置超时
            if (this._releaseAfterMotion()) return;
            // 轨迹结束真机会落到 execute/idle，继续同步前先回到 follow 模式
            this._resumeFollowIfNeeded();
        };

        this.client.onRobotEvent = (event) => {
            this.appendLog(event.level === 'error' ? 'error' : event.level === 'warning' ? 'warning' : 'system',
                `[真机] ${event.message}`);
        };

        // 桥接协议错误（如未使能、模式不符）此前只打 console，面板看不到；限频避免 50Hz 刷屏
        this.client.onBridgeError = (msg) => {
            this._logSyncIssue('error', `真机桥接拒绝：${msg.message || msg.code || '未知错误'}`);
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

    /** 各关节「真机实际 − 视口目标」的最大偏差（度），只统计参与下发的上肢关节。 */
    _maxTrackingError(states) {
        if (!states || !this.poseController) return null;
        // 腿部由运控独占，算进来只会得到一个恒大的假误差
        const allowed = new Set(Object.keys(
            selectUpperBodyTargets(this.poseController.getPose?.() || {}, this.device).targets
        ));
        let max = null;
        for (const [name, state] of Object.entries(states)) {
            if (!allowed.has(name)) continue;
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
