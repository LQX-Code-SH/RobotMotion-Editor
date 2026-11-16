#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TienKung Dex 关节映射表：SDK 关节 ID <-> URDF 关节名。

数据来源：
- SDK 关节 ID/名称/限位：xhumanoid_sdk/tienkung_dex/python/config/joints.yaml
  （真机 /robot_state 实测 ID 集合：arm 11~17/21~27、head 1/2、waist 31~33、leg 51~56/61~66）
- URDF 关节名：robot/walker-tienkung-dex/model/urdf/*.urdf

注意：
- URDF 与 SDK 命名不一致，需显式映射（如 URDF `elbow_yaw_l_joint` 对应 SDK
  id 15 `left_wrist_yaw`，属推断，需真机微动核对）。
- 腿部（leg）由行走运控独占，SDK 不可直控，仅用于状态回读。
"""

# group: (sdk_id, sdk_name, urdf_joint_name, lower, upper)
JOINT_TABLE = {
    'arm': [
        (11, 'left_shoulder_pitch', 'shoulder_pitch_l_joint', -2.8449, 2.8449),
        (12, 'left_shoulder_roll', 'shoulder_roll_l_joint', -0.1920, 3.3336),
        (13, 'left_shoulder_yaw', 'shoulder_yaw_l_joint', -2.8449, 2.8449),
        (14, 'left_elbow_pitch', 'elbow_pitch_l_joint', -2.5482, 0.1920),
        (15, 'left_wrist_yaw', 'elbow_yaw_l_joint', -2.8449, 2.8449),
        (16, 'left_wrist_pitch', 'wrist_pitch_l_joint', -1.3265, 1.3265),
        (17, 'left_wrist_roll', 'wrist_roll_l_joint', -1.3265, 1.3265),
        (21, 'right_shoulder_pitch', 'shoulder_pitch_r_joint', -2.8449, 2.8449),
        (22, 'right_shoulder_roll', 'shoulder_roll_r_joint', -3.3336, 0.1920),
        (23, 'right_shoulder_yaw', 'shoulder_yaw_r_joint', -2.8449, 2.8449),
        (24, 'right_elbow_pitch', 'elbow_pitch_r_joint', -2.5482, 0.1920),
        (25, 'right_wrist_yaw', 'elbow_yaw_r_joint', -2.8449, 2.8449),
        (26, 'right_wrist_pitch', 'wrist_pitch_r_joint', -1.3265, 1.3265),
        (27, 'right_wrist_roll', 'wrist_roll_r_joint', -1.3265, 1.3265),
    ],
    'head': [
        (1, 'head_yaw', 'head_yaw_joint', -1.0472, 1.0472),
        (2, 'head_pitch', 'head_pitch_joint', -0.2618, 1.0123),
    ],
    'waist': [
        (31, 'waist_pitch', 'waist_pitch_joint', -0.5236, 0.8727),
        (32, 'waist_roll', 'waist_roll_joint', -0.4363, 0.4363),
        (33, 'waist_yaw', 'waist_yaw_joint', -2.6180, 3.2289),
    ],
    # 腿部由运控独占，仅回读状态
    'leg': [
        (51, 'left_hip_pitch', 'hip_pitch_l_joint', -3.0543, 2.7925),
        (52, 'left_hip_roll', 'hip_roll_l_joint', -0.4189, 2.6180),
        (53, 'left_hip_yaw', 'hip_yaw_l_joint', -1.3963, 4.4506),
        (54, 'left_knee_pitch', 'knee_pitch_l_joint', -0.0873, 2.5307),
        (55, 'left_ankle_pitch', 'ankle_pitch_l_joint', -1.1868, 0.5236),
        (56, 'left_ankle_roll', 'ankle_roll_l_joint', -0.5236, 0.5236),
        (61, 'right_hip_pitch', 'hip_pitch_r_joint', -3.0543, 2.7925),
        (62, 'right_hip_roll', 'hip_roll_r_joint', -0.4189, 2.6180),
        (63, 'right_hip_yaw', 'hip_yaw_r_joint', -1.3963, 4.4506),
        (64, 'right_knee_pitch', 'knee_pitch_r_joint', -0.0873, 2.5307),
        (65, 'right_ankle_pitch', 'ankle_pitch_r_joint', -1.1868, 0.5236),
        (66, 'right_ankle_roll', 'ankle_roll_r_joint', -0.5236, 0.5236),
    ],
}

# 允许直接下发的关节组（leg 由运控独占）
CONTROLLABLE_GROUPS = ('arm', 'head', 'waist')
ALL_GROUPS = tuple(JOINT_TABLE)

# 索引
BY_URDF = {}      # urdf name -> dict(group, sdk_id, sdk_name, lower, upper)
BY_SDK_NAME = {}  # sdk name -> same dict
BY_GROUP_ID = {}  # (group, sdk_id) -> same dict
for _group, _rows in JOINT_TABLE.items():
    for _id, _sdk_name, _urdf_name, _lo, _hi in _rows:
        _entry = {
            'group': _group,
            'sdk_id': _id,
            'sdk_name': _sdk_name,
            'urdf': _urdf_name,
            'lower': _lo,
            'upper': _hi,
        }
        BY_URDF[_urdf_name] = _entry
        BY_SDK_NAME[_sdk_name] = _entry
        BY_GROUP_ID[(_group, _id)] = _entry


def lookup_urdf(name):
    """URDF 关节名 -> 映射项；不存在返回 None。"""
    return BY_URDF.get(name)


def sdk_joint_names():
    """返回 {group: [sdk_name...]} 供欢迎消息与文档使用。"""
    return {group: [row[1] for row in rows] for group, rows in JOINT_TABLE.items()}


def urdf_joint_names():
    """返回 {group: [urdf_joint_name...]}。"""
    return {group: [row[2] for row in rows] for group, rows in JOINT_TABLE.items()}


def clamp(name, value):
    """按限位裁剪单个 URDF 关节值（rad）；未知关节返回 None。"""
    entry = BY_URDF.get(name)
    if entry is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    if value != value:  # NaN
        return None
    return max(entry['lower'], min(entry['upper'], value))


def hands_joint_map(vendor, side):
    """灵巧手：SDK 电机索引 -> URDF 主关节名（用于视口同步，可选）。

    BrainCo：6 电机（0 拇指弯曲 / 1 拇指旋转 / 2 食指 / 3 中指 / 4 无名指 / 5 小指）
    Inspire：13 关节，运行期以 angle_actual.joint_names 为准；此处给出按索引的
    常见映射，仅用于 URDF 预览同步，未命中时前端按名称匹配。
    """
    prefix = 'left' if side == 'left' else 'right'
    if vendor == 'brainco':
        return [
            f'{prefix}_thumb_proximal_joint',
            f'{prefix}_thumb_metacarpal_joint',
            f'{prefix}_index_proximal_joint',
            f'{prefix}_middle_proximal_joint',
            f'{prefix}_ring_proximal_joint',
            f'{prefix}_pinky_proximal_joint',
        ]
    if vendor == 'inspire':
        # 顺序必须与 inspire_hand_msgs/angle_actual 的 13 通道一致
        # （pinky→ring→middle→index→thumb，见 dex_hands.INSPIRE_CHANNELS），
        # 否则手部幽灵层会把通道值套到错误的手指上。
        return [
            f'{prefix}_pinky_mcp_joint',
            f'{prefix}_ring_mcp_joint',
            f'{prefix}_middle_mcp_joint',
            f'{prefix}_middle_yaw_joint',
            f'{prefix}_index_mcp_joint',
            f'{prefix}_index_yaw_joint',
            f'{prefix}_pinky_pip_joint',
            f'{prefix}_ring_pip_joint',
            f'{prefix}_middle_pip_joint',
            f'{prefix}_index_pip_joint',
            f'{prefix}_thumb_yaw_joint',
            f'{prefix}_thumb_mcp_joint',
            f'{prefix}_thumb_pip_joint',
        ]
    return []
