/**
 * 真机上肢动作规划（纯逻辑，不碰 DOM / WebSocket，便于单测）。
 *
 * 口径：
 *  - 「发送当前位姿」「真机回零」下发视口上肢：双臂（arm）+ 腰（waist）+ 头（head），
 *    手部主动关节走独立的 hand_targets（归一化 0..1）通道；腿由运控独占、不参与。
 *  - 两个动作都从真机**当前读数**插值到目标，不允许阶跃，并限制峰值角速度。
 *  - 关节插值用 smoothstep（首尾速度为 0），最大斜率 1.5，因此
 *    T = 1.5 × max|Δq| / v_max 可保证任何关节的瞬时速度都不超过 v_max。
 */

/** 允许通过 joint_targets 下发的关节组（上肢：双臂 + 腰 + 头）。 */
export const UPPER_BODY_JOINT_GROUPS = Object.freeze(['arm', 'waist', 'head']);

/** 手部关节组（走 hand_targets 独立通道）。 */
export const HAND_JOINT_GROUP = 'hand';

/**
 * 默认 / 允许的下发峰值角速度（度/秒）。
 * 默认 20°/s ≈ 0.35 rad/s，与桥接驱动侧 spd=0.3 同量级；上限 45°/s 仍低于桥接斜坡 1.2 rad/s。
 */
export const DEFAULT_SPEED_DEG_S = 20;
export const MIN_SPEED_DEG_S = 5;
export const MAX_SPEED_DEG_S = 45;

/** 轨迹采样率与最短动作时长。 */
export const TRAJECTORY_FPS = 30;
export const MIN_MOTION_MS = 600;

/** 手部归一化目标的发送频率（桥接侧无斜坡，由前端按时序插值）。 */
export const HAND_SEND_HZ = 20;

/** 手部动作最短时长：整段 0..1 行程不短于 1s，避免手指瞬间闭合。 */
export const HAND_MIN_DURATION_MS = 1000;

/** 未记录零点时的手部兜底：归一化 0 = 完全伸直/张开（BrainCo 码 1，Inspire 码上限）。 */
export const HOME_HAND_VALUE = 0;

/**
 * 手部零点的内置默认值（inspire 13 通道，2026-11-16 重置零点后实采；≈ 张开）。
 * 通道顺序与 hands_joint_map('inspire', side) 一致；手型不匹配时回落 HOME_HAND_VALUE。
 */
export const HOME_HAND_VALUES = Object.freeze({
    vendor: 'inspire',
    sides: Object.freeze({
        left: Object.freeze([
            0.002667, 0.002667, 0, 0.5, 0, 0.5,
            0.002667, 0.001333, 0.002667, 0.002667, 0, 0.057143, 0
        ]),
        right: Object.freeze([
            0.001333, 0.002667, 0, 0.5, 0, 0.5,
            0.002667, 0.001333, 0.002667, 0.001333, 0, 0.088571, 0
        ])
    })
});

/**
 * 关节零点（rad）的内置默认值：2026-11-16 面板「重置零点」后从 /robot_state 实采。
 * 面板「重置零点」会用当时的真机姿态覆盖（存 localStorage）；未重置过的关节回落到这里。
 */
export const HOME_JOINT_VALUES = Object.freeze({
    shoulder_pitch_l_joint: 0.178552,
    shoulder_roll_l_joint: 0.101583,
    shoulder_yaw_l_joint: 0.053365,
    elbow_pitch_l_joint: -0.433859,
    elbow_yaw_l_joint: 0.000129,
    wrist_pitch_l_joint: 0.006307,
    wrist_roll_l_joint: 0.001082,
    shoulder_pitch_r_joint: 0.164145,
    shoulder_roll_r_joint: -0.105835,
    shoulder_yaw_r_joint: -0.074032,
    elbow_pitch_r_joint: -0.443235,
    elbow_yaw_r_joint: -0.001071,
    wrist_pitch_r_joint: 0.011203,
    wrist_roll_r_joint: 0.000613,
    head_yaw_joint: 0.000655,
    head_pitch_joint: -0.00065,
    waist_pitch_joint: 0.033148,
    waist_roll_joint: -0.003619,
    waist_yaw_joint: -0.000264
});

/** 遥测超过该时长视为过期：没有真机当前位置就无法做平滑插值。 */
export const TELEMETRY_MAX_AGE_MS = 1500;

/** 轨迹完成回执兜底超时（预计时长 + 该值仍未收到则恢复视口同步）。 */
export const MOTION_DONE_MARGIN_MS = 5000;

const LEG_PATTERN = /(^|_)(hip|knee|ankle)_/;
const HAND_PATTERN = /(thumb|index|middle|ring|pinky)/;
const HEAD_PATTERN = /(^|_)head_/;

/** 关节所属组：优先用设备档案的 group，缺失时按 URDF 关节名推断。 */
export function inferJointGroup(name, joint = null) {
    if (joint?.group) return joint.group;
    if (typeof name !== 'string') return null;
    if (LEG_PATTERN.test(name)) return 'leg';
    if (HAND_PATTERN.test(name)) return HAND_JOINT_GROUP;
    if (HEAD_PATTERN.test(name)) return 'head';
    return null;
}

/** 该组是否属于本模块负责的 joint_targets 上肢集合。 */
export function isUpperBodyGroup(group) {
    // group 缺失（Node 版 profile 没有 group 字段）时按名字推断不出组的关节，
    // 视为臂/腰关节保留；腿/头/手已由名字规则排除。
    return group === null || UPPER_BODY_JOINT_GROUPS.includes(group);
}

/**
 * 从整机位姿中筛出要下发到真机的上肢关节目标。
 *
 * 规则：
 *  - 设备档案声明了 group 的关节：只保留 arm / waist / head（腿、手排除）；
 *  - 设备档案没有任何关节（未知机型）：按 URDF 关节名推断，排除腿/头/手；
 *  - 档案里有其他关节但位姿里出现未声明关节：视为模型专有件，不下发。
 *
 * @param {Record<string, number>} pose 视口位姿（rad）
 * @param {{joints?: Array<{name: string, group?: string, controllable?: boolean}>}} device
 * @returns {{targets: Record<string, number>, ignored: string[]}}
 */
export function selectUpperBodyTargets(pose, device) {
    const targets = {};
    const ignored = [];
    if (!pose || typeof pose !== 'object') return { targets, ignored };

    const joints = new Map();
    for (const joint of device?.joints || []) {
        if (joint?.name) joints.set(joint.name, joint);
    }
    const declared = joints.size > 0;

    for (const [name, value] of Object.entries(pose)) {
        if (!Number.isFinite(value)) continue;
        const joint = joints.get(name);

        if (!joint) {
            if (declared) {
                ignored.push(name);
                continue;
            }
            if (!isUpperBodyGroup(inferJointGroup(name, null))) {
                ignored.push(name);
                continue;
            }
            targets[name] = value;
            continue;
        }

        if (joint.controllable === false) {
            ignored.push(name);
            continue;
        }
        if (!UPPER_BODY_JOINT_GROUPS.includes(inferJointGroup(name, joint))) {
            ignored.push(name);
            continue;
        }
        targets[name] = value;
    }
    return { targets, ignored };
}

/** 设备档案里所有可下发的上肢关节名（用于回零）。 */
export function upperBodyJointNames(device) {
    const names = [];
    const seen = new Set();
    for (const joint of device?.joints || []) {
        if (!joint?.name || seen.has(joint.name)) continue;
        if (joint.controllable === false) continue;
        if (!UPPER_BODY_JOINT_GROUPS.includes(inferJointGroup(joint.name, joint))) continue;
        seen.add(joint.name);
        names.push(joint.name);
    }
    return names;
}

/** 回零目标：未配置 home 值的关节一律回 0 rad。 */
export function homeTargetsFor(names, homeValues = HOME_JOINT_VALUES) {
    const targets = {};
    for (const name of names || []) {
        const value = homeValues?.[name];
        targets[name] = Number.isFinite(value) ? value : 0;
    }
    return targets;
}

export function clampSpeedDeg(value) {
    const deg = Number(value);
    if (!Number.isFinite(deg)) return DEFAULT_SPEED_DEG_S;
    return Math.min(MAX_SPEED_DEG_S, Math.max(MIN_SPEED_DEG_S, deg));
}

export function degToRad(deg) {
    return clampSpeedDeg(deg) * Math.PI / 180;
}

/** 首尾速度为 0 的平滑曲线，最大斜率为 1.5。 */
export function smoothstep(progress) {
    const p = Math.min(1, Math.max(0, Number(progress) || 0));
    return p * p * (3 - 2 * p);
}

/**
 * 规划从真机当前位置到目标的关节轨迹。
 *
 * @param {object} options
 * @param {Record<string, number>} options.from 真机当前角位置（rad），缺失的关节按目标值处理
 * @param {Record<string, number>} options.to 目标角位置（rad）
 * @param {number} options.maxSpeedRadS 峰值角速度（rad/s）
 * @param {number} [options.fps]
 * @param {number} [options.minDurationMs]
 * @returns {{frames: Array<{t: number, targets: Record<string, number>}>,
 *   durationMs: number, peakDeltaRad: number, missingFrom: string[], speedRadS: number}}
 */
export function planJointTrajectory({
    from,
    to,
    maxSpeedRadS,
    fps = TRAJECTORY_FPS,
    minDurationMs = MIN_MOTION_MS
}) {
    const names = Object.keys(to || {}).filter(name => Number.isFinite(to[name]));
    const speed = Number.isFinite(maxSpeedRadS) && maxSpeedRadS > 0
        ? maxSpeedRadS
        : degToRad(DEFAULT_SPEED_DEG_S);
    if (!names.length) {
        return { frames: [], durationMs: 0, peakDeltaRad: 0, missingFrom: [], speedRadS: speed };
    }

    const start = {};
    const delta = {};
    const missingFrom = [];
    let peakDelta = 0;

    for (const name of names) {
        const current = from?.[name];
        if (Number.isFinite(current)) {
            start[name] = current;
        } else {
            missingFrom.push(name);
            start[name] = to[name];
        }
        delta[name] = to[name] - start[name];
        peakDelta = Math.max(peakDelta, Math.abs(delta[name]));
    }

    const rate = Math.max(1, Number(fps) || TRAJECTORY_FPS);
    // smoothstep 最大斜率 1.5：按 1.5 × Δ / v 定时长，瞬时速度不会超过 v。
    const durationMs = Math.max(
        Number.isFinite(minDurationMs) ? minDurationMs : MIN_MOTION_MS,
        Math.ceil((1.5 * peakDelta / speed) * 1000)
    );
    const steps = Math.max(1, Math.round(durationMs / 1000 * rate));

    const frames = [];
    for (let i = 0; i <= steps; i++) {
        const s = smoothstep(i / steps);
        const targets = {};
        for (const name of names) targets[name] = start[name] + delta[name] * s;
        frames.push({ t: Math.round(durationMs * i / steps), targets });
    }
    // 末帧对齐到精确目标，避免浮点残留
    const last = frames[frames.length - 1];
    for (const name of names) last.targets[name] = to[name];

    return { frames, durationMs, peakDeltaRad: peakDelta, missingFrom, speedRadS: speed };
}

/** 手部归一化值的时序插值（0..1 → 桥接内部换算成厂商码）。 */
export function planHandRamp({ from, to, durationMs, hz = HAND_SEND_HZ }) {
    const length = Math.min(from?.length || 0, to?.length || 0);
    if (!length) return { frames: [], durationMs: 0 };
    const duration = Math.max(200, Number(durationMs) || MIN_MOTION_MS);
    const rate = Math.max(1, Number(hz) || HAND_SEND_HZ);
    const steps = Math.max(1, Math.round(duration / 1000 * rate));
    const frames = [];
    for (let i = 0; i <= steps; i++) {
        const s = smoothstep(i / steps);
        const values = [];
        for (let j = 0; j < length; j++) {
            const start = Number.isFinite(from[j]) ? from[j] : 0;
            const end = Number.isFinite(to[j]) ? to[j] : start;
            values.push(start + (end - start) * s);
        }
        frames.push({ t: Math.round(duration * i / steps), values });
    }
    return { frames, durationMs: duration };
}

/** 单个关节值按限位归一化到 0..1（手部通道口径）。 */
export function normalizeJointValue(value, lower, upper) {
    if (!Number.isFinite(value) || !Number.isFinite(lower) || !Number.isFinite(upper)) return null;
    if (upper - lower <= 1e-9) return null;
    return Math.min(1, Math.max(0, (value - lower) / (upper - lower)));
}

/** 归一化 0..1 → 关节角（rad），normalizeJointValue 的逆运算。 */
export function denormalizeJointValue(normalized, lower, upper) {
    if (!Number.isFinite(normalized) || !Number.isFinite(lower) || !Number.isFinite(upper)) return null;
    if (upper - lower <= 1e-9) return null;
    const ratio = Math.min(1, Math.max(0, normalized));
    return lower + ratio * (upper - lower);
}

/**
 * 手部归一化状态 → URDF 手指关节角。
 *
 * @param {object} options
 * @param {object} options.hands welcome.hands（jointMap 顺序 = 通道顺序）
 * @param {Record<string, {lower: number, upper: number}>} options.ranges 模型关节限位
 * @param {{left?: number[], right?: number[]}} options.valuesBySide 归一化读数
 * @returns {{pose: Record<string, number>, matched: number, total: number}}
 */
export function handPoseFromState({ hands, ranges, valuesBySide }) {
    const pose = {};
    let matched = 0;
    let total = 0;

    for (const side of ['left', 'right']) {
        const map = hands?.sides?.[side]?.jointMap;
        const values = valuesBySide?.[side];
        if (!Array.isArray(map) || !map.length || !Array.isArray(values) || !values.length) continue;
        for (let index = 0; index < map.length; index += 1) {
            total += 1;
            const range = ranges?.[map[index]];
            const angle = denormalizeJointValue(values[index], range?.lower, range?.upper);
            if (angle === null) continue;
            pose[map[index]] = angle;
            matched += 1;
        }
    }
    return { pose, matched, total };
}

/**
 * 生成双手的归一化目标（并带上插值起点）。
 *
 * @param {object} options
 * @param {object} options.hands welcome.hands（sides[side].jointMap 的顺序即归一化通道顺序）
 * @param {Record<string, {lower: number, upper: number, value: number}>} options.ranges
 *        模型关节限位与当前值（URDF 名 → {lower, upper, value}）
 * @param {{left?: number[], right?: number[]}} options.startBySide 手部当前归一化读数
 * @param {boolean} [options.home] true 时回 home 目标（未提供 homeValues 则回到张开）
 * @param {{left?: number[], right?: number[]}} [options.homeValues] 已记录的手部 home 归一化值
 * @returns {{vendor: string, sides: Record<string, {from: number[], to: number[], count: number}>,
 *   matched: number, total: number}}
 */
export function planHandMove({ hands, ranges, startBySide, home = false, homeValues = null }) {
    const sides = {};
    let matched = 0;
    let total = 0;
    // 未提供记录值时，手型匹配则用内置的实采零点
    const defaultHome = (!homeValues && hands?.vendor === HOME_HAND_VALUES.vendor)
        ? HOME_HAND_VALUES.sides
        : null;

    for (const side of ['left', 'right']) {
        const map = hands?.sides?.[side]?.jointMap;
        if (!Array.isArray(map) || !map.length) continue;

        const start = Array.isArray(startBySide?.[side]) ? startBySide[side] : null;
        const from = [];
        const to = [];
        for (let index = 0; index < map.length; index += 1) {
            total += 1;
            const fallback = Number.isFinite(start?.[index]) ? start[index] : 0;
            let target = fallback;
            if (home) {
                const captured = homeValues?.[side]?.[index] ?? defaultHome?.[side]?.[index];
                target = Number.isFinite(captured)
                    ? Math.min(1, Math.max(0, captured))
                    : HOME_HAND_VALUE;
            } else {
                const range = ranges?.[map[index]];
                const normalized = normalizeJointValue(range?.value, range?.lower, range?.upper);
                if (normalized === null) {
                    // 模型里没有该手型关节：保持当前读数，计入未匹配
                    from.push(fallback);
                    to.push(fallback);
                    continue;
                }
                target = normalized;
            }
            matched += 1;
            from.push(fallback);
            to.push(target);
        }
        sides[side] = { from, to, count: map.length };
    }

    return { vendor: hands?.vendor || 'none', sides, matched, total };
}
