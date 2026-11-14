import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyJointPart, JOINT_PARTS } from '../../src/models/UnifiedRobotModel.js';

test('classifyJointPart splits joints by body part and side', () => {
    const cases = {
        // 头 / 腰
        head_yaw_joint: 'head',
        neck_pitch_joint: 'head',
        waist_pitch_joint: 'waist',
        torso_waist_joint: 'waist',
        // 左右臂：前缀式（Walker）与后缀式（TienKung Dex）
        L_shoulder_pitch_joint: 'leftArm',
        R_elbow_yaw_joint: 'rightArm',
        shoulder_pitch_l_joint: 'leftArm',
        elbow_yaw_r_joint: 'rightArm',
        // 左右手
        L_hand_joint: 'leftHand',
        R_hand_joint: 'rightHand',
        left_thumb_proximal_joint: 'leftHand',
        right_index_proximal_joint: 'rightHand',
        L_little_mpp_joint: 'leftHand',
        hand_joint: 'hand',
        // 腕部六维力传感器
        L_sixforce_joint: 'leftArm',
        // 左右腿
        L_hip_pitch_joint: 'leftLeg',
        R_knee_pitch_joint: 'rightLeg',
        hip_pitch_l_joint: 'leftLeg',
        ankle_roll_r_joint: 'rightLeg',
        leg_joint: 'leg'
    };

    for (const [name, expected] of Object.entries(cases)) {
        assert.equal(classifyJointPart(name), expected, `${name} should be ${expected}`);
    }
});

test('classifyJointPart falls back to other and keeps the panel order', () => {
    assert.equal(classifyJointPart('body_imu_joint'), 'other');
    assert.equal(classifyJointPart('base_link'), 'other');
    assert.equal(classifyJointPart(''), 'other');
    assert.deepEqual(JOINT_PARTS, [
        'head',
        'leftArm', 'rightArm', 'arm',
        'leftHand', 'rightHand', 'hand',
        'waist',
        'leftLeg', 'rightLeg', 'leg',
        'other'
    ]);
});
