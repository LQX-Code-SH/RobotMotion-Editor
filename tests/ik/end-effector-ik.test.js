import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
    buildChains,
    computeJacobian,
    computePoseError,
    findChainForLink,
    selectArmChains,
    solveChain
} from '../../src/utils/kinematics.js';

/**
 * 合成一条平面 N 连杆臂：每个关节绕 +z 旋转，杆长 1m。
 * 返回链、根节点与"把关节值写回 Object3D"的应用函数。
 */
function createPlanarArm({ lengths = [1, 1], limits = null } = {}) {
    const root = new THREE.Object3D();
    const joints = [];
    let parent = root;

    lengths.forEach((length, index) => {
        const jointObject = new THREE.Object3D();
        parent.add(jointObject);
        const linkObject = new THREE.Object3D();
        linkObject.position.set(length, 0, 0);
        jointObject.add(linkObject);
        parent = linkObject;

        joints.push({
            name: `j${index + 1}`,
            type: 'revolute',
            parent: index === 0 ? 'base' : `l${index}`,
            child: `l${index + 1}`,
            axis: { xyz: [0, 0, 1] },
            threeObject: jointObject,
            currentValue: 0,
            limits: limits ? { ...limits } : null
        });
    });

    const eeObject = new THREE.Object3D();
    parent.add(eeObject);
    root.updateMatrixWorld(true);

    const applyValues = (values) => {
        joints.forEach((joint, index) => {
            joint.threeObject.rotation.z = values[index];
            joint.currentValue = values[index];
        });
        root.updateMatrixWorld(true);
    };

    const chain = {
        id: 'ee',
        eeLinkName: 'ee',
        eeObject,
        joints,
        jointNames: joints.map((joint) => joint.name),
        part: 'leftArm',
        isParallel: false
    };

    return { chain, root, applyValues, joints };
}

function linkObject(name, parent = null) {
    const object = new THREE.Object3D();
    object.name = name;
    const link = { name, threeObject: object };
    if (parent) parent.add(object);
    return link;
}

function jointObject(name, parent, child, type = 'revolute') {
    return {
        name,
        parent,
        child,
        type,
        axis: { xyz: [0, 0, 1] },
        threeObject: new THREE.Object3D(),
        limits: { lower: -Math.PI, upper: Math.PI },
        currentValue: 0
    };
}

test('buildChains trims hand joints and keeps the wrist as end effector', () => {
    const links = new Map();
    ['base', 'l1', 'l2', 'L_hand', 'L_finger', 'tip'].forEach((name) => {
        links.set(name, linkObject(name));
    });
    const joints = new Map();
    [
        jointObject('j1', 'base', 'l1'),
        jointObject('L_shoulder_pitch', 'l1', 'l2'),
        jointObject('L_hand_pitch', 'l2', 'L_hand'),
        jointObject('L_finger_1', 'L_hand', 'L_finger'),
        jointObject('tip_fixed', 'L_finger', 'tip', 'fixed')
    ].forEach((joint) => joints.set(joint.name, joint));

    const model = {
        links,
        joints,
        constraints: new Map(),
        constraintSolver: null,
        rootLink: 'base'
    };

    const chains = buildChains(model);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].eeLinkName, 'l2');
    assert.deepEqual(chains[0].jointNames, ['j1', 'L_shoulder_pitch']);
    assert.equal(chains[0].part, 'leftArm');
    assert.equal(chains[0].isParallel, false);

    // 点击手腕/手掌/手指都应归到这条链
    ['l1', 'l2', 'L_hand', 'L_finger', 'tip'].forEach((linkName) => {
        assert.equal(findChainForLink(chains, linkName)?.id, 'l2', `${linkName} maps to chain`);
    });
    assert.equal(findChainForLink(chains, 'base'), null);
});

test('buildChains uses the end-effector mounting frame instead of the wrist', () => {
    const links = new Map();
    ['base', 'l1', 'l2', 'left_hand_base', 'left_hand_palm', 'finger'].forEach((name) => {
        links.set(name, linkObject(name));
    });
    const joints = new Map();
    [
        jointObject('j1', 'base', 'l1'),
        jointObject('elbow_pitch_l_joint', 'l1', 'l2'),
        jointObject('left_tcp_to_left_hand_base_joint', 'l2', 'left_hand_base', 'fixed'),
        jointObject('left_hand_palm_joint', 'left_hand_base', 'left_hand_palm', 'fixed'),
        jointObject('left_thumb_yaw_joint', 'left_hand_palm', 'finger')
    ].forEach((joint) => joints.set(joint.name, joint));

    const model = {
        links,
        joints,
        constraints: new Map(),
        constraintSolver: null,
        rootLink: 'base'
    };

    const chains = buildChains(model);
    assert.equal(chains.length, 1);
    // 控制点应是手爪安装面，而不是腕部旋转中心，也不深入手掌
    assert.equal(chains[0].eeLinkName, 'left_hand_base');
    assert.deepEqual(chains[0].jointNames, ['j1', 'elbow_pitch_l_joint']);
});

test('buildChains walks past a wrist force sensor to the hand base', () => {
    const links = new Map();
    ['base', 'l1', 'L_wrist_roll_link', 'L_sixforce_link', 'L_hand_base_link'].forEach((name) => {
        links.set(name, linkObject(name));
    });
    const joints = new Map();
    [
        jointObject('j1', 'base', 'l1'),
        jointObject('wrist_roll_joint', 'l1', 'L_wrist_roll_link'),
        jointObject('L_sixforce_joint', 'L_wrist_roll_link', 'L_sixforce_link', 'fixed'),
        jointObject('L_wrist_roll_link_to_L_hand_base_link', 'L_sixforce_link', 'L_hand_base_link', 'fixed')
    ].forEach((joint) => joints.set(joint.name, joint));

    const model = {
        links,
        joints,
        constraints: new Map(),
        constraintSolver: null,
        rootLink: 'base'
    };

    const chains = buildChains(model);
    assert.equal(chains[0].eeLinkName, 'L_hand_base_link');
    assert.deepEqual(chains[0].jointNames, ['j1', 'wrist_roll_joint']);
});

test('buildChains ignores a fixed camera bracket at the wrist', () => {
    const links = new Map();
    ['base', 'l1', 'camera_link'].forEach((name) => links.set(name, linkObject(name)));
    const joints = new Map();
    [
        jointObject('j1', 'base', 'l1'),
        jointObject('wrist_camera_joint', 'l1', 'camera_link', 'fixed')
    ].forEach((joint) => joints.set(joint.name, joint));

    const model = {
        links,
        joints,
        constraints: new Map(),
        constraintSolver: null,
        rootLink: 'base'
    };

    const chains = buildChains(model);
    // camera_link 不是工具安装面，保持腕部 link
    assert.equal(chains[0].eeLinkName, 'l1');
});

test('buildChains marks closed-chain models as parallel', () => {
    const links = new Map([
        ['base', linkObject('base')],
        ['l1', linkObject('l1')]
    ]);
    const joints = new Map([['j1', jointObject('j1', 'base', 'l1')]]);
    const model = {
        links,
        joints,
        constraints: new Map([['loop', { name: 'loop', type: 'connect' }]]),
        constraintSolver: { applyConstraints() {} },
        rootLink: 'base'
    };

    const chains = buildChains(model);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].isParallel, true);
});

test('selectArmChains prefers arm branches over other leaves', () => {
    const arm = { id: 'wrist', part: 'leftArm' };
    const leg = { id: 'foot', part: 'leftLeg' };
    assert.deepEqual(selectArmChains([leg, arm]), [arm]);
    assert.deepEqual(selectArmChains([leg]), [leg]);
});

test('computeJacobian matches a planar two-link arm', () => {
    const { chain } = createPlanarArm();
    const { matrix, columns } = computeJacobian(chain);
    assert.equal(columns, 2);

    // 行 0-2 线速度、行 3-5 角速度；每行 n 列
    const n = 2;
    // 第一关节：轴 z，r=(2,0,0) → 线速度 (0,2,0)，角速度 (0,0,1)
    assert.equal(matrix[0], 0);
    assert.equal(matrix[n + 0], 2);
    assert.equal(matrix[5 * n + 0], 1);

    // 第二关节：轴 z，r=(1,0,0) → 线速度 (0,1,0)，角速度 (0,0,1)
    assert.equal(matrix[1], 0);
    assert.equal(matrix[n + 1], 1);
    assert.equal(matrix[5 * n + 1], 1);
});

test('solveChain converges to a reachable target', () => {
    const { chain, applyValues } = createPlanarArm();
    const target = new THREE.Vector3(1.2, 0.8, 0);
    const result = solveChain({
        chain,
        targetPosition: target,
        targetQuaternion: null,
        applyValues,
        posTolerance: 1e-3,
        rotWeight: 0
    });

    assert.equal(result.converged, true);
    assert.ok(result.positionError <= 1e-3, `position error ${result.positionError}`);

    const worldPosition = new THREE.Vector3();
    chain.eeObject.getWorldPosition(worldPosition);
    assert.ok(worldPosition.distanceTo(target) <= 2e-3);
});

test('solveChain respects joint limits without producing NaN', () => {
    const { chain, applyValues, joints } = createPlanarArm({
        limits: { lower: -0.05, upper: 0.05 }
    });
    const result = solveChain({
        chain,
        targetPosition: new THREE.Vector3(1.5, 1.5, 0),
        targetQuaternion: null,
        applyValues,
        rotWeight: 0
    });

    assert.equal(result.converged, false);
    assert.ok(result.clampCount > 0);
    joints.forEach((joint) => {
        assert.ok(Number.isFinite(joint.currentValue));
        assert.ok(joint.currentValue >= -0.0501 && joint.currentValue <= 0.0501);
    });
});

test('solveChain freezes a limited middle joint and compensates with the rest', () => {
    const { chain, applyValues, joints } = createPlanarArm({ lengths: [1, 1, 1] });
    joints[1].limits = { lower: 0, upper: 0 };

    const target = new THREE.Vector3(1.4, 1.1, 0);
    const initialError = (() => {
        const pose = computePoseError(chain.eeObject, target, null, { posWeight: 1, rotWeight: 0 });
        return pose.positionError;
    })();

    const result = solveChain({
        chain,
        targetPosition: target,
        targetQuaternion: null,
        applyValues,
        maxIterations: 40,
        rotWeight: 0
    });

    assert.ok(Math.abs(joints[1].currentValue) <= 1e-6, 'locked joint stays at 0');
    assert.ok(result.positionError < initialError, 'remaining joints reduce the error');
    assert.ok(joints[0].currentValue !== 0 || joints[2].currentValue !== 0);
});

test('locked joints stay fixed while the rest of the chain solves', () => {
    const { chain, applyValues, joints } = createPlanarArm({ lengths: [1, 1, 1] });
    const locked = joints[0];
    const before = locked.currentValue;

    const result = solveChain({
        chain,
        targetPosition: new THREE.Vector3(1.4, 1.1, 0),
        targetQuaternion: null,
        applyValues,
        rotWeight: 0,
        lockedJointNames: [locked.name]
    });

    assert.equal(locked.currentValue, before, 'locked joint keeps its value');
    assert.ok(joints[1].currentValue !== 0 || joints[2].currentValue !== 0);
    assert.ok(Number.isFinite(result.positionError));
});

test('locking every joint leaves the pose untouched', () => {
    const { chain, applyValues, joints } = createPlanarArm();
    solveChain({
        chain,
        targetPosition: new THREE.Vector3(0.5, 1.5, 0),
        targetQuaternion: null,
        applyValues,
        rotWeight: 0,
        lockedJointNames: joints.map((joint) => joint.name)
    });

    joints.forEach((joint) => {
        assert.equal(joint.currentValue, 0);
    });
});

test('empty chain and missing end effector degrade gracefully', () => {
    const result = solveChain({
        chain: { eeObject: null, joints: [] },
        targetPosition: new THREE.Vector3(),
        targetQuaternion: null
    });
    assert.equal(result.converged, false);

    const pose = computePoseError(null, new THREE.Vector3(), new THREE.Quaternion());
    assert.equal(pose.positionError, Infinity);
});
