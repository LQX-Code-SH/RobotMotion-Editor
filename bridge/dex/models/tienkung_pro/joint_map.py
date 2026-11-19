#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TienKung Pro 关节映射表：SDK 电机 ID <-> URDF 关节名 <-> 限位。

数据来源（离线整理，真机需微动核对）：
- /home/liu/work/UBTECH-IL-LAB/ubt_sim/teleoperation/control/tienkung_pro/constants.py:8-35
- /home/liu/work/UBTECH-IL-LAB/ubt_sim/teleoperation/bridges/tienkung_pro/bridge_config.yaml

与 Dex 的差异：
- 消息族 bodyctrl_msgs / CmdSetMotorPosition（`name`=电机 ID, `pos` rad, `spd` rpm）
- 头部 3 个 ID（1/2/3），Dex 只有 1/2
- 腰只有 body_yaw（ID 31）

⚠️ 真机适配待核对项：
- `elbow_yaw_l/r_joint` 对应关系（Dex 侧标注为推断）
- 关节限位来自 ubt_sim，需与真机实测行程比对
- spd 单位是 rpm，与 Dex 的 rad/s 不同
"""

# group: (sdk_id, sdk_name, urdf_joint_name, lower, upper)
JOINT_TABLE = {
    'head': [
        (1, 'head_roll_joint', 'head_roll_joint', -0.7854, 0.7854),
        (2, 'head_pitch_joint', 'head_pitch_joint', -0.6807, 0.5061),
        (3, 'head_yaw_joint', 'head_yaw_joint', -1.6406, 1.6406),
    ],
    'arm': [
        (11, 'shoulder_pitch_l_joint', 'shoulder_pitch_l_joint', -2.8274, 2.8274),
        (12, 'shoulder_roll_l_joint', 'shoulder_roll_l_joint', -1.85, 0.0873),
        (13, 'shoulder_yaw_l_joint', 'shoulder_yaw_l_joint', -2.8972, 2.8972),
        (14, 'elbow_pitch_l_joint', 'elbow_pitch_l_joint', -2.6180, 0.0),
        (15, 'elbow_yaw_l_joint', 'elbow_yaw_l_joint', -2.9147, 2.9147),
        (16, 'wrist_pitch_l_joint', 'wrist_pitch_l_joint', -1.5882, 1.5882),
        (17, 'wrist_roll_l_joint', 'wrist_roll_l_joint', -1.9897, 1.9897),
        (21, 'shoulder_pitch_r_joint', 'shoulder_pitch_r_joint', -2.8274, 2.8274),
        (22, 'shoulder_roll_r_joint', 'shoulder_roll_r_joint', -1.85, 0.0873),
        (23, 'shoulder_yaw_r_joint', 'shoulder_yaw_r_joint', -2.8972, 2.8972),
        (24, 'elbow_pitch_r_joint', 'elbow_pitch_r_joint', -2.6180, 0.0),
        (25, 'elbow_yaw_r_joint', 'elbow_yaw_r_joint', -2.9147, 2.9147),
        (26, 'wrist_pitch_r_joint', 'wrist_pitch_r_joint', -1.5882, 1.5882),
        (27, 'wrist_roll_r_joint', 'wrist_roll_r_joint', -1.9897, 1.9897),
    ],
    'waist': [
        (31, 'body_yaw_joint', 'body_yaw_joint', -2.7925, 2.7925),
    ],
    'leg': [  # 运控独占，仅状态回读
        (51, 'hip_roll_l_joint', 'hip_roll_l_joint', -0.4189, 2.6180),
        (52, 'hip_pitch_l_joint', 'hip_pitch_l_joint', -3.0543, 2.7925),
        (53, 'hip_yaw_l_joint', 'hip_yaw_l_joint', -1.3963, 4.4506),
        (54, 'knee_pitch_l_joint', 'knee_pitch_l_joint', -0.0873, 2.5307),
        (55, 'ankle_pitch_l_joint', 'ankle_pitch_l_joint', -1.1868, 0.5236),
        (56, 'ankle_roll_l_joint', 'ankle_roll_l_joint', -0.5236, 0.5236),
        (61, 'hip_roll_r_joint', 'hip_roll_r_joint', -0.4189, 2.6180),
        (62, 'hip_pitch_r_joint', 'hip_pitch_r_joint', -3.0543, 2.7925),
        (63, 'hip_yaw_r_joint', 'hip_yaw_r_joint', -1.3963, 4.4506),
        (64, 'knee_pitch_r_joint', 'knee_pitch_r_joint', -0.0873, 2.5307),
        (65, 'ankle_pitch_r_joint', 'ankle_pitch_r_joint', -1.1868, 0.5236),
        (66, 'ankle_roll_r_joint', 'ankle_roll_r_joint', -0.5236, 0.5236),
    ],
}

CONTROLLABLE_GROUPS = ('arm', 'head', 'waist')
ALL_GROUPS = tuple(JOINT_TABLE)

BY_URDF = {}
BY_SDK_NAME = {}
BY_GROUP_ID = {}
for _group, _rows in JOINT_TABLE.items():
    for _id, _sdk_name, _urdf_name, _lo, _hi in _rows:
        _entry = {
            'group': _group, 'sdk_id': _id, 'sdk_name': _sdk_name,
            'urdf': _urdf_name, 'lower': _lo, 'upper': _hi,
        }
        BY_URDF[_urdf_name] = _entry
        BY_SDK_NAME[_sdk_name] = _entry
        BY_GROUP_ID[(_group, _id)] = _entry


def clamp(name, value):
    """按 URDF 关节名限位裁剪。未映射关节原样返回。"""
    entry = BY_URDF.get(name)
    if not entry:
        return value
    return max(entry['lower'], min(entry['upper'], value))


def urdf_joint_names():
    return list(BY_URDF.keys())


def joint_descriptors():
    """welcome.joints 数据源：每个可控关节的描述。"""
    descriptors = []
    for group, rows in JOINT_TABLE.items():
        for sdk_id, sdk_name, urdf_name, lower, upper in rows:
            descriptors.append({
                'name': urdf_name, 'type': 'revolute',
                'lower': lower, 'upper': upper,
                'group': group, 'sdkId': sdk_id, 'sdkName': sdk_name,
                'controllable': group in CONTROLLABLE_GROUPS,
            })
    return descriptors


def hands_joint_map(vendor, side):
    """Pro 6 通道 Inspire 手 → URDF 关节名（供视口同步，待真机核对顺序）。"""
    prefix = 'left' if side == 'left' else 'right'
    return [
        f'{prefix}_little_1_joint',
        f'{prefix}_ring_1_joint',
        f'{prefix}_middle_1_joint',
        f'{prefix}_index_1_joint',
        f'{prefix}_thumb_2_joint',
        f'{prefix}_thumb_1_joint',
    ]
