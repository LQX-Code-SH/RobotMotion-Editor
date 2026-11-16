# TienKung Dex 真机桥接（Python / ROS 2）

天工 DEX（`walker-tienkung-dex`）真机适配层。运行在机器人算力主机（`nvidia@192.168.41.2`），
将网页端的动作编辑指令转换为 ROS 2 话题下发，并把关节/灵巧手/相机状态回传给浏览器。

与 Node 版桥接（`bridge/robot-server.js`）共用同一套 UDP 发现与 WebSocket 协议，
`bridge/station.js` 网关可直接代理；本服务额外支持灵巧手与相机。

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Ubuntu 24.04（机器人主机），以 `nvidia` 用户运行 |
| ROS 2 | Jazzy |
| Python | 3.12（机器人端），`websockets>=10` |
| 厂商消息 | `ros2_bridge_msgs`（/opt/humanoid/install）、`brainco_hand_msgs` / `inspire_hand_msgs` / `bodyctrl_msgs`（~/xos） |
| 可选 | `python3-opencv`（相机推流，缺失则相机功能自动禁用） |

```bash
sudo apt install python3-opencv          # 可选：相机 JPEG 推流
pip install --user websockets            # WS 服务依赖
```

## 运行

```bash
source /opt/ros/jazzy/setup.bash
source /opt/humanoid/install/setup.bash
source ~/xos/setup.bash                  # 顺序不可颠倒

cd bridge/dex
python3 dex_bridge.py --hand brainco     # 或 --hand inspire / auto / none
```

无 ROS 环境时可用 dry-run 验证协议（不连真机）：

```bash
python3 dex_bridge.py --dry-run
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--ws-port` | `8081` | WebSocket 控制通道（全部消息） |
| `--status-port` | `8082` | 只读状态通道（`0` 禁用） |
| `--camera-port` | `8083` | 只读相机通道（`0` 禁用） |
| `--beacon-port` | `45678` | UDP 设备发现端口 |
| `--model` | `walker-tienkung-dex` | 机型标识（网页机型列表对应） |
| `--name` | `TienKung Dex` | 设备显示名 |
| `--hand` | `auto` | 灵巧手：`brainco` / `inspire` / `auto` / `none` |
| `--rate` | `50` | 关节命令下发频率（Hz，SDK 要求 20~50 持续发布） |
| `--telemetry-hz` | `20` | 状态回传频率 |
| `--max-speed` | `1.2` | 目标斜坡最大角速度（rad/s） |
| `--spd` | `0.3` | 驱动侧速度参数（rad/s）。实测位置模式下生效：0.3 → 约 0.29 rad/s |
| `--cur` | `10` | 驱动侧电流限幅（A）。厂商头/腰/臂 demo 口径为 40 |
| `--dry-run` | - | 不连接 ROS，仅验证协议 |

### 真机前置条件（重要）

1. 遥控器切入 **topic 控制模式**：`G 中 + E 上`（此模式下仅 C 键有效）
2. 机器人已进入 **归零姿态**（关节主动发力、有阻尼）
3. 灵巧手驱动已启动（Inspire：`ros2 launch inspire_hand right_hand.launch.py` 等）
4. PC/浏览器与机器人同网段（192.168.41.x/24）

急停与僵停由遥控器负责（长按/双击 C 键 = 僵停，无线急停 = 断力瘫软）；桥接仅在软件侧
阻止下发并在急停话题激活时拒绝指令。

## 关节映射

SDK 关节与 URDF 命名不同，映射表见 [`joint_map.py`](joint_map.py)：

| SDK ID | SDK 名称 | URDF 关节名 | 组 |
|---|---|---|---|
| 11–17 | `left_shoulder_pitch` … `left_wrist_roll` | `shoulder_pitch_l_joint` … `wrist_roll_l_joint` | arm |
| 21–27 | `right_shoulder_pitch` … `right_wrist_roll` | `shoulder_pitch_r_joint` … `wrist_roll_r_joint` | arm |
| 1 / 2 | `head_yaw` / `head_pitch` | `head_yaw_joint` / `head_pitch_joint` | head |
| 31 / 32 / 33 | `waist_pitch` / `waist_roll` / `waist_yaw` | `waist_pitch_joint` / `waist_roll_joint` / `waist_yaw_joint` | waist |
| 51–56 / 61–66 | 腿部 12 关节 | `hip_pitch_l_joint` … `ankle_roll_r_joint` | leg（**只读**） |

注意：
- **腿部不可直控**（行走运控独占），桥接会拒绝腿部目标并返回原因
- `elbow_yaw_l/r_joint` ↔ SDK `left/right_wrist_yaw`（id 15/25）为推断映射，需真机微动核对
- 目标值统一按限位裁剪 + 速度斜坡；腰部 yaw 自动提高电流到 40A（SDK 实测要求）

## 灵巧手

统一以 **归一化 0~1** 下发与回读，桥接内部换算厂商单位：

| 手型 | 关节数 | 命令话题 | 值域换算 | 反馈话题 |
|---|---|---|---|---|
| BrainCo | 6 电机 | `/{side}_hand/set_motor_multi`（mode=1） | 1 + 999×v（1 伸直、1000 弯曲） | `/{side}_hand/motor_status` |
| Inspire | 13 关节 | `/{side}_hand/angle_set`（hand_id 1 左 / 2 右） | 1000×v | `/{side}_hand/angle_actual` |

- BrainCo 电机索引：0 拇指弯曲 / 1 拇指旋转 / 2 食指 / 3 中指 / 4 无名指 / 5 小指
- Inspire 的 `angle_actual.joint_names[13]` 为运行期真实关节布局，桥接会透传给前端
- 手型不可用时 `--hand none` 或自动降级为无手模式

## 相机

| 相机 ID | 话题（BEST_EFFORT） |
|---|---|
| `head` | `/ob_camera_head/color/image_raw` |
| `waist` | `/ob_camera_waist/color/image_raw` |
| `wrist_left` | `/ob_camera_wrist_left/color/image_raw` |
| `wrist_right` | `/ob_camera_wrist_right/color/image_raw` |

按需订阅：网页请求某路时才创建订阅，全部取消后销毁；帧经 cv2 转 JPEG（质量 70，
宽度上限 640）后 base64 推送，默认 10fps。

## 端口与通道

| 端口 | 通道 | 说明 |
|---|---|---|
| 8081 | 控制 | 接受全部消息，向后兼容单连接客户端 |
| 8082 | 状态 | 只读；`enable` 等控制消息返回 `readonly` |
| 8083 | 相机 | 只读；承载 `camera_list/subscribe/unsubscribe` 与 `camera_frame` |

三个端口复用同一套 JSON 协议，`welcome.channel` 标出当前通道，`welcome` 同时携带
`wsPort/statusPort/cameraPort/beaconPort`，便于前端直接据此建立三条连接。

也可由操作站网页端一键部署：`bridge/station.js` 的"固件一键部署"会把本目录推到
`~/.robot-motion-bridge/tienkung-dex/`，生成带 ROS `source` 顺序的 `run.sh` 并拉起。

## 协议扩展

在 Node 版协议（见 `bridge/README.md`）基础上新增：

| 方向 | 消息 | 字段 | 说明 |
|---|---|---|---|
| C→R | `hand_targets` | `side: left\|right`, `values: [0..1…]` | 归一化手部目标 |
| C→R | `hand_clear_error` | `side` | Inspire 清错（BrainCo 返回 false） |
| C→R | `camera_list` | - | 获取相机列表 |
| C→R | `camera_subscribe` | `camera`, `fps` | 订阅相机推流 |
| C→R | `camera_unsubscribe` | `camera` | 取消订阅 |
| R→C | `cameras` | `cameras: [{id, topic, type}]` | 相机列表 |
| R→C | `camera_frame` | `camera, format:'jpeg', width, height, stamp, bytes, data(base64)` | 视频帧 |

`welcome` 额外字段：`controllableGroups`、`legLocked`、`hands`（vendor/count/names/jointMap）、
`cameras`。`status` 额外字段：`estop`、`hands`（各手归一化数值与名称）。

## 已知限制

- 腿部无法通过 SDK 直控，只能经 `/hric/robot/cmd_vel` 行走（遥控器需切策略 + E 上拨）
- 关节状态回传约 12Hz（真机实测），网页端视口同步存在该延迟
- 急停无软件命令话题，仅监测 `/power/board/key_status` 并在激活时停止下发
- 相机深度流（`depth/image_raw`）当前未推送到网页端，仅彩色 JPEG
