import { BaseAdapter } from './BaseAdapter.js';

/**
 * 优必选（UBTech）Walker 系列适配器。
 *
 * 本适配器是优必选真机接入的接缝层：真正的硬件调用封装在注入的 `sdk`
 * 实现中（优必选机器人控制 SDK），适配器负责协议映射、限位/限速安全兜底
 * 和状态回传。未注入 sdk 时运行在 dry-run 模式（仅打日志，不下发硬件指令）。
 *
 * 接入步骤：
 * 1. 在 bridge 目录安装优必选 SDK（npm 包或本地封装），实现 UbtechSdkInterface
 *    所列方法（见下方注释模板）；
 * 2. 启动时传入：node robot-server.js --adapter ubtech --model walker-s2 \
 *      --sdk-module ./ubtech-sdk-impl.js
 *    （sdk-module 需 default export 一个工厂函数，返回 SDK 实例）
 * 3. 机器人档案 joints 必须替换为该机型真实关节定义（robot/<机型>/profile.json）。
 *
 * SDK 实例需要实现的方法（UbtechSdkInterface）：
 *   init() -> Promise<void>                  建立与机器人控制器的连接
 *   enable() -> Promise<void>                上电使能
 *   disable() -> Promise<void>               下电失能
 *   setJointTargets(targets) -> Promise<void>  下发单步关节目标（弧度）
 *   playTrajectory(frames, fps, loop) -> Promise<void> 下发并执行轨迹
 *   stop() -> Promise<void>                  平滑停止
 *   emergencyStop() -> Promise<void>         急停
 *   getJointStates() -> Object               关节状态 {name:{position,velocity,effort,temperature}}
 *   dispose() -> Promise<void>               释放连接
 */
export class UbtechAdapter extends BaseAdapter {
    constructor(profile, options = {}) {
        super(profile, options);
        this.sdk = options.sdk || null; // null = dry-run
        this.dryRun = !options.sdk;
        this.events = [];
        this._lastTargets = {};
        this._doneFlag = null;
    }

    _log(level, message) {
        this.events.push({ level, message });
        if (this.dryRun) console.log(`[ubtech dry-run][${level}] ${message}`);
    }

    async init() {
        if (this.sdk) {
            await this.sdk.init();
            this._log('info', 'UBTech SDK initialized');
        } else {
            this._log('warning', 'No SDK provided, running in dry-run mode (no hardware commands)');
        }
        this.state = 'idle';
        return true;
    }

    async enable() {
        const clampedMode = this.mode;
        if (this.sdk) await this.sdk.enable();
        await super.enable();
        this.mode = clampedMode;
        this._log('info', 'robot enabled');
        return true;
    }

    async disable() {
        if (this.sdk) await this.sdk.disable();
        await super.disable();
        this._log('info', 'robot disabled');
        return true;
    }

    async setJointTargets(targets) {
        if (!this.enabled) return { accepted: false, reason: 'robot not enabled' };
        const clamped = this.clampTargets(targets);
        if (this.sdk) {
            await this.sdk.setJointTargets(clamped);
        }
        this._lastTargets = clamped;
        return { accepted: true, applied: clamped };
    }

    async startTrajectory(trajectoryId, frames, fps = 30, loop = false) {
        if (!this.enabled) return { accepted: false, reason: 'robot not enabled' };
        if (!Array.isArray(frames) || frames.length === 0) {
            return { accepted: false, reason: 'empty trajectory' };
        }
        const clampedFrames = frames.map(f => ({ t: f.t, targets: this.clampTargets(f.targets) }));
        if (this.sdk) {
            await this.sdk.playTrajectory(clampedFrames, fps, loop);
        } else {
            this._log('info', `playTrajectory(${trajectoryId}, ${clampedFrames.length} frames, fps=${fps}, loop=${loop})`);
        }
        this.state = 'executing';
        this.mode = 'execute';
        this._currentTrajectory = { id: trajectoryId, frameCount: clampedFrames.length, fps };
        return {
            accepted: true,
            frameCount: clampedFrames.length,
            durationMs: clampedFrames[clampedFrames.length - 1].t
        };
    }

    async stop() {
        if (this.sdk) await this.sdk.stop();
        this.state = 'ready';
        this.mode = 'idle';
        this._currentTrajectory = null;
        this._log('info', 'motion stopped');
        return true;
    }

    async emergencyStop() {
        if (this.sdk) await this.sdk.emergencyStop();
        await super.emergencyStop();
        this._currentTrajectory = null;
        this._log('warning', 'EMERGENCY STOP');
        return true;
    }

    getJointStates() {
        if (this.sdk) {
            try {
                return this.sdk.getJointStates();
            } catch (err) {
                this._log('error', `getJointStates failed: ${err.message}`);
            }
        }
        return {};
    }

    /** dry-run 下没有真实轨迹回调，由 server 定时轮询；SDK 模式下由 SDK 回调调用 */
    notifyTrajectoryDone(trajectoryId) {
        this._doneFlag = trajectoryId;
    }

    consumeTrajectoryDone() {
        const id = this._doneFlag;
        this._doneFlag = null;
        return id;
    }

    getTrajectoryProgress() {
        if (this.sdk?.getTrajectoryProgress) {
            try {
                return this.sdk.getTrajectoryProgress();
            } catch { /* ignore */ }
        }
        return this._currentTrajectory
            ? { id: this._currentTrajectory.id, frameIndex: 0, frameCount: this._currentTrajectory.frameCount }
            : null;
    }

    drainEvents() {
        const out = this.events;
        this.events = [];
        return out;
    }

    getTelemetryHz() { return this.sdk ? 50 : 20; }

    async dispose() {
        if (this.sdk?.dispose) await this.sdk.dispose();
    }
}

/**
 * 从 --sdk-module 指定的模块加载 SDK 工厂并创建适配器。
 * 模块需 default export: (profile, options) => UbtechSdkInterface
 */
export async function createUbtechAdapter(profile, options = {}) {
    let sdk = null;
    if (options.sdkModule) {
        const mod = await import(options.sdkModule);
        const factory = mod.default || mod;
        sdk = await factory(profile, options);
    }
    return new UbtechAdapter(profile, { ...options, sdk });
}
