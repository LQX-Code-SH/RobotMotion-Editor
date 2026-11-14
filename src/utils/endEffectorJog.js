/**
 * 末端键盘 jog 的纯逻辑：按键 → 基座坐标系平移 / 工具轴旋转的增量意图。
 */

/** 每个 tick 的平移步长（米）与旋转步长（弧度）。 */
export const JOG_TRANSLATE_STEP_M = 0.005;  // 5mm / tick
export const JOG_ROTATE_STEP_RAD = 0.026;   // ≈1.5° / tick
/** tick 周期：20Hz。 */
export const JOG_TICK_MS = 50;

/**
 * 平移键映射（机器人基座坐标系，URDF/REP-103：+X 前、+Y 左、+Z 上）。
 * w 前 / s 后 / a 左 / d 右 / q 上 / e 下
 */
export const JOG_TRANSLATE_KEYS = Object.freeze({
    w: { axis: 'x', sign: 1 },
    s: { axis: 'x', sign: -1 },
    a: { axis: 'y', sign: 1 },
    d: { axis: 'y', sign: -1 },
    q: { axis: 'z', sign: 1 },
    e: { axis: 'z', sign: -1 }
});

/**
 * 旋转键映射（绕末端工具坐标系自身的轴）：
 * 1/2 横滚（roll, x）、3/4 俯仰（pitch, y）、5/6 偏航（yaw, z）
 */
export const JOG_ROTATE_KEYS = Object.freeze({
    1: { axis: 'roll', sign: 1 },
    2: { axis: 'roll', sign: -1 },
    3: { axis: 'pitch', sign: 1 },
    4: { axis: 'pitch', sign: -1 },
    5: { axis: 'yaw', sign: 1 },
    6: { axis: 'yaw', sign: -1 }
});

export function normalizeJogKey(key) {
    return String(key ?? '').toLowerCase();
}

export function isJogKey(key) {
    const normalized = normalizeJogKey(key);
    return Object.hasOwn(JOG_TRANSLATE_KEYS, normalized)
        || Object.hasOwn(JOG_ROTATE_KEYS, normalized);
}

function clampUnit(value) {
    return Math.max(-1, Math.min(1, value));
}

/**
 * 汇总当前按住的键。
 *
 * @param {Iterable<string>} pressedKeys
 * @returns {{translation: {x:number,y:number,z:number}, rotation: {roll:number,pitch:number,yaw:number}, active: boolean}}
 */
export function summarizeJog(pressedKeys) {
    const translation = { x: 0, y: 0, z: 0 };
    const rotation = { roll: 0, pitch: 0, yaw: 0 };

    for (const rawKey of pressedKeys || []) {
        const key = normalizeJogKey(rawKey);
        const translate = JOG_TRANSLATE_KEYS[key];
        if (translate) translation[translate.axis] += translate.sign;
        const rotate = JOG_ROTATE_KEYS[key];
        if (rotate) rotation[rotate.axis] += rotate.sign;
    }

    translation.x = clampUnit(translation.x);
    translation.y = clampUnit(translation.y);
    translation.z = clampUnit(translation.z);
    rotation.roll = clampUnit(rotation.roll);
    rotation.pitch = clampUnit(rotation.pitch);
    rotation.yaw = clampUnit(rotation.yaw);

    const active = translation.x !== 0 || translation.y !== 0 || translation.z !== 0
        || rotation.roll !== 0 || rotation.pitch !== 0 || rotation.yaw !== 0;
    return { translation, rotation, active };
}
