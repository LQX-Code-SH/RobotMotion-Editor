import test from 'node:test';
import assert from 'node:assert/strict';
import {
    HOME_HAND_VALUES,
    HOME_JOINT_VALUES,
    clampSpeedDeg,
    degToRad,
    handPoseFromState,
    homeTargetsFor,
    normalizeJointValue,
    planHandMove,
    planHandRamp,
    planJointTrajectory,
    selectUpperBodyTargets,
    smoothstep,
    upperBodyJointNames
} from '../../src/robot/robotMotion.js';

const device = {
    joints: [
        { name: 'shoulder_pitch_l_joint', group: 'arm', controllable: true },
        { name: 'waist_yaw_joint', group: 'waist', controllable: true },
        { name: 'head_yaw_joint', group: 'head', controllable: true },
        { name: 'hip_pitch_l_joint', group: 'leg', controllable: true },
        { name: 'left_index_proximal_joint', group: 'hand', controllable: false }
    ]
};

test('selectUpperBodyTargets keeps arms, waist and head', () => {
    const pose = {
        shoulder_pitch_l_joint: 0.4,
        waist_yaw_joint: -0.2,
        head_yaw_joint: 0.3,
        hip_pitch_l_joint: 0.6,
        left_index_proximal_joint: 0.5,
        spine_joint: 1
    };
    const { targets, ignored } = selectUpperBodyTargets(pose, device);
    assert.deepEqual(targets, {
        shoulder_pitch_l_joint: 0.4,
        waist_yaw_joint: -0.2,
        head_yaw_joint: 0.3
    });
    assert.deepEqual(ignored.sort(), [
        'hip_pitch_l_joint',
        'left_index_proximal_joint',
        'spine_joint'
    ].sort());
});

test('selectUpperBodyTargets infers groups by name when profile has no group', () => {
    const pose = {
        shoulder_pitch_l_joint: 0.4,
        waist_pitch_joint: 0.1,
        hip_pitch_l_joint: 0.6,
        knee_pitch_r_joint: 0.2,
        head_pitch_joint: 0.1,
        left_thumb_proximal_joint: 0.3
    };
    const { targets } = selectUpperBodyTargets(pose, { joints: [] });
    assert.deepEqual(targets, {
        shoulder_pitch_l_joint: 0.4,
        waist_pitch_joint: 0.1,
        head_pitch_joint: 0.1
    });
});

test('upperBodyJointNames excludes legs and hands', () => {
    assert.deepEqual(upperBodyJointNames(device),
        ['shoulder_pitch_l_joint', 'waist_yaw_joint', 'head_yaw_joint']);
});

test('homeTargetsFor defaults to 0 and honours overrides', () => {
    assert.deepEqual(homeTargetsFor(['a', 'b']), { a: 0, b: 0 });
    assert.deepEqual(homeTargetsFor(['a'], { a: -0.5 }), { a: -0.5 });
    assert.equal(HOME_JOINT_VALUES.a, undefined);
});

test('clampSpeedDeg clamps into the safe range', () => {
    assert.equal(clampSpeedDeg(0), 5);
    assert.equal(clampSpeedDeg(1000), 45);
    assert.equal(clampSpeedDeg('bad'), 20);
    assert.equal(clampSpeedDeg(30), 30);
});

test('smoothstep has zero velocity at both ends', () => {
    assert.equal(smoothstep(0), 0);
    assert.equal(smoothstep(1), 1);
    assert.equal(smoothstep(0.5), 0.5);
    assert.ok(Math.abs(smoothstep(0.01) + smoothstep(0.99) - 1) < 1e-6);
});

test('planJointTrajectory starts at the real position, ends at target, respects peak speed', () => {
    const from = { a: -1.2, b: 0.4 };
    const to = { a: 1.2, b: -0.2 };
    const maxSpeed = 0.4;
    const plan = planJointTrajectory({ from, to, maxSpeedRadS: maxSpeed });
    const frames = plan.frames;

    assert.ok(frames.length > 2);
    assert.equal(frames[0].t, 0);
    assert.deepEqual(frames[0].targets, from);
    assert.deepEqual(frames[frames.length - 1].targets, to);
    assert.equal(frames[frames.length - 1].t, plan.durationMs);
    // 1.5 × 2.4 / 0.4 = 9s
    assert.ok(Math.abs(plan.durationMs - 9000) <= 40);
    assert.deepEqual(plan.missingFrom, []);

    for (let i = 1; i < frames.length; i++) {
        const dt = (frames[i].t - frames[i - 1].t) / 1000;
        if (dt <= 0) continue;
        for (const name of ['a', 'b']) {
            const speed = Math.abs(frames[i].targets[name] - frames[i - 1].targets[name]) / dt;
            assert.ok(speed <= maxSpeed * 1.05, `${name} 峰值速度 ${speed} 超出 ${maxSpeed}`);
        }
    }
});

test('planJointTrajectory honours the minimum duration and missing telemetry', () => {
    const plan = planJointTrajectory({
        from: { a: 0.1 },
        to: { a: 0.1001, b: 0.5 },
        maxSpeedRadS: 1
    });
    assert.equal(plan.durationMs, 600);
    assert.deepEqual(plan.missingFrom, ['b']);
    assert.equal(plan.frames[0].targets.b, 0.5, 'unknown start falls back to target');
    assert.equal(plan.frames[plan.frames.length - 1].targets.b, 0.5);
});

test('planJointTrajectory handles an empty target set', () => {
    const plan = planJointTrajectory({ from: {}, to: {}, maxSpeedRadS: 0.4 });
    assert.deepEqual(plan.frames, []);
    assert.equal(plan.durationMs, 0);
});

test('planHandRamp interpolates smoothly between normalized poses', () => {
    const ramp = planHandRamp({ from: [0, 0.2], to: [1, 0.6], durationMs: 1000, hz: 20 });
    assert.equal(ramp.frames[0].values[0], 0);
    assert.equal(ramp.frames.at(-1).values[0], 1);
    assert.ok(Math.abs(ramp.frames.at(-1).values[1] - 0.6) < 1e-9);
    for (let i = 1; i < ramp.frames.length; i++) {
        assert.ok(ramp.frames[i].values[0] >= ramp.frames[i - 1].values[0]);
        assert.ok(ramp.frames[i].values[1] >= ramp.frames[i - 1].values[1]);
    }
});

test('normalizeJointValue maps limits to 0..1 and rejects invalid ranges', () => {
    assert.equal(normalizeJointValue(0, 0, 1.5), 0);
    assert.equal(normalizeJointValue(1.5, 0, 1.5), 1);
    assert.ok(Math.abs(normalizeJointValue(0, -0.2, 0.2) - 0.5) < 1e-12);
    assert.equal(normalizeJointValue(5, 0, 1.5), 1);
    assert.equal(normalizeJointValue(Number.NaN, 0, 1), null);
    assert.equal(normalizeJointValue(0.5, 1, 1), null);
});

test('planHandMove builds per-side normalized targets from the welcome jointMap', () => {
    const hands = {
        vendor: 'inspire',
        sides: {
            left: { jointMap: ['left_index_mcp_joint', 'left_index_yaw_joint'] },
            right: { jointMap: ['right_index_mcp_joint'] }
        }
    };
    const ranges = {
        left_index_mcp_joint: { lower: 0, upper: 1.3, value: 0.65 },
        left_index_yaw_joint: { lower: -0.26118, upper: 0.26118, value: 0 },
        right_index_mcp_joint: { lower: 0, upper: 1.3, value: 1.3 }
    };
    const plan = planHandMove({
        hands,
        ranges,
        startBySide: { left: [0, 0], right: [0] }
    });
    const rounded = values => values.map(value => Math.round(value * 1e6) / 1e6);
    assert.equal(plan.matched, 3);
    assert.equal(plan.total, 3);
    assert.deepEqual(rounded(plan.sides.left.to), [0.5, 0.5]);
    assert.deepEqual(rounded(plan.sides.right.to), [1]);
    assert.deepEqual(plan.sides.left.from, [0, 0]);
});

test('planHandMove keeps unmatched joints and supports home (open hand)', () => {
    const hands = {
        vendor: 'brainco',
        sides: { left: { jointMap: ['left_index_proximal_joint'] } }
    };
    const unmatched = planHandMove({
        hands,
        ranges: {},
        startBySide: { left: [0.7] }
    });
    assert.equal(unmatched.matched, 0);
    assert.deepEqual(unmatched.sides.left.to, [0.7], '保持当前读数');

    const home = planHandMove({
        hands,
        ranges: {},
        startBySide: { left: [0.7] },
        home: true
    });
    assert.equal(home.matched, 1);
    assert.deepEqual(home.sides.left.from, [0.7]);
    assert.deepEqual(home.sides.left.to, [0], '回零时手部张开');
});

test('planHandMove home uses recorded home values per channel', () => {
    const hands = { vendor: 'brainco', sides: { left: { jointMap: ['a', 'b'] } } };
    const home = planHandMove({
        hands,
        ranges: {},
        startBySide: { left: [0.9, 0.1] },
        home: true,
        homeValues: { left: [0.3] }
    });
    assert.deepEqual(home.sides.left.from, [0.9, 0.1]);
    assert.deepEqual(home.sides.left.to, [0.3, 0], '缺失通道回落到张开');
});

test('planHandMove home falls back to built-in inspire zero values', () => {
    const hands = { vendor: 'inspire', sides: { left: { jointMap: ['a', 'b'] } } };
    const plan = planHandMove({ hands, ranges: {}, startBySide: { left: [1, 1] }, home: true });
    assert.deepEqual(plan.sides.left.to, HOME_HAND_VALUES.sides.left.slice(0, 2));
});

test('handPoseFromState maps normalized hand values back to joint angles', () => {
    const hands = {
        sides: {
            left: { jointMap: ['left_index_mcp_joint', 'left_index_yaw_joint'] },
            right: { jointMap: ['right_index_mcp_joint'] }
        }
    };
    const ranges = {
        left_index_mcp_joint: { lower: 0, upper: 1.3 },
        left_index_yaw_joint: { lower: -0.26118, upper: 0.26118 },
        right_index_mcp_joint: { lower: 0, upper: 1.3 }
    };
    const { pose, matched, total } = handPoseFromState({
        hands,
        ranges,
        valuesBySide: { left: [0.5, 0.5], right: [1] }
    });
    assert.equal(matched, 3);
    assert.equal(total, 3);
    assert.ok(Math.abs(pose.left_index_mcp_joint - 0.65) < 1e-9);
    assert.ok(Math.abs(pose.left_index_yaw_joint) < 1e-9);
    assert.ok(Math.abs(pose.right_index_mcp_joint - 1.3) < 1e-9);
});

test('HOME_JOINT_VALUES covers the measured upper body', () => {
    assert.equal(Object.keys(HOME_JOINT_VALUES).length, 19);
    assert.equal(homeTargetsFor(['elbow_pitch_l_joint']).elbow_pitch_l_joint,
        HOME_JOINT_VALUES.elbow_pitch_l_joint);
});

test('degToRad clamps before converting', () => {
    assert.equal(degToRad(90), 45 * Math.PI / 180);
    assert.equal(degToRad(1), 5 * Math.PI / 180);
});
