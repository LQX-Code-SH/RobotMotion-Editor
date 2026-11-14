import * as THREE from 'three';
import { classifyJointPart, isScalarJoint } from '../models/UnifiedRobotModel.js';

/**
 * 笛卡尔空间 IK 的纯数学层。
 *
 * 这里只依赖 three.js 的对象树（关节的 `threeObject` 与末端 link 的世界矩阵），
 * 不读 UI、不写场景状态：调用方负责在迭代之间把关节值写进模型并刷新矩阵。
 * 这样既能复用渲染树的 FK，又能在 node 测试里用普通 Object3D 链验证。
 */

const HAND_PARTS = new Set(['hand', 'leftHand', 'rightHand']);

const _axis = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _jointPos = new THREE.Vector3();
const _eePos = new THREE.Vector3();
const _eeQuat = new THREE.Quaternion();
const _arm = new THREE.Vector3();
const _errorQuat = new THREE.Quaternion();
const _errorQuatInv = new THREE.Quaternion();
const _errorAxis = new THREE.Vector3();

function linkThreeObject(link) {
    return link?.threeObject || null;
}

function jointAxisLocal(joint, out) {
    const axisObject = joint?.threeObject?.axis;
    if (axisObject instanceof THREE.Vector3) {
        return out.copy(axisObject);
    }
    const xyz = joint?.axis?.xyz;
    if (Array.isArray(xyz) && xyz.length >= 3) {
        return out.set(Number(xyz[0]) || 0, Number(xyz[1]) || 0, Number(xyz[2]) || 0);
    }
    return out.set(0, 0, 1);
}

/** 关节轴线在世界坐标系下的单位向量（旋转关节绕自身轴旋转，轴向不受自身角度影响）。 */
export function jointAxisWorld(joint, out = new THREE.Vector3()) {
    jointAxisLocal(joint, out);
    if (out.lengthSq() < 1e-12) out.set(0, 0, 1);
    if (joint?.threeObject) {
        joint.threeObject.getWorldQuaternion(_quat);
        out.applyQuaternion(_quat);
    }
    return out.normalize();
}

// 末端执行器安装面（法兰 / 手爪基座 / TCP）的命名特征
const EE_BASE_PATTERN = /(hand_?base|gripper_?base|tcp|flange|tool_?0|ee_?base|handlink|hand_link)/i;

/**
 * 从腕部 link 沿 fixed 关节向下找末端执行器的安装面 link。
 * 真实模型里腕与手之间常夹着六维力传感器等固定环节（wrist → sixforce → hand_base），
 * 因此需要逐层下探，取第一个命中安装面命名的 link；找不到时按需回退到最近的 fixed 子 link。
 */
function pickEndEffectorBase(linkName, childrenByLink, allowFallback = false, maxDepth = 3) {
    const queue = [{ name: linkName, depth: 0 }];
    const seen = new Set([linkName]);
    let firstFixedChild = null;

    while (queue.length) {
        const { name, depth } = queue.shift();
        if (depth >= maxDepth) continue;
        const fixedChildren = (childrenByLink.get(name) || [])
            .filter((joint) => joint.type === 'fixed' && joint.child);

        for (const joint of fixedChildren) {
            const child = joint.child;
            if (seen.has(child)) continue;
            seen.add(child);
            if (!firstFixedChild) firstFixedChild = child;
            if (EE_BASE_PATTERN.test(child) || EE_BASE_PATTERN.test(joint.name)) return child;
            queue.push({ name: child, depth: depth + 1 });
        }
    }

    return allowFallback ? firstFixedChild : null;
}

function trimHandJoints(linkName, joints, childrenByLink) {
    let eeLink = linkName;
    let trimmedHands = false;
    while (joints.length) {
        const last = joints[joints.length - 1];
        if (!HAND_PARTS.has(classifyJointPart(last.name))) break;
        joints.pop();
        eeLink = last.parent || eeLink;
        trimmedHands = true;
    }
    if (!joints.length) return null;
    // 修剪后末端应取最后一个关节驱动的 link（手腕）
    eeLink = joints[joints.length - 1].child || eeLink;
    // 末端执行器需要以「安装面坐标系」为控制点，而不是腕部旋转中心
    const base = pickEndEffectorBase(eeLink, childrenByLink, trimmedHands);
    if (base) eeLink = base;
    return { eeLink, joints, trimmedHands };
}

/**
 * 从模型里找出各个串联分支的末端执行器链。
 *
 * - 只收集可动关节（revolute / continuous / prismatic），fixed 仅用于穿透
 * - 末端默认取手部关节之下的最后一个 link（手爪/手指不参与 IK）
 * - 闭环机构（model.constraints 非空）标记 isParallel，交给上层做约束投影
 *
 * @param {object} model UnifiedRobotModel
 * @param {{trimHands?: boolean}} options
 */
export function buildChains(model, { trimHands = true } = {}) {
    const links = model?.links;
    const joints = model?.joints;
    if (!links?.size || !joints?.size) return [];

    const childrenByLink = new Map();
    const childLinks = new Set();
    joints.forEach((joint) => {
        if (!joint?.parent || !joint?.child) return;
        if (!links.has(joint.parent) || !links.has(joint.child)) return;
        const list = childrenByLink.get(joint.parent) || [];
        list.push(joint);
        childrenByLink.set(joint.parent, list);
        childLinks.add(joint.child);
    });

    let rootLink = model.rootLink && links.has(model.rootLink) ? model.rootLink : null;
    if (!rootLink) {
        rootLink = Array.from(links.keys()).find((name) => !childLinks.has(name)) || null;
    }
    if (!rootLink) return [];

    const isParallel = Boolean(model.constraints?.size && model.constraintSolver);
    const chains = [];
    const seenEnds = new Set();

    const walk = (linkName, activeJoints, path) => {
        if (path.has(linkName)) return;
        path.add(linkName);

        const children = (childrenByLink.get(linkName) || [])
            .filter((joint) => joint.child && !path.has(joint.child));

        if (!children.length) {
            const trimmed = trimHands
                ? trimHandJoints(linkName, [...activeJoints], childrenByLink)
                : { eeLink: linkName, joints: [...activeJoints] };
            if (trimmed && trimmed.joints.length && !seenEnds.has(trimmed.eeLink)) {
                const eeObject = linkThreeObject(links.get(trimmed.eeLink));
                if (eeObject) {
                    seenEnds.add(trimmed.eeLink);
                    // 点击该分支上的任意 link（含被裁剪的手爪）都应能切换到这条链；
                    // 从第一个「非腰部」关节驱动的 link 起算：腰部为双臂共享，点它不应切换
                    const pathLinks = [...path];
                    const branchRootJoint = trimmed.joints.find(
                        (joint) => classifyJointPart(joint.name) !== 'waist'
                    ) || trimmed.joints[0];
                    const startLink = branchRootJoint.child;
                    const startIndex = Math.max(0, pathLinks.indexOf(startLink));
                    const linkNames = new Set(pathLinks.slice(startIndex));
                    collectDescendantLinks(trimmed.eeLink, linkNames, childrenByLink);
                    chains.push({
                        id: trimmed.eeLink,
                        eeLinkName: trimmed.eeLink,
                        eeObject,
                        joints: trimmed.joints,
                        jointNames: trimmed.joints.map((joint) => joint.name),
                        linkNames,
                        part: classifyJointPart(trimmed.joints[trimmed.joints.length - 1].name),
                        isParallel
                    });
                }
            }
            path.delete(linkName);
            return;
        }

        children.forEach((joint) => {
            if (isScalarJoint(joint) && joint.threeObject) {
                activeJoints.push(joint);
                walk(joint.child, activeJoints, path);
                activeJoints.pop();
            } else if (joint.type === 'fixed') {
                // 固定关节只传递位姿，不贡献自由度
                walk(joint.child, activeJoints, path);
            }
        });

        path.delete(linkName);
    };

    walk(rootLink, [], new Set());

    return chains.sort((a, b) => b.joints.length - a.joints.length);
}

function collectDescendantLinks(linkName, acc, childrenByLink) {
    (childrenByLink.get(linkName) || []).forEach((joint) => {
        if (!joint.child || acc.has(joint.child)) return;
        acc.add(joint.child);
        collectDescendantLinks(joint.child, acc, childrenByLink);
    });
}

/** 通过 link 名称反查它所属的末端链（用于点击零件切换末端）。 */
export function findChainForLink(chains, linkName) {
    if (!linkName) return null;
    return chains.find((chain) => chain.linkNames?.has(linkName)) || null;
}

/** 默认展示的链：优先手臂/手部末端，没有手臂结构时退回全部末端。 */
export function selectArmChains(chains, limit = 4) {
    const armChains = chains.filter((chain) => chain.part === 'arm'
        || chain.part === 'leftArm' || chain.part === 'rightArm'
        || chain.part === 'hand' || chain.part === 'leftHand' || chain.part === 'rightHand');
    const list = armChains.length ? armChains : chains;
    return list.slice(0, limit);
}

/** 当前关节值快照（按链顺序）。 */
export function readChainValues(chain) {
    return chain.joints.map((joint) => Number(joint.currentValue) || 0);
}

/**
 * 几何雅可比（6×N，行优先：0-2 线速度，3-5 角速度）。
 *
 * @param {object} chain buildChains 产出的链
 * @param {Float64Array} [out] 长度至少 6*N 的复用缓冲
 */
export function computeJacobian(chain, out = null) {
    const joints = chain?.joints || [];
    const n = joints.length;
    const size = 6 * n;
    const matrix = out && out.length >= size ? out : new Float64Array(size);
    matrix.fill(0, 0, size);

    const ee = chain?.eeObject;
    if (!ee || !n) return { matrix, columns: n };

    ee.getWorldPosition(_eePos);

    for (let index = 0; index < n; index += 1) {
        const joint = joints[index];
        const jointObject = joint.threeObject;
        if (!jointObject) continue;

        jointObject.getWorldPosition(_jointPos);
        jointAxisWorld(joint, _axis);

        const column = index;
        if (joint.type === 'prismatic') {
            matrix[column] = _axis.x;
            matrix[n + column] = _axis.y;
            matrix[2 * n + column] = _axis.z;
        } else {
            _arm.subVectors(_eePos, _jointPos);
            const linearX = _axis.y * _arm.z - _axis.z * _arm.y;
            const linearY = _axis.z * _arm.x - _axis.x * _arm.z;
            const linearZ = _axis.x * _arm.y - _axis.y * _arm.x;
            matrix[column] = linearX;
            matrix[n + column] = linearY;
            matrix[2 * n + column] = linearZ;
            matrix[3 * n + column] = _axis.x;
            matrix[4 * n + column] = _axis.y;
            matrix[5 * n + column] = _axis.z;
        }
    }

    return { matrix, columns: n };
}

/**
 * 末端位姿误差：位置直接取世界坐标差，姿态取旋转向量（最短弧）。
 *
 * @returns {{positionError: number, rotationError: number, vector: Float64Array}}
 */
export function computePoseError(eeObject, targetPosition, targetQuaternion, { posWeight = 1, rotWeight = 0.25 } = {}) {
    const vector = new Float64Array(6);
    if (!eeObject) {
        return { positionError: Infinity, rotationError: Infinity, vector };
    }

    eeObject.getWorldPosition(_eePos);
    vector[0] = (targetPosition.x - _eePos.x) * posWeight;
    vector[1] = (targetPosition.y - _eePos.y) * posWeight;
    vector[2] = (targetPosition.z - _eePos.z) * posWeight;

    let rotationError = 0;
    if (targetQuaternion) {
        eeObject.getWorldQuaternion(_eeQuat);
        _errorQuatInv.copy(_eeQuat).invert();
        _errorQuat.copy(targetQuaternion).multiply(_errorQuatInv);
        if (_errorQuat.w < 0) {
            _errorQuat.set(-_errorQuat.x, -_errorQuat.y, -_errorQuat.z, -_errorQuat.w);
        }
        const sinHalf = Math.hypot(_errorQuat.x, _errorQuat.y, _errorQuat.z);
        rotationError = 2 * Math.atan2(sinHalf, _errorQuat.w);
        if (sinHalf > 1e-8) {
            _errorAxis.set(_errorQuat.x, _errorQuat.y, _errorQuat.z).divideScalar(sinHalf);
        } else {
            _errorAxis.set(0, 0, 0);
        }
        vector[3] = _errorAxis.x * rotationError * rotWeight;
        vector[4] = _errorAxis.y * rotationError * rotWeight;
        vector[5] = _errorAxis.z * rotationError * rotWeight;
    }

    return {
        positionError: Math.hypot(vector[0], vector[1], vector[2]) / (posWeight || 1),
        rotationError,
        vector
    };
}

/** 关节角是否被限位约束（continuous 不约束）。 */
function jointBounds(joint, ignoreLimits) {
    if (ignoreLimits || joint.type === 'continuous' || !joint.limits) {
        return { lower: -Infinity, upper: Infinity };
    }
    const lower = Number.isFinite(joint.limits.lower) ? joint.limits.lower : -Infinity;
    const upper = Number.isFinite(joint.limits.upper) ? joint.limits.upper : Infinity;
    return lower <= upper ? { lower, upper } : { lower: upper, upper: lower };
}

/** Cholesky 分解求 A x = b（A 为对称正定，行优先就地修改）。 */
function solveSymmetricPositiveDefinite(A, b, n) {
    const x = new Float64Array(n);
    if (!n) return x;

    for (let i = 0; i < n; i += 1) {
        for (let j = 0; j <= i; j += 1) {
            let sum = A[i * n + j];
            for (let k = 0; k < j; k += 1) sum -= A[i * n + k] * A[j * n + k];
            if (i === j) {
                A[i * n + j] = Math.sqrt(Math.max(sum, 1e-12));
            } else {
                A[i * n + j] = sum / (A[j * n + j] || 1e-12);
            }
        }
    }

    const y = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
        let sum = b[i];
        for (let k = 0; k < i; k += 1) sum -= A[i * n + k] * y[k];
        y[i] = sum / (A[i * n + i] || 1e-12);
    }
    for (let i = n - 1; i >= 0; i -= 1) {
        let sum = y[i];
        for (let k = i + 1; k < n; k += 1) sum -= A[k * n + i] * x[k];
        x[i] = sum / (A[i * n + i] || 1e-12);
    }
    return x;
}

/**
 * 一步 DLS + 一阶 active-set 求解。
 *
 * 解 (JᵀJ + λ²I)δq = Jᵀe；触碰限位且仍被推向限位的关节会被冻结后重解（最多 3 轮），
 * 因此限位不会把误差硬摊给其他关节。接口与 QP 版本保持一致，将来可整体替换。
 */
export function solveStep({
    jacobian,
    error,
    joints,
    values,
    damping = 0.02,
    maxStep = 0.2,
    ignoreLimits = false,
    lockedIndices = null,
    maxActiveIterations = 3
}) {
    const n = joints?.length || 0;
    const delta = new Float64Array(n);
    if (!n || !jacobian?.matrix) {
        return { delta, active: new Set(), clamped: false, newlyClamped: 0 };
    }

    const J = jacobian.matrix;
    const lambdaSq = damping * damping;
    // 锁定的关节（如腰部）一开始就进入 active-set，不参与求解
    const active = new Set(lockedIndices ? Array.from(lockedIndices) : []);
    let clamped = false;
    let newlyClamped = 0;

    for (let pass = 0; pass < maxActiveIterations; pass += 1) {
        const free = [];
        for (let i = 0; i < n; i += 1) if (!active.has(i)) free.push(i);
        if (!free.length) break;

        const m = free.length;
        const AtA = new Float64Array(m * m);
        const Atb = new Float64Array(m);

        for (let a = 0; a < m; a += 1) {
            const ia = free[a];
            let diag = lambdaSq;
            for (let row = 0; row < 6; row += 1) {
                const value = J[row * n + ia];
                diag += value * value;
                Atb[a] += value * error[row];
            }
            AtA[a * m + a] = diag;

            for (let b = a + 1; b < m; b += 1) {
                const ib = free[b];
                let sum = 0;
                for (let row = 0; row < 6; row += 1) sum += J[row * n + ia] * J[row * n + ib];
                AtA[a * m + b] = sum;
                AtA[b * m + a] = sum;
            }
        }

        const solved = solveSymmetricPositiveDefinite(AtA, Atb, m);
        free.forEach((index, position) => {
            delta[index] = solved[position];
        });

        let maxAbs = 0;
        delta.forEach((value) => { maxAbs = Math.max(maxAbs, Math.abs(value)); });
        if (maxAbs > maxStep) {
            const scale = maxStep / maxAbs;
            for (let i = 0; i < n; i += 1) delta[i] *= scale;
            clamped = true;
        }

        let added = false;
        for (let index = 0; index < n; index += 1) {
            if (active.has(index)) continue;
            const joint = joints[index];
            const bounds = jointBounds(joint, ignoreLimits);
            const next = values[index] + delta[index];
            if (next > bounds.upper) {
                delta[index] = bounds.upper - values[index];
                active.add(index);
                added = true;
                clamped = true;
                newlyClamped += 1;
            } else if (next < bounds.lower) {
                delta[index] = bounds.lower - values[index];
                active.add(index);
                added = true;
                clamped = true;
                newlyClamped += 1;
            }
        }

        if (!added) break;
        // 冻结的关节在下一轮重解，先把它们的增量清掉
        active.forEach((index) => { delta[index] = 0; });
    }

    return { delta, active, clamped, newlyClamped };
}

/**
 * 迭代求解整条链，直到位姿误差进入容差或用完迭代次数。
 *
 * @param {object} options
 * @param {Function} options.applyValues (values: number[]) => void，负责写入关节并刷新世界矩阵
 */
export function solveChain({
    chain,
    targetPosition,
    targetQuaternion,
    applyValues,
    maxIterations = 20,
    posTolerance = 1e-3,
    rotTolerance = 1e-2,
    posWeight = 1,
    rotWeight = 0.25,
    damping = 0.02,
    maxStep = 0.2,
    ignoreLimits = false,
    lockedJointNames = null,
    jacobianBuffer = null
}) {
    if (!chain?.eeObject || !chain.joints?.length) {
        return { converged: false, positionError: Infinity, rotationError: Infinity, iterations: 0, clampCount: 0 };
    }

    const joints = chain.joints;
    const lockedIndices = new Set();
    if (lockedJointNames?.length) {
        joints.forEach((joint, index) => {
            if (lockedJointNames.includes(joint.name)) lockedIndices.add(index);
        });
    }
    let values = readChainValues(chain);
    const buffer = jacobianBuffer || new Float64Array(6 * joints.length);

    let positionError = Infinity;
    let rotationError = Infinity;
    let iterations = 0;
    let clampCount = 0;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        const pose = computePoseError(chain.eeObject, targetPosition, targetQuaternion, { posWeight, rotWeight });
        positionError = pose.positionError;
        rotationError = pose.rotationError;
        if (positionError <= posTolerance && rotationError <= rotTolerance) {
            return { converged: true, positionError, rotationError, iterations, clampCount };
        }

        const jacobian = computeJacobian(chain, buffer);
        const step = solveStep({
            jacobian,
            error: pose.vector,
            joints,
            values,
            damping,
            maxStep,
            ignoreLimits,
            lockedIndices
        });
        iterations = iteration + 1;

        clampCount += step.newlyClamped;
        if (Array.from(step.delta).every((value) => Math.abs(value) < 1e-9)) break;

        values = values.map((value, index) => {
            const bounds = jointBounds(joints[index], ignoreLimits);
            return Math.max(bounds.lower, Math.min(bounds.upper, value + step.delta[index]));
        });
        applyValues?.(values);
    }

    const finalPose = computePoseError(chain.eeObject, targetPosition, targetQuaternion, { posWeight, rotWeight });
    return {
        converged: finalPose.positionError <= posTolerance && finalPose.rotationError <= rotTolerance,
        positionError: finalPose.positionError,
        rotationError: finalPose.rotationError,
        iterations,
        clampCount
    };
}

export { jointBounds };
