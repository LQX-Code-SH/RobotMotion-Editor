/**
 * 视口 → 真机同步控制的纯逻辑（不碰 DOM / WebSocket，便于单测）。
 */

/** 同步下发节流间隔：约 12.5Hz，避免高频占领控制通道。 */
export const SYNC_SEND_INTERVAL_MS = 80;

/** 关节变化阈值（rad / m），小于该值不重复下发。 */
export const SYNC_EPSILON = 1e-4;

/**
 * 从整机位姿中筛出可下发的关节。
 *
 * - 只保留设备档案里存在且 `controllable !== false` 的关节
 * - 腿部由运控独占、手部走独立通道，与「真机回零」保持一致的排除规则
 * - 无设备档案（尚未拿到 welcome）时退回全量有限值
 *
 * @param {Record<string, number>} pose
 * @param {{joints?: Array<{name: string, group?: string, controllable?: boolean}>}} device
 * @returns {Record<string, number>}
 */
export function filterSyncPose(pose, device) {
    const targets = {};
    if (!pose || typeof pose !== 'object') return targets;

    const deviceJoints = Array.isArray(device?.joints) ? device.joints : null;
    if (!deviceJoints || !deviceJoints.length) {
        for (const [name, value] of Object.entries(pose)) {
            if (Number.isFinite(value)) targets[name] = value;
        }
        return targets;
    }

    const allowed = new Set();
    for (const joint of deviceJoints) {
        if (!joint?.name) continue;
        if (joint.controllable === false) continue;
        if (joint.group === 'leg' || joint.group === 'hand') continue;
        allowed.add(joint.name);
    }

    for (const [name, value] of Object.entries(pose)) {
        if (!allowed.has(name)) continue;
        if (!Number.isFinite(value)) continue;
        targets[name] = value;
    }
    return targets;
}

/** 判断两次目标位姿是否存在超过 eps 的变化。 */
export function hasPoseChanged(previous, next, epsilon = SYNC_EPSILON) {
    const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
    for (const key of keys) {
        const before = previous?.[key];
        const after = next?.[key];
        if (!Number.isFinite(before) || !Number.isFinite(after)) return true;
        if (Math.abs(before - after) > epsilon) return true;
    }
    return false;
}
