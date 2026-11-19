# 真机桥接（Python / ROS 2）

将网页端的动作编辑指令转换为 ROS 2 话题下发，并把关节/灵巧手/相机状态回传给浏览器。
与 Node 版桥接（`bridge/robot-server.js`）共用同一套 UDP 发现与 WebSocket 协议，
`bridge/station.js` 网关可直接代理；本服务额外支持灵巧手与相机。

## 目录结构

```
bridge/dex/
  dex_bridge.py              # 协议层入口（WS / UDP / 消息路由），机型无关
  models/
    __init__.py              # 兼容导出：MODEL_DIRS / model_dir / bootstrap
    discovery.py             # 自动扫描机型目录，不再手工维护注册表
    model.json 每个机型一份  # 声明 id / backend / jointMap / capabilities
    tienkung_dex/            # 天工 Dex（已打通）：joint_map / dex_robot / dex_hands / dex_camera / backend
    tienkung_pro/            # 天工 Pro（骨架已备，真机待核对）
    walker_s2/               # Walker S2（骨架已备，真机待核对）
    walker_c1/               # Walker C1（骨架已备，真机待核对）
    _walker_common/          # Walker 家族共享的关节/手后端
    common/                  # 跨机型通用后端预留目录
    _template/               # 新增机型复制模板
```

`dex_bridge.py` 按 `--model` 注入对应机型目录到 `sys.path`，并调用该目录 `backend.create_backends()`
创建 `(robot, hands, cameras)`。协议层不含任何机型专属逻辑。

新增机型无需改协议层：复制 `models/_template/` 与 `robot/_template/`，填写 `model.json`
和 `profile.json`，运行 `pnpm run robot:index` 与 `pnpm test`；`models/discovery.py`
会自动发现新目录。未知 `--model` 会直接报错并列出可用机型。详细适配见
`docs/multi-robot-adaptation.md`。

以下环境要求与运行说明以 **TienKung Dex** 为准；其他机型的 ROS2 版本/消息包见方案文档。

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
| `--model` | `walker-tienkung-dex` | 机型标识，决定加载 `models/<机型>/` 后端：`walker-tienkung-dex` / `walker-tienkung-pro` / `walker-s2` / `walker-c1` |
| `--name` | `TienKung Dex` | 设备显示名 |
| `--hand` | `auto` | 末端：`brainco` / `inspire` / `auto` / `none`；S2 夹爪用 `gripper` |
| `--rate` | `50` | 关节命令下发频率（Hz，SDK 要求 20~50 持续发布） |
| `--telemetry-hz` | `20` | 状态回传频率 |
| `--max-speed` | `1.2` | 目标斜坡最大角速度（rad/s） |
| `--spd` | `0.3` | 驱动侧速度参数（rad/s）。实测位置模式下生效：0.3 → 约 0.29 rad/s |
| `--cur` | `10` | 驱动侧电流限幅（A）。厂商头/腰/臂 demo 口径为 40 |
| `--release-after-s` | `5` | 轨迹结束/停止后静置多少秒自动失能释放双臂（`0` = 不释放） |
| `--dry-run` | - | 不连接 ROS，仅验证协议 |

### 自动失能（释放双臂）

使能后只要目标非空，`_tick` 就按 `--rate` 无限重发同一组位置目标（轨迹末帧、
同步控制最后姿态）。若永不释放，网页关掉后双臂仍会被 50Hz 顶住：现场无法手动
摆位，其它程序也抢不到 `/arm/cmd`。因此有三道释放：

1. **轨迹结束**（含「发送当前位姿」「回零」「动画真机播放」）：静置
   `--release-after-s` 秒后自动失能；动画真机播放还会在前端收到完成回执时立即失能。
2. **`stop`**：先冻结在最后命令值（僵停保持），随后按同一条静置超时失能。
3. **控制通道客户端断开**：最后一个控制连接消失时立即失能（状态/相机通道只读，不计入）。

失能后再下发动作需要重新 `enable`：前端在「发送当前位姿 / 回零 / 真机播放 / 打开
同步控制」前都会自动补一次使能；`disable` 会清空旧目标，避免重新使能时朝上次的
末帧目标再走一遍。急停（遥控器或软件）仍然立即生效，不依赖上述流程。

### 真机前置条件（重要）

1. 遥控器切入 **topic 控制模式**：`G 中 + E 上`（此模式下仅 C 键有效）
2. 机器人已进入 **归零姿态**（关节主动发力、有阻尼）
3. 灵巧手驱动已启动（Inspire：`ros2 launch inspire_hand right_hand.launch.py` 等）
4. PC/浏览器与机器人同网段（192.168.41.x/24）

急停与僵停由遥控器负责（长按/双击 C 键 = 僵停，无线急停 = 断力瘫软）；桥接仅在软件侧
阻止下发并在急停话题激活时拒绝指令。

## 关节映射

SDK 关节与 URDF 命名不同，映射表见 [`models/tienkung_dex/joint_map.py`](models/tienkung_dex/joint_map.py)：

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

推流链路的隔离与保护（避免预览拖垮关节控制）：

- 相机订阅挂在**独立可重入回调组**，由 `MultiThreadedExecutor(3)` 与 50Hz `/arm/cmd`
  定时器并行执行——单帧解码/编码再慢也不会推迟关节命令；
- 相机回调内任何异常只丢弃该帧并记日志，不会冲出 `spin()` 造成"WebSocket 还活着、
  ROS 回调全停"的假死；
- 帧推送有背压：同一连接上一帧未发完就丢弃本帧（预览只关心最新画面），
  避免弱网时任务堆积；
- 建订阅时的图发现等待（最长 0.6s）在锁外进行，不阻塞回调线程。

## 端口与通道

| 端口 | 通道 | 说明 |
|---|---|---|
| 8081 | 控制 | 接受全部消息，向后兼容单连接客户端 |
| 8082 | 状态 | 只读；`enable` 等控制消息返回 `readonly` |
| 8083 | 相机 | 只读；承载 `camera_list/subscribe/unsubscribe` 与 `camera_frame` |

三个端口复用同一套 JSON 协议，`welcome.channel` 标出当前通道，`welcome` 同时携带
`wsPort/statusPort/cameraPort/beaconPort`，便于前端直接据此建立三条连接。

也可远程安装：`manager/robot_manager.py` 或 `scripts/install-remote.sh` 按固件型号匹配 `Release/robot-editor_*.deb`
（本目录代码已打进 `/opt/robot-editor/dex/`），scp 到机器人后 `apt` 安装，再按需 `systemctl enable/start robot-editor`。

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

所有 C→R 请求可带 `requestId`，`ack` / `error` 会原样回显，前端按它精确匹配并发请求；
旧客户端没有 `requestId` 时仍按 `for` 兼容。`hello` 的 `welcome.channel` 会回显当前连接通道。

`welcome` 额外字段：`controllableGroups`、`legLocked`、`hands`（vendor/count/names/jointMap）、
`cameras`。`status` 额外字段：`estop`、`hands`（各手归一化数值与名称）。

## 已知限制

- 腿部无法通过 SDK 直控，只能经 `/hric/robot/cmd_vel` 行走（遥控器需切策略 + E 上拨）
- 关节状态回传约 12Hz（真机实测），网页端视口同步存在该延迟
- 急停无软件命令话题，仅监测 `/power/board/key_status` 并在激活时停止下发
- 相机深度流（`depth/image_raw`）当前未推送到网页端，仅彩色 JPEG
