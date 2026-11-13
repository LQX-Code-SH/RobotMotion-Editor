/**
 * 机器人适配器接口约定。
 *
 * 所有适配器必须实现以下方法。robot-server.js 只与适配器接口交互，
 * 不感知具体机器人 SDK。新增机型（如优必选 Walker 系列）时继承 BaseAdapter
 * 并实现各钩子方法即可。
 */
export class BaseAdapter {
    /**
     * @param {object} profile 机器人档案（来自 robot/<model>/profile.json）
     * @param {object} options
     */
    constructor(profile, options = {}) {
        this.profile = profile;
        this.options = options;
        this.joints = profile.joints || [];
        this.jointMap = new Map(this.joints.map(j => [j.name, j]));
        this.state = 'disconnected'; // disconnected | idle | ready | executing | estop
        this.mode = 'idle';          // idle | follow | execute
        this.enabled = false;
        this.startedAt = Date.now();
    }

    /** 关节限位裁剪（安全兜底，所有适配器都应经过此处） */
    clampJointValue(name, value) {
        const joint = this.jointMap.get(name);
        if (!joint) return null;
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        if (joint.lower !== undefined && value < joint.lower) return joint.lower;
        if (joint.upper !== undefined && value > joint.upper) return joint.upper;
        return value;
    }

    /** 批量裁剪并过滤未知关节 */
    clampTargets(targets) {
        const out = {};
        for (const [name, value] of Object.entries(targets || {})) {
            const clamped = this.clampJointValue(name, value);
            if (clamped !== null) out[name] = clamped;
        }
        return out;
    }

    /** 初始化硬件连接。返回 Promise<boolean> */
    async init() { return true; }

    /** 上电/使能关节 */
    async enable() { this.enabled = true; this.state = 'ready'; return true; }

    /** 下电/失能 */
    async disable() { this.enabled = false; this.state = 'idle'; this.mode = 'idle'; return true; }

    /** 设置工作模式：idle | follow（实时跟随）| execute（轨迹执行） */
    setMode(mode) { this.mode = mode; }

    /**
     * 单步关节目标（follow 模式/遥操作）。适配器必须做速度限制后下发。
     * @param {Object<string,number>} targets 关节名 -> 弧度
     * @returns {Promise<{accepted: boolean, reason?: string}>}
     */
    async setJointTargets(/* targets */) {
        return { accepted: false, reason: 'not implemented' };
    }

    /**
     * 轨迹执行（关键帧播放）。
     * @param {string} trajectoryId
     * @param {Array<{t: number, targets: Object<string,number>}>} frames
     * @param {number} fps 采样率
     * @param {boolean} loop 是否循环
     */
    async startTrajectory(/* trajectoryId, frames, fps, loop */) {
        return { accepted: false, reason: 'not implemented' };
    }

    /** 平滑停止当前动作 */
    async stop() { this.state = 'ready'; this.mode = 'idle'; return true; }

    /** 急停：立即抱闸/失能，所有适配器必须最短路径实现 */
    async emergencyStop() {
        this.enabled = false;
        this.state = 'estop';
        this.mode = 'idle';
        return true;
    }

    /**
     * 获取当前关节状态。
     * @returns {Object<string,{position:number, velocity:number, effort:number, temperature?:number}>}
     */
    getJointStates() {
        const states = {};
        for (const joint of this.joints) {
            states[joint.name] = { position: 0, velocity: 0, effort: 0 };
        }
        return states;
    }

    /** 遥测节流频率（Hz），robot-server 按此频率推送 status */
    getTelemetryHz() { return 50; }

    /** 每次遥测附带的事件通知（错误/告警等），返回数组后清空 */
    drainEvents() { return []; }

    async dispose() {}
}
