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
    planClipHands,
    planHandMove,
    planHandRamp,
    planJointTrajectory,
    prependLeadIn,
    sampleClipTrajectory,
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

const linearTrack = (jointName, from, to, durationMs = 1000) => ({
    type: 'joint',
    jointName,
    keyframes: [
        { timeMs: 0, value: from, interpolation: 'linear' },
        { timeMs: durationMs, value: to, interpolation: 'linear' }
    ]
});

test('sampleClipTrajectory keeps upper body only and reports ignored joints', () => {
    const clip = {
        durationMs: 1000,
        fps: 30,
        tracks: [
            linearTrack('shoulder_pitch_l_joint', 0, 1),
            linearTrack('hip_pitch_l_joint', 0, 0.5),
            linearTrack('left_index_proximal_joint', 0, 1),
            linearTrack('spine_joint', 0, 0.2)
        ]
    };
    const sample = sampleClipTrajectory({ clip, startMs: 0, endMs: 1000, fps: 30, device });

    assert.deepEqual(sample.jointNames, ['shoulder_pitch_l_joint']);
    assert.equal(sample.ignored.leg.length, 1);
    assert.equal(sample.ignored.hand.length, 1);
    assert.equal(sample.ignored.other.length, 1);
    assert.equal(sample.durationMs, 1000);
    assert.equal(sample.frames[0].t, 0);
    assert.equal(sample.frames.at(-1).t, 1000);
    assert.ok(Math.abs(sample.frames.at(-1).targets.shoulder_pitch_l_joint - 1) < 1e-6);
    assert.ok(Math.abs(sample.peakSpeedRadS - 1) < 0.05, `峰值 ${sample.peakSpeedRadS}`);
    assert.ok(sample.frames.length >= 30);
});

test('sampleClipTrajectory honours a sub range of playRange', () => {
    const clip = { durationMs: 1000, tracks: [linearTrack('shoulder_pitch_l_joint', 0, 1)] };
    const sample = sampleClipTrajectory({ clip, startMs: 500, endMs: 1000, fps: 30, device });
    assert.equal(sample.durationMs, 500);
    assert.equal(sample.frames[0].t, 0);
    assert.ok(Math.abs(sample.frames[0].targets.shoulder_pitch_l_joint - 0.5) < 1e-6);
    assert.ok(Math.abs(sample.frames.at(-1).targets.shoulder_pitch_l_joint - 1) < 1e-6);
});

test('sampleClipTrajectory returns no joints when the clip only animates legs', () => {
    const clip = { durationMs: 500, tracks: [linearTrack('hip_pitch_l_joint', 0, 0.4, 500)] };
    const sample = sampleClipTrajectory({ clip, startMs: 0, endMs: 500, fps: 30, device });
    assert.deepEqual(sample.jointNames, []);
    assert.deepEqual(sample.frames, []);
});

test('prependLeadIn ramps from the real pose to the clip first frame', () => {
    const frames = [
        { t: 0, targets: { a: 1 } },
        { t: 100, targets: { a: 1.1 } }
    ];
    const lead = prependLeadIn({ frames, from: { a: 0 }, maxSpeedRadS: 0.5, fps: 30 });

    assert.ok(lead.leadInMs > 0);
    assert.deepEqual(lead.frames[0], { t: 0, targets: { a: 0 } });
    assert.equal(lead.frames.at(-1).t, lead.leadInMs + 100);
    const junction = lead.frames.filter(frame => frame.t === lead.leadInMs);
    assert.equal(junction.length, 1, '过渡段末帧与 clip 首帧不重复');
    assert.equal(junction[0].targets.a, 1);

    // 只有过渡段受面板限速约束，clip 段保持动画原速
    for (let index = 1; index < lead.frames.length; index += 1) {
        if (lead.frames[index].t > lead.leadInMs) break;
        const dt = (lead.frames[index].t - lead.frames[index - 1].t) / 1000;
        if (dt <= 0) continue;
        const speed = Math.abs(lead.frames[index].targets.a - lead.frames[index - 1].targets.a) / dt;
        assert.ok(speed <= 0.5 * 1.05, `过渡段峰值 ${speed} 超出 0.5`);
    }
});

test('prependLeadIn skips the ramp when the pose already matches', () => {
    const frames = [{ t: 0, targets: { a: 1 } }, { t: 200, targets: { a: 1.2 } }];
    const lead = prependLeadIn({ frames, from: { a: 1.0005 }, maxSpeedRadS: 0.5 });
    assert.equal(lead.leadInMs, 0);
    assert.equal(lead.frames.length, 2);
    assert.equal(lead.frames[0].t, 0);
    assert.deepEqual(lead.frames[0].targets, { a: 1 });
});

test('planClipHands follows the clip timeline and reports motion', () => {
    const hands = {
        vendor: 'inspire',
        sides: {
            left: { jointMap: ['left_index_mcp_joint'] },
            right: { jointMap: ['right_index_mcp_joint'] }
        }
    };
    const ranges = {
        left_index_mcp_joint: { lower: 0, upper: 1 },
        right_index_mcp_joint: { lower: 0, upper: 1 }
    };
    const clip = {
        durationMs: 1000,
        tracks: [
            linearTrack('left_index_mcp_joint', 0, 1),
            linearTrack('right_index_mcp_joint', 0.5, 0.5)
        ]
    };
    const plan = planClipHands({
        clip,
        hands,
        ranges,
        startBySide: { left: [0], right: [0.5] },
        startMs: 0,
        endMs: 1000,
        hz: 20,
        leadInMs: 200
    });

    assert.equal(plan.matched, 2);
    assert.equal(plan.hasMotion, true);
    assert.equal(plan.sides.left[0].t, 0);
    assert.equal(plan.sides.left.at(-1).t, 1200);
    assert.ok(Math.abs(plan.sides.left.at(-1).values[0] - 1) < 1e-6);
    assert.ok(plan.sides.right.every(frame => Math.abs(frame.values[0] - 0.5) < 1e-6));
});

test('planClipHands stays still for clips without finger keys', () => {
    const hands = { sides: { left: { jointMap: ['left_index_mcp_joint'] } } };
    const ranges = { left_index_mcp_joint: { lower: 0, upper: 1 } };
    const clip = { durationMs: 500, tracks: [linearTrack('shoulder_pitch_l_joint', 0, 0.3, 500)] };
    const plan = planClipHands({
        clip,
        hands,
        ranges,
        startBySide: { left: [0.42] },
        startMs: 0,
        endMs: 500
    });
    assert.equal(plan.hasMotion, false);
    assert.ok(plan.sides.left.every(frame => Math.abs(frame.values[0] - 0.42) < 1e-6));
});
