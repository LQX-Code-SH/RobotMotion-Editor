import test from 'node:test';
import assert from 'node:assert/strict';
import {
    filterSyncPose,
    hasPoseChanged,
    SYNC_EPSILON
} from '../../src/robot/robotSync.js';

const device = {
    joints: [
        { name: 'waist_yaw_joint', group: 'waist', controllable: true },
        { name: 'head_yaw_joint', group: 'head', controllable: true },
        { name: 'hip_pitch_l_joint', group: 'leg', controllable: true },
        { name: 'L_index_joint', group: 'hand', controllable: true },
        { name: 'locked_joint', group: 'arm', controllable: false }
    ]
};

test('filterSyncPose keeps controllable non-leg non-hand joints', () => {
    const pose = {
        waist_yaw_joint: 0.2,
        head_yaw_joint: -0.1,
        hip_pitch_l_joint: 0.5,
        L_index_joint: 0.3,
        locked_joint: 0.1,
        unknown_joint: 1
    };

    assert.deepEqual(filterSyncPose(pose, device), {
        waist_yaw_joint: 0.2,
        head_yaw_joint: -0.1
    });
});

test('filterSyncPose falls back to the full pose without a device profile', () => {
    const pose = { waist_yaw_joint: 0.2, other_joint: 1, broken: Number.NaN };
    assert.deepEqual(filterSyncPose(pose, null), {
        waist_yaw_joint: 0.2,
        other_joint: 1
    });
});

test('filterSyncPose tolerates empty input', () => {
    assert.deepEqual(filterSyncPose(null, device), {});
    assert.deepEqual(filterSyncPose({}, { joints: [] }), {});
});

test('hasPoseChanged ignores sub-epsilon jitter and detects real changes', () => {
    const base = { a: 0.1, b: -0.2 };
    assert.equal(hasPoseChanged(base, { a: 0.1 + SYNC_EPSILON / 2, b: -0.2 }), false);
    assert.equal(hasPoseChanged(base, { a: 0.1 + SYNC_EPSILON * 10, b: -0.2 }), true);
    assert.equal(hasPoseChanged(base, { a: 0.1 }), true, 'missing key counts as change');
    assert.equal(hasPoseChanged({}, {}), false);
});

test('hasPoseChanged treats non-numeric values as changed', () => {
    assert.equal(hasPoseChanged({ a: 0 }, { a: Number.NaN }), true);
    assert.equal(hasPoseChanged({ a: 0 }, { a: undefined }), true);
});
