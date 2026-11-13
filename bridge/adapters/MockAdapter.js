import { BaseAdapter } from './BaseAdapter.js';

/**
 * 模拟机器人适配器。
 * 不依赖任何硬件，用于开发调试与前端联调：
 * - 关节状态以限速方式逼近目标值
 * - 按固定频率推送遥测
 * - 完整支持轨迹执行流程（ack/progress/done）
 */
export class MockAdapter extends BaseAdapter {
    constructor(profile, options = {}) {
        super(profile, options);
        this.state = 'ready';
        this.positions = new Map(this.joints.map(j => [j.name, 0]));
        this.velocities = new Map(this.joints.map(j => [j.name, 0]));
        this.targets = new Map(this.joints.map(j => [j.name, 0]));
        this.events = [];
        this._timer = null;
        this._lastTick = null;
        this._trajectory = null;
    }

    async init() {
        this._startLoop();
        return true;
    }

    async enable() {
        await super.enable();
        this.events.push({ level: 'info', message: 'mock robot enabled' });
        return true;
    }

    async setJointTargets(targets) {
        if (!this.enabled) return { accepted: false, reason: 'robot not enabled' };
        const clamped = this.clampTargets(targets);
        for (const [name, value] of Object.entries(clamped)) this.targets.set(name, value);
        return { accepted: true, applied: clamped };
    }

    async startTrajectory(trajectoryId, frames, fps = 30, loop = false) {
        if (!this.enabled) return { accepted: false, reason: 'robot not enabled' };
        if (!Array.isArray(frames) || frames.length === 0) {
            return { accepted: false, reason: 'empty trajectory' };
        }
        this._trajectory = {
            id: trajectoryId,
            frames: frames.map(f => ({ t: f.t, targets: this.clampTargets(f.targets) })),
            fps,
            loop,
            frameIndex: 0,
            nextFrameAt: Date.now()
        };
        this.state = 'executing';
        this.mode = 'execute';
        this.events.push({ level: 'info', message: `trajectory ${trajectoryId} started (${frames.length} frames)` });
        return { accepted: true, frameCount: frames.length, durationMs: frames[frames.length - 1].t };
    }

    async stop() {
        this._trajectory = null;
        await super.stop();
        return true;
    }

    async emergencyStop() {
        this._trajectory = null;
        for (const name of this.targets.keys()) this.targets.set(name, this.positions.get(name));
        await super.emergencyStop();
        this.events.push({ level: 'warning', message: 'EMERGENCY STOP triggered' });
        return true;
    }

    getJointStates() {
        const states = {};
        for (const joint of this.joints) {
            const position = this.positions.get(joint.name) || 0;
            states[joint.name] = {
                position,
                velocity: this.velocities.get(joint.name) || 0,
                effort: 0,
                temperature: 38 + Math.round(Math.abs(position) * 5)
            };
        }
        return states;
    }

    drainEvents() {
        const out = this.events;
        this.events = [];
        return out;
    }

    _startLoop() {
        const hz = this.getTelemetryHz();
        this._lastTick = Date.now();
        this._timer = setInterval(() => {
            const now = Date.now();
            const dt = Math.min(0.1, (now - this._lastTick) / 1000);
            this._lastTick = now;
            this._step(dt);
        }, Math.round(1000 / hz));
    }

    _step(dt) {
        // 关节朝目标限速逼近
        for (const joint of this.joints) {
            const pos = this.positions.get(joint.name) || 0;
            const target = this.targets.get(joint.name) || 0;
            const maxDelta = (joint.velocity || 6) * dt;
            const delta = target - pos;
            const step = Math.abs(delta) <= maxDelta ? delta : Math.sign(delta) * maxDelta;
            this.positions.set(joint.name, pos + step);
            this.velocities.set(joint.name, step / dt);
        }

        // 轨迹推进
        if (this._trajectory) {
            const traj = this._trajectory;
            if (Date.now() >= traj.nextFrameAt) {
                if (traj.frameIndex < traj.frames.length) {
                    const frame = traj.frames[traj.frameIndex];
                    for (const [name, value] of Object.entries(frame.targets)) {
                        this.targets.set(name, value);
                    }
                    traj.nextFrameAt = Date.now() + Math.max(1, Math.round(1000 / traj.fps));
                    traj.frameIndex++;
                } else if (traj.loop) {
                    traj.frameIndex = 0;
                    traj.nextFrameAt = Date.now();
                } else {
                    this._trajectory = null;
                    this.state = 'ready';
                    this.mode = 'idle';
                    this.events.push({ level: 'info', message: `trajectory ${traj.id} done` });
                    this._doneId = traj.id;
                }
            }
        }
    }

    /** 返回并清除轨迹完成标记（robot-server 据此推送 trajectory_done） */
    consumeTrajectoryDone() {
        const id = this._doneId;
        this._doneId = null;
        return id;
    }

    /** 当前轨迹进度（robot-server 据此推送 trajectory_progress） */
    getTrajectoryProgress() {
        return this._trajectory
            ? { id: this._trajectory.id, frameIndex: this._trajectory.frameIndex, frameCount: this._trajectory.frames.length }
            : null;
    }

    async dispose() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }
}
