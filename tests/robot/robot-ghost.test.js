import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyJointGhost, computeJointGhostBase } from '../../src/robot/RobotGhost.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function roundTrip({ type, axis, displacement, quaternion = new THREE.Quaternion(), position = new THREE.Vector3() }) {
    const base = computeJointGhostBase({ type, quaternion, position, axis, displacement });
    const outQuaternion = new THREE.Quaternion();
    const outPosition = new THREE.Vector3();
    applyJointGhost({
        type,
        baseQuaternion: base.baseQuaternion,
        basePosition: base.basePosition,
        axis,
        displacement,
        outQuaternion,
        outPosition
    });
    return { outQuaternion, outPosition };
}

test('revolute round-trip recovers the original joint pose', () => {
    const axis = new THREE.Vector3(0, 0, 1);
    const quaternion = new THREE.Quaternion().setFromAxisAngle(axis, 0.7);
    const { outQuaternion } = roundTrip({ type: 'revolute', axis, displacement: 0.7, quaternion });

    assert.ok(near(outQuaternion.x, quaternion.x));
    assert.ok(near(outQuaternion.y, quaternion.y));
    assert.ok(near(outQuaternion.z, quaternion.z));
    assert.ok(near(Math.abs(outQuaternion.w), Math.abs(quaternion.w)));
});

test('revolute composes with a non-identity mounting rotation', () => {
    const axis = new THREE.Vector3(0, 1, 0);
    const mount = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.4, 0.2));
    const quaternion = mount.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, -0.9));
    const { outQuaternion } = roundTrip({ type: 'revolute', axis, displacement: -0.9, quaternion });

    assert.ok(outQuaternion.angleTo(quaternion) < 1e-6);
});

test('continuous joints follow the revolute path', () => {
    const axis = new THREE.Vector3(1, 0, 0);
    const quaternion = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI * 1.5);
    const { outQuaternion } = roundTrip({ type: 'continuous', axis, displacement: Math.PI * 1.5, quaternion });
    assert.ok(outQuaternion.angleTo(quaternion) < 1e-6);
});

test('prismatic joints translate along the axis', () => {
    const axis = new THREE.Vector3(0, 0, 1);
    const position = new THREE.Vector3(0.1, 0.2, 0.45);
    const { outPosition } = roundTrip({ type: 'prismatic', axis, displacement: 0.35, position });
    assert.ok(outPosition.distanceTo(position) < 1e-12);
});

test('ghost pose is independent of the current model angle', () => {
    const axis = new THREE.Vector3(0, 0, 1);
    // 模型当前处于 0.4rad，真机报到 -0.2rad：基准应能消除模型角度
    const modelQuaternion = new THREE.Quaternion().setFromAxisAngle(axis, 0.4);
    const base = computeJointGhostBase({
        type: 'revolute',
        quaternion: modelQuaternion,
        position: new THREE.Vector3(),
        axis,
        displacement: 0.4
    });
    const out = new THREE.Quaternion();
    applyJointGhost({
        type: 'revolute',
        baseQuaternion: base.baseQuaternion,
        basePosition: base.basePosition,
        axis,
        displacement: -0.2,
        outQuaternion: out,
        outPosition: new THREE.Vector3()
    });
    assert.ok(out.angleTo(new THREE.Quaternion().setFromAxisAngle(axis, -0.2)) < 1e-6);
});
