#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Walker S2 关节映射表：URDF 关节名 <-> 限位。

数据来源（离线整理，真机需微动核对）：
- /home/liu/work/UBTECH-IL-LAB/ubt_IL/walker_s2/walker_sdk_ros2/robot_control/constants.py:104-144
- 控制话题 /mc/sdk/robot_command（JointCmd，按关节名寻址）

⚠️ 真机待核对项：
- S2 手部有两变体：V4 7DOF 手 / PGC 1DOF 夹爪（GripCmd）
- 需切换 SDK 控制器才能接收 ROS 指令
"""

# 可控关节：(urdf_name, sdk_name, lower, upper)
ARM_JOINTS = [
    ('L_shoulder_pitch_joint', 'L_shoulder_pitch_joint', -2.8274, 2.8274),
    ('L_shoulder_roll_joint', 'L_shoulder_roll_joint', -1.85, 0.0873),
    ('L_shoulder_yaw_joint', 'L_shoulder_yaw_joint', -2.8972, 2.8972),
    ('L_elbow_pitch_joint', 'L_elbow_pitch_joint', -2.6180, 0.0),
    ('L_elbow_yaw_joint', 'L_elbow_yaw_joint', -2.9147, 2.9147),
    ('L_wrist_pitch_joint', 'L_wrist_pitch_joint', -1.5882, 1.5882),
    ('L_wrist_roll_joint', 'L_wrist_roll_joint', -1.9897, 1.9897),
    ('R_shoulder_pitch_joint', 'R_shoulder_pitch_joint', -2.8274, 2.8274),
    ('R_shoulder_roll_joint', 'R_shoulder_roll_joint', -1.85, 0.0873),
    ('R_shoulder_yaw_joint', 'R_shoulder_yaw_joint', -2.8972, 2.8972),
    ('R_elbow_pitch_joint', 'R_elbow_pitch_joint', -2.6180, 0.0),
    ('R_elbow_yaw_joint', 'R_elbow_yaw_joint', -2.9147, 2.9147),
    ('R_wrist_pitch_joint', 'R_wrist_pitch_joint', -1.5882, 1.5882),
    ('R_wrist_roll_joint', 'R_wrist_roll_joint', -1.9897, 1.9897),
]

WAIST_JOINTS = [
    ('waist_yaw_joint', 'waist_yaw_joint', -2.7925, 2.7925),
]

HEAD_JOINTS = [
    ('head_yaw_joint', 'head_yaw_joint', -1.6406, 1.6406),
    ('head_pitch_joint', 'head_pitch_joint', -0.6807, 0.5061),
]

LEG_JOINTS = [  # 运控独占，仅回读
    ('L_hip_pitch_joint', 'L_hip_pitch_joint', -3.0543, 2.7925),
    ('L_hip_roll_joint', 'L_hip_roll_joint', -0.4189, 2.6180),
    ('L_hip_yaw_joint', 'L_hip_yaw_joint', -1.3963, 4.4506),
    ('L_knee_pitch_joint', 'L_knee_pitch_joint', -0.0873, 2.5307),
    ('L_ankle_pitch_joint', 'L_ankle_pitch_joint', -1.1868, 0.5236),
    ('L_ankle_roll_joint', 'L_ankle_roll_joint', -0.5236, 0.5236),
    ('R_hip_pitch_joint', 'R_hip_pitch_joint', -3.0543, 2.7925),
    ('R_hip_roll_joint', 'R_hip_roll_joint', -0.4189, 2.6180),
    ('R_hip_yaw_joint', 'R_hip_yaw_joint', -1.3963, 4.4506),
    ('R_knee_pitch_joint', 'R_knee_pitch_joint', -0.0873, 2.5307),
    ('R_ankle_pitch_joint', 'R_ankle_pitch_joint', -1.1868, 0.5236),
    ('R_ankle_roll_joint', 'R_ankle_roll_joint', -0.5236, 0.5236),
]

CONTROLLABLE_GROUPS = ('arm', 'head', 'waist')


def _to_joint_table(rows, sdk_id_start=1):
    """把 (urdf, sdk_name, lower, upper) 转成协议层期望的五元组格式。
    Walker 按关节名寻址无数字 ID，这里用递增占位 ID（仅用于 welcome 元数据）。
    """
    return [(sdk_id_start + i, sdk, urdf, lo, hi)
            for i, (urdf, sdk, lo, hi) in enumerate(rows)]


JOINT_TABLE = {
    'arm': _to_joint_table(ARM_JOINTS, 1),
    'head': _to_joint_table(HEAD_JOINTS, 50),
    'waist': _to_joint_table(WAIST_JOINTS, 60),
    'leg': _to_joint_table(LEG_JOINTS, 70),
}
ALL_GROUPS = tuple(JOINT_TABLE)

BY_URDF = {}
BY_NAME = {}
for _group, _rows in (('arm', ARM_JOINTS), ('head', HEAD_JOINTS),
                      ('waist', WAIST_JOINTS), ('leg', LEG_JOINTS)):
    for _urdf, _sdk, _lo, _hi in _rows:
        _entry = {'group': _group, 'urdf': _urdf, 'sdk_name': _sdk,
                  'lower': _lo, 'upper': _hi}
        BY_URDF[_urdf] = _entry
        BY_NAME[_sdk] = _entry


def clamp(name, value):
    entry = BY_URDF.get(name)
    if not entry:
        return value
    return max(entry['lower'], min(entry['upper'], value))


def urdf_joint_names():
    return list(BY_URDF.keys())


def joint_descriptors():
    descriptors = []
    for name, entry in BY_URDF.items():
        descriptors.append({
            'name': name, 'type': 'revolute',
            'lower': entry['lower'], 'upper': entry['upper'],
            'group': entry['group'], 'sdkName': entry['sdk_name'],
            'controllable': entry['group'] in CONTROLLABLE_GROUPS,
        })
    return descriptors


def hands_joint_map(vendor, side):
    """S2 V4 手 6 通道（SDK 压缩）→ URDF 关节名。"""
    prefix = 'left' if side == 'left' else 'right'
    return [
        f'{prefix}_thumb_swing_joint',
        f'{prefix}_thumb_mcp_joint',
        f'{prefix}_index_mcp_joint',
        f'{prefix}_middle_mcp_joint',
        f'{prefix}_ring_mcp_joint',
        f'{prefix}_little_mcp_joint',
    ]
