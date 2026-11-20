# 多机型适配与安装方案

> 目标：在现有 TienKung Dex 已打通的基础上，以最小代码改动接入 TienKung Pro / Walker S2 / Walker C1，并保证现有功能零回归。
>
> 状态：阶段 0/1 已实施并回归通过；机型适配已按 `bridge/dex/models/<机型>/` 分目录整理，
> Pro / S2 / C1 后端骨架与映射表已离线备好（待真机核对）。阶段 2~4 的真机验证与打包拆分待上机依次进行。

## 1. 背景与现状

### 1.1 当前架构

```
浏览器 (:3000)
 ├─ 机型预览：robot/index.json → robot/<model>/model/urdf/*.urdf
 └─ 真机控制：RobotBridgeClient.js（协议 v1，WS 三通道）
        ├─ 直连 ws://<ip>:8081/8082/8083
        └─ 经 station :8090 代理
              │
机器人端桥接（两套实现）
 ├─ Python：bridge/dex/         ← .deb 实际安装，Dex 真机路径
 │    DexBridge（协议层）+ DexRobot / create_hands / CameraManager（后端）
 └─ Node：bridge/robot-server.js ← 不进 .deb，开发/调试/SDK 接缝
      BaseAdapter + MockAdapter / UbtechAdapter
```

关键事实：

- `scripts/build-deb.sh:36-39` 只把 `bridge/dex/*.py` 打进包，Node 栈不参与生产
- 所有机型共用**一个** `robot-editor_<版本>_<架构>.deb`，靠 `/etc/robot-editor/bridge.conf` 的 `BRIDGE_MODEL` / `BRIDGE_HAND` / `ROS_SETUP` 区分
- `bridge/deploy/manifest.json` 里四个型号的 `package` 字段都指向同一个通配包

**机型适配目录（已实施）**：协议层入口 `bridge/dex/dex_bridge.py` 保持原位（打包/管理脚本引用不变），
机型专属实现按目录分类：

```
bridge/dex/
  dex_bridge.py              # 协议层：WS / UDP / 消息路由，机型无关
  models/
    __init__.py              # 机型注册表 model → 目录；bootstrap() 注入 sys.path
    tienkung_dex/            # Dex（已打通）：joint_map / dex_robot / dex_hands / dex_camera / backend.py
    tienkung_pro/            # Pro（骨架已备）：joint_map / pro_robot / pro_hands / backend.py
    walker_s2/               # S2（骨架已备）：joint_map / backend.py（含 PGC 夹爪）
    walker_c1/               # C1（骨架已备）：joint_map / backend.py
    _walker_common/          # Walker 家族共享 walker_robot / walker_hands
```

每个机型目录的 `backend.create_backends(node, args, log)` 返回 `(robot, hands, cameras)`，
协议层只调这个统一入口。`build-deb.sh` 递归打包 `models/`，入口路径不变。

### 1.2 代码混乱的根源

不是"缺少统一 Backend 接口"，而是**机型元数据散落且硬编码在协议层**：

| 位置 | 问题 |
|---|---|
| `bridge/dex/dex_bridge.py:577-616` | `displayName`/`vendor`/`adapter`/`controllableGroups`/`legLocked` 写死 |
| `bridge/dex/dex_bridge.py:879-889` | `beacon_payload()` 同样写死 `displayName` |
| `scripts/generate-robot-index.mjs:17-45` | `endEffectorOf()` 按机型名 `if` 分支 |
| `robot/<机型>/profile.json` | 已有 `vendor`/`displayName`/`joints`，但 Python 栈不读 |

Node 栈会从 profile 读（`bridge/robot-server.js:132-147`），Python 栈写死，两套行为不一致。

## 2. 机型调研结论

参考仓库：`/home/liu/work/UBTECH-IL-LAB/`（Thinker-IL-LAB，Isaac Sim + LeRobot）。

### 2.1 两大控制家族

| 维度 | TienKung Dex（现状） | TienKung Pro | Walker S2 | Walker C1 |
|---|---|---|---|---|
| 消息族 | `ros2_bridge_msgs` `ArmCtrl` | `bodyctrl_msgs` `CmdSetMotorPosition` | `mc_task_msgs` `RobotCommand` | 同 S2（独立工作空间） |
| 寻址 | 电机 ID `uint16` | 电机 ID `uint16` | **关节名字符串** | 关节名字符串 |
| 控制字段 | `pos/spd/cur/kp/kd/tor` | 仅 `pos/spd/cur`（spd 单位 rpm） | `control_mode=2` + `position/velocity/effort` | 同 S2 |
| 话题 | `/arm/cmd` `/head/cmd` `/waist/cmd` | `/arm/cmd_pos` 等 | `/mc/sdk/robot_command` | 同 S2 |
| 状态 | `/robot_state` 聚合 | `/arm/status` 等分路 | `/mc/sdk/robot_state` | 同 S2 |
| 频率 | 调用方持续 20~50Hz | 同左 | bridge 内部 300Hz 轨迹，末帧保持 | 末帧只发一次 |
| 手 | Inspire 13 码值 / BrainCo 6 电机 | 6 通道 `JointState` | V4 7DOF 手、PGC 1DOF 夹爪、clamp、none | 6 通道压缩手 |
| 相机 | 4 路普通图像 | head RGB+depth | 多路 `shm_msgs/Image*` | 单目 `Image6m` |
| 安全 | 监听急停话题 | 话题控制模式 | SDK 控制器切换 | **必须 `half_sdk`** |
| 环境 | Ubuntu 24.04 + Jazzy + Py3.12 | Ubuntu 22.04 + Humble + Py3.10 | 同 Pro | 同 Pro |

**结论**：没有跨机型统一 SDK。UBTECH-IL-LAB 各插件明确"独立维护、不同 Python 环境、ZMQ + JSON 通信"，关节表在多个 `constants.py` 重复。

### 2.2 模型资源已就位

`robot/` 下四个机型目录齐全，`profile.json` 含完整关节定义。URDF 与 UBTECH 侧同名同大小。关节命名分两派：

- TienKung 系列：`shoulder_pitch_l_joint`（部位 + `_l`/`_r` 后缀）
- Walker 系列：`L_shoulder_pitch_joint`（`L_`/`R_` 前缀）

SDK 常量层手部差异更大：`L_thumb_cmp_joint` ↔ SDK `left_thumb_swing`，且通道数 10 vs 6。控制层必须建立显式映射，不能假设名称一致。

### 2.3 依赖环境不兼容

- Dex 是 Jazzy/Py3.12（Thor 免容器），其余是 Humble/Py3.10，**产物不兼容**
- Walker 消息包需源码 colcon 编译，只有 `bodyctrl_msgs` 有 x86 预编译 deb
- S2 与 C1 消息包名相同（`mc_task_msgs`），C1 必须用独立工作空间 + `WALKER_C1_ROS_WS`
- `ROS_DOMAIN_ID` 真机 0、仿真 146，多机型同网段须隔离

### 2.4 末端执行器现状：两条未关联的链路

| 链路 | 来源 | 决定什么 | 证据 |
|---|---|---|---|
| 预览维度 | 机型下拉 `型号-末端`（如 `walker-tienkung-dex-inspire`） | 只加载哪个 URDF | `scripts/generate-robot-index.mjs:17-45` 从文件名派生；`RobotCatalogUI.js:79-83` |
| 控制维度 | welcome 的 `hands.vendor` | 真机末端类型与通道换算 | `dex_bridge.py:578` 探测；`RobotConnectionUI.js:474-488` `planHandMove` |

两者**没有一致性校验**：选了 `inspire` 预览但真机接 `brainco`，只在 `validateJointMatch()` 打一条 warning，不阻断（`RobotConnectionUI.js:791-803`）。后果是把 Inspire 的 13 通道归一化值套到 BrainCo 的 6 电机上，手指动作错乱。

各机型末端对照（类型命名见 4.2.1）：

| 机型 | 预览变体 | 真机末端类型 | 控制通道 | 语义 |
|---|---|---|---|---|
| Dex | `base` / `brainco` / `inspire` | `inspire-13-code`、`brainco-6-raw`、`none` | `/{side}_hand/angle_set`、`/{side}_hand/set_motor_multi` | 多指归一化数组 0..1 |
| S2 | `clamp` / `gripper` / `hand_v3` / `hand_v4` / `noactuator` | `walker-6-mcp`、`pgc-gripper`、`none` | 手 `/mc/{side}_hand/command` `JointCommand`；夹爪 `/ecat/{side}_grip/cmd` `GripCmd` | **夹爪是 1 DOF 标量**，不是多通道归一化 |
| C1 | `walker_c1` / `walker_c1_with_hands` | `walker-6-mcp`、`none` | `/mc/{side}_hand/command` | 6 通道，短名 `left_thumb_swing` 等 |
| Pro | `tienkung_pro_with_hands` | `pro-6-norm` | `/inspire_hand/ctrl/{side}_hand` `JointState` | 6 通道归一化 0..1 |

**关键**：同为"6 通道"的 Pro 与 Walker 是不同协议与不同 `jointMap` 顺序，不能用同一个类型名，否则前端换算错位。

## 3. 设计原则

| 原则 | 落地方式 |
|---|---|
| 单一真相源 | 机型元数据只在 profile.json 定义，welcome/beacon/前端由它派生 |
| 开闭原则 | 新机型 = 加目录 + 加配置，不改 `endEffectorOf()`、不改 welcome 代码 |
| 接口隔离 | 用 `capabilities` 声明能力，按能力路由，而非统一胖接口 |
| 依赖倒置 | 协议层只依赖能力接口，不依赖具体 SDK 类 |
| 末端与机型解耦 | 末端执行器是**独立维度**，机型 × 末端自由组合；末端类型由协议+单位命名，不由机型名或通道数推断 |
| 先收敛后抽象 | 目前只有一个真机栈跑生产，不做跨栈大重构；夹爪方案等阶段 3 真正遇到时再定 |

**明确不做的三件事**：

1. 不统一 Node / Python 两套协议栈——定位不同（开发接缝 vs 生产），统一成本高收益低
2. 不抽 `bridge/core/` 目录——目前只有一个真机实现，抽象无消费者
3. 不做 12 方法统一 Backend 接口——S2/C1 没有 trajectory 状态机，C1 没有夹爪，Pro 手通道不同，会得到大量空实现

## 4. 修订方案

### 4.1 阶段 0 — 元数据收敛（零回归前提）

**profile.json 扩展**：

```json
{
  "model": "walker-tienkung-dex",
  "vendor": "UBTech",
  "displayName": "Walker TienKung Dex",
  "bridge": {
    "backend": "dex",
    "displayName": "TienKung Dex",
    "capabilities": {
      "jointGroups": ["arm", "head", "waist"],
      "trajectory": true,
      "hands": true,
      "cameras": 4,
      "estop": true,
      "legLocked": true,
      "releaseAfterS": 5
    }
  },
  "assets": {
    "urdf": "model/urdf/tienkung_dex_inspire.urdf",
    "variants": [
      "model/urdf/tienkung_dex_base.urdf",
      "model/urdf/tienkung_dex_brainco.urdf",
      "model/urdf/tienkung_dex_inspire.urdf"
    ],
    "endEffectors": {
      "inspire-13-code": {
        "label": "因时 RH56（13 通道）",
        "channels": 13,
        "unit": "code-0.1deg",
        "urdf": "model/urdf/tienkung_dex_inspire.urdf",
        "jointMap": "hands/inspire_channels.json"
      },
      "brainco-6-raw": {
        "label": "BrainCo（6 电机）",
        "channels": 6,
        "unit": "norm-1to1000",
        "urdf": "model/urdf/tienkung_dex_brainco.urdf",
        "jointMap": "hands/brainco_channels.json"
      }
    }
  }
}
```

**两个字段的职责必须分清**（上一版在此处自相矛盾）：

- `capabilities.hands`：**布尔**，仅表示"该机型是否有手部控制通道"，供协议层决定 `hand_targets` 是 ack 还是 error
- `assets.endEffectors`：**机型支持的可选末端清单**（协议类型、通道数、单位、URDF、jointMap），供前端做类型匹配与换算
- 当前真机**实装**末端由 welcome 的 `hands.type` 报告，不从机型名或 channel 数推断

**两个末端标识必须分清**（否则会破坏机型索引）：

- `variants[].endEffector`（或旧格式文件名派生）：**预览短名**，如 `inspire` / `brainco`，只用于 `index.json` 的机型变体 id（`walker-tienkung-dex-inspire`），不可改成协议类型名
- `assets.endEffectors` 的 key + welcome 的 `hands.type`：**协议类型名**，如 `inspire-13-code`，用于换算策略与错配校验
- 生成器把 `Object.keys(endEffectors)` 作为 additive 字段 `endEffectorTypes` 写进每个 index 条目，供前端比对 welcome 的 `hands.type`

**代码改动**：

- `scripts/generate-robot-index.mjs` 的 `endEffectorOf()`：同时接受字符串数组（旧格式，回退到原启发式）和对象数组（新格式，读 `endEffector`）——保证现有四份 profile 不改也能工作
- `dex_bridge.py` welcome/beacon 的 `displayName`/`adapter` 从 `profile.bridge` 读；读不到时用内置默认值，**不让桥接启动失败**
- welcome 增加 `capabilities`（机型级）与 `hands.type`（实装末端类型）；前端忽略未知字段

**关键约束**：welcome 的 `joints` **保持** `joint_descriptors()` 来源，不要用 profile.json 替换。原因见第 5 节。

### 4.2 阶段 1 — 能力协商

协议层按 `capabilities` 决定 ack 还是 error：

- `capabilities.trajectory` 为 false 时，`play_trajectory` 返回不支持
- `capabilities.hands` 为 **false** 时，`hand_targets` 返回不可用（此处读 4.1 的布尔字段，不读 `assets.endEffectors`）
- `capabilities.cameras` 为 0 时，不注册相机通道

前端按 `capabilities` 显示/隐藏控制面板，按 `hands.type` 选择末端换算策略，不再靠机型字符串判断。

### 4.2.1 末端执行器适配（横切关注点）

末端不是机型的附属字符串，而是**独立的正交维度**。设计分三层。

**第一层：声明（profile.json）**

- `assets.endEffectors`：机型**支持**的末端类型清单（协议类型 / 通道数 / 单位 / URDF / jointMap）
- `assets.variants[].endEffector`：每个预览变体绑定一个末端类型
- 末端类型名**必须包含协议与单位**，不能只写通道数。命名表：

| 类型名 | 机型 | 通道 | 单位 / 协议 | jointMap 来源 |
|---|---|---|---|---|
| `inspire-13-code` | Dex | 13 | 0.1° 角码，逐通道上下限（`INSPIRE_CHANNELS`） | `hands_joint_map('inspire')` |
| `brainco-6-raw` | Dex | 6 | 1~1000 电机码 | `hands_joint_map('brainco')` |
| `pro-6-norm` | Pro | 6 | `JointState` 归一化 0..1 | Pro 侧 6 关节名 |
| `walker-6-mcp` | S2 / C1 | 6 | `JointCommand`，短名 | `left_thumb_swing` 等压缩通道 |
| `pgc-gripper` | S2 | 1 | `GripCmd` 行程标量 | 单元素（复用现有数组路径） |
| `none` | 各 | 0 | 不可控 | — |

**第二层：协商（welcome）—— `hands.type` 的来源必须定死**

`hands.type` 由**桥接后端的 `describe()` 直接返回**，后端知道自己实现的协议类型。核实当前代码：

`bridge/dex/models/tienkung_dex/dex_hands.py`：

```python
    def describe(self):
        return {
            'vendor': self.vendor,
```

`describe()` 目前只返回 `vendor`/`sides`，**没有 `type`**。因此需要在 `BaseHands.describe()` 抽象出 `type` 字段，各后端自行声明：

- `InspireHands.describe()` → `type: 'inspire-13-code'`
- `BrainCoHands.describe()` → `type: 'brainco-6-raw'`
- `NoHands.describe()` → `type: 'none'`
- `FakeHands.describe()`（`dex_bridge.py:330` 的 `vendor='mock'`）→ `type: 'mock-6'`，前端校验时视为通配并提示"dry-run 模式，跳过末端匹配"

**不由前端从 `vendor` 映射**——因为 `vendor='mock'` 无法映射，且同一 vendor 可能有多种单位口径。

前端握手后比对：

- `welcome.hands.type` ∈ `profile.assets.endEffectors` 的键，或为 `mock-*` → 合法
- 不在清单内或为 `none` → 禁用手部 UI，提示"当前真机末端与所选预览末端不匹配"
- 预览变体切换时重新校验，不阻断上肢关节控制

**第三层：换算（桥接后端 + 前端）**

- 桥接：`BaseHands` + `create_hands(node, vendor, log)` 工厂已是抽象点（`dex_hands.py:125-130,329-337`）。新末端实现同一接口（`describe` / `get_state` / `set_normalized` / `clear_error`），在工厂注册即可，协议层不动
- 前端：`handPoseFromState()` / `planHandMove()`（`robotMotion.js:325-403`）按 `jointMap` 数组逐通道换算，`normalizeJointValue()` / `denormalizeJointValue()` 做 0..1 ↔ 关节限位映射
- **夹爪 `pgc-gripper` 无需专门的标量分支**（实施中修正了原判断）：`jointMap` 为单元素时，现有数组路径把单值 0..1 按夹爪关节 lower/upper 映射为开合角，语义正确。桥接侧 `backend.py` 的 `_GripperHands` 负责把归一化值转成 `GripCmd`。已加单测 `pgc-gripper single channel uses the existing array path` 固化此约定

**校验时机**：握手（防错配）→ 预览变体切换（重校验）→ 下发前（通道数一致性，见 `RobotConnectionUI.js:474-488`）。

### 4.3 阶段 2 — 接 TienKung Pro 验证

**依赖**：阶段 0/1 已完成（profile 扩展与能力协商已落地）。以下条件满足后，本阶段**只新增文件，不改已有代码文件**：

- `bridge/backends/tienkung_pro/joint_map.py`（关节 ID ↔ URDF 名 ↔ 限位，复用现有结构）
- `bridge/backends/tienkung_pro/pro_robot.py`（`CmdSetMotorPosition` 发布 + `MotorStatusMsg` 订阅，注意 spd 单位 rpm）
- `bridge/backends/tienkung_pro/pro_hands.py`（6 通道 Inspire `JointState`，实现 `BaseHands` 接口，`describe()` 返回 `type: 'pro-6-norm'`）
- `robot/walker-tienkung-pro/profile.json` 增加 `assets.endEffectors.pro-6-norm` 与变体绑定

不改已有代码文件——这是检验开闭原则是否做到的标准。

真机 welcome 报 `hands.type: pro-6-norm`、预览变体 `tienkung_pro_with_hands` 绑定 `pro-6-norm`，即通过校验。

关节 ID 参考 `ubt_sim/teleoperation/control/tienkung_pro/constants.py:7-35`：头 1/2/3、左臂 11-17、右臂 21-27、腰 31、腿 51-56/61-66。

### 4.4 阶段 3 — Walker 系列

Walker 家族可直接借鉴 UBTECH 侧 `ros2_walker_c1_bridge.py` + `chunk_processor.py` + `constants.py`（真机闭环已完成）。重点：

- S2/C1 按关节名控制，需建立 URDF 名 ↔ `JointCmd.name` 映射
- C1 必须 `half_sdk` 模式，否则收不到 ROS 指令
- 手部通道数 6 vs URDF 10，需压缩映射
- 相机用 `shm_msgs/Image*`，走现有 relay 转 JPEG

末端执行器是本阶段的重点差异（S2 有 5 种变体）：

| 末端类型 | 类型名 | 通道 | 控制话题 | 桥接实现 | 前端换算 |
|---|---|---|---|---|---|
| V4 7DOF 手 | `walker-6-mcp` | 6 | `/mc/{side}_hand/command` `JointCommand` | `BaseHands` 实现 | 多指数组（现有路径） |
| V3 手 | `walker-6-mcp` | 6 | 同上 | 同上 | 同上 |
| PGC 夹爪 | `pgc-gripper` | 1 | `/ecat/{side}_grip/cmd` `GripCmd` | 骨架已备 `_GripperHands`（真机待核对话题） | 复用现有数组路径（4.2.1） |
| clamp | `none`（不可控） | 0 | — | 不实现 | 禁用手部 UI |
| 无末端 | `none` | 0 | — | 不实现 | 禁用手部 UI |

- `assets.variants` 的 5 个 S2 URDF 各自绑定上表末端类型；`noactuator` 与 `clamp` 归为 `none`
- C1 的 `walker_c1.urdf` 预览变体绑定 `none`，`walker_c1_with_hands.urdf` 绑定 `walker-6-mcp`
- 夹爪桥接骨架 `_GripperHands` 已备在 `models/walker_s2/backend.py`，前端复用现有数组路径（无需标量分支）；真机只需核对 `GripCmd` 话题与行程口径

真机实装末端由桥接启动时探测（S2 需切 SDK 控制器 / C1 需 `half_sdk`），握手时与用户所选预览变体的绑定类型比对，不一致则禁用手部控制并提示，不阻断上肢。

### 4.5 阶段 4 — 安装方案

采用分层打包，但**等第二个机型落地后再拆**（现在拆是过早优化）：

```
robot-editor-core_<ver>_<arch>.deb       共用：前端 dist + nginx + 协议层 + 管理命令
robot-editor-<model>_<ver>_<arch>.deb    每机型：ROS2 消息包 + SDK + backend + joint_map + 配置
```

- core 包不依赖具体 backend，单独装可跑 web 界面（dry-run）
- 机型包精确依赖 `robot-editor-core (= 版本)`，避免版本漂移
- ROS2 消息包由构建机 colcon 编译后打进机型包（Jazzy/Humble 分别构建）
- `manifest.json` 的 `firmwares[].package` 改为 `core` + `backend` 两条；`supported: false` 的理由从"尚未打包"改为实际原因
- manager 的型号→包匹配改为两步：先装 core，再装 backend

## 5. 兼容性风险与规避

按上一版字面方案直接改会破坏现有行为，必须规避：

| # | 风险 | 证据 | 规避方式 |
|---|---|---|---|
| 1 | welcome 的 joints 不可用 profile 替换 | `dex_bridge.py:418-432` 的 joints 带 `sdkId`/`sdkName`/`controllable`，限位是真机实测值（head_pitch 0.8727）；profile.json 是 URDF 值（1.0123）且无这些字段 | 保持 `joint_descriptors()` 来源不变 |
| 2 | `displayName` 不一致 | welcome 是 `TienKung Dex`，profile 是 `Walker TienKung Dex`（`profile.json:5`） | 新增 `bridge.displayName`，值保持 `TienKung Dex` |
| 3 | `adapter` 语义冲突 | welcome 是 `dex`，`profile.json:478` 是 `mock`（Node 栈语义） | 新增 `bridge.backend`，不读 `profile.bridge.adapter` |
| 4 | profile 格式破坏 | `profile.json:486-490` 的 `variants` 是字符串数组 | 双格式兼容读取；旧格式回退到原启发式 |
| 5 | 新增运行时文件依赖 | 桥接以前不读 profile.json，`WITH_DIST=0` 打包时可能缺失 | 读不到时回退内置默认值；或放 `/opt/robot-editor/models/` |
| 6 | `releaseAfterS` 前端在用 | `RobotConnectionUI.js:1499` | 放进 capabilities 保证继续下发 |
| 7 | 预览末端与真机末端错配 | 两条链路独立，当前仅打 warning 不阻断（`RobotConnectionUI.js:791-803`） | welcome 报 `hands.type`，握手/切换时比对 `assets.endEffectors`，不匹配禁用手部 UI |
| 8 | 夹爪误用灵巧手语义 | S2 `GripCmd` 是 1 DOF，不是多通道归一化（`dex_hands.py:31-53`） | `pgc-gripper` 类型 + 桥接 `_GripperHands` 转 `GripCmd`；前端单元素 jointMap 复用现有换算（已加单测） |
| 9 | 末端通道数不一致导致换算错位 | URDF 手关节 10 个 vs SDK 6 通道；`hands_joint_map` 顺序敏感（`joint_map.py:114-140`） | 末端类型自带 `channels`/`unit`/`jointMap`，真机微动逐通道核对顺序 |
| 10 | `hands.type` 来源不明导致前端无法分派 | `describe()` 当前无 `type`（`dex_hands.py:139-141`），前端从 `vendor` 映射又无法处理 `vendor='mock'` | 由后端 `describe()` 直接返回 `type`；dry-run 用 `mock-6` 并走通配逻辑 |

## 6. 验证清单

改动前抓取三份 golden 样本：welcome 消息、beacon 消息、`robot/index.json`。

**阶段 0/1 已执行的验证（2026-11-18，全部通过）**：

**离线已执行的验证（无需真机）**：

- [x] welcome / beacon 逐字段 diff：除新增 `capabilities` / `hands.type` 外完全一致（`id` 因进程 PID 变化属预期）
- [x] `index.json` 现有字段不变，新增 additive 字段 `endEffectorTypes`（Dex 两类型 / Pro `pro-6-norm` / C1 `walker-6-mcp` / S2 `walker-6-mcp`+`pgc-gripper`）
- [x] `node --test`：137+1/138 通过（含新增夹爪单通道用例）
- [x] `vite build`：成功，dist 中 profile/index 含新字段
- [x] Python `py_compile`：`dex_bridge.py` + `models/` 全部机型文件通过
- [x] 四种机型 `--dry-run` 启动正常；`--model` 切换加载对应后端；`hands.type: mock-6` 前端按通配放行
- [x] 夹爪单通道换算单测通过（`pgc-gripper single channel uses the existing array path`）

**待真机阶段执行的验证**：

- [ ] 桥接在缺少 profile.json 时仍能启动（回退生效）
- [ ] 末端错配测试：预览选 inspire / 真机报 `brainco-6-raw` 时手部 UI 被禁用，上肢仍可下发
- [ ] 类型区分测试：同为 6 通道的 `pro-6-norm` 与 `walker-6-mcp` 走不同 jointMap，不串用
- [ ] 夹爪实测：S2 `--hand gripper` → welcome `pgc-gripper` → `GripCmd` 话题与开合行程正确
- [ ] 通道顺序测试：逐通道微动，确认 `jointMap` 顺序与真机手指一一对应
- [ ] 真机联调（阶段 2 起）：微动核对关节映射 → 使能 → joint_targets → play_trajectory → estop → 相机 → 手（含夹爪）

真机微动不可跳过：现有 `models/tienkung_dex/joint_map.py:11-12` 的 `elbow_yaw_l_joint` ↔ SDK id 15 映射至今标注"属推断，需真机微动核对"；各新机型骨架的 topic/消息字段/限位均标注了待核对项，上机时按标注逐项确认即可。

## 7. 参考路径

| 用途 | 路径 |
|---|---|
| **机型目录注册表** | `/data/work/robot_viewer/bridge/dex/models/__init__.py` |
| 协议层入口（机型无关） | `/data/work/robot_viewer/bridge/dex/dex_bridge.py` |
| Dex 关节映射模板 | `/data/work/robot_viewer/bridge/dex/models/tienkung_dex/joint_map.py:16-64` |
| Dex 周期发布/急停模板 | `/data/work/robot_viewer/bridge/dex/models/tienkung_dex/dex_robot.py:43-56,129-180` |
| Dex 手型工厂 + 单位换算 | `/data/work/robot_viewer/bridge/dex/models/tienkung_dex/dex_hands.py:31-53,125-141,329-337` |
| Dex 手型 → URDF 映射 | `/data/work/robot_viewer/bridge/dex/models/tienkung_dex/joint_map.py:114-140`（顺序敏感） |
| Pro 后端骨架 | `/data/work/robot_viewer/bridge/dex/models/tienkung_pro/` |
| Walker 共享后端 | `/data/work/robot_viewer/bridge/dex/models/_walker_common/` |
| S2 夹爪实现 | `/data/work/robot_viewer/bridge/dex/models/walker_s2/backend.py` |
| Pro 关节 ID（离线源） | `/home/liu/work/UBTECH-IL-LAB/ubt_sim/teleoperation/control/tienkung_pro/constants.py:7-35` |
| Pro 话题配置（离线源） | `/home/liu/work/UBTECH-IL-LAB/ubt_sim/teleoperation/bridges/tienkung_pro/bridge_config.yaml:14-41` |
| Walker C1 桥接（离线源） | `/home/liu/work/UBTECH-IL-LAB/ubt_IL/walker_c1/ros2_walker_c1_bridge.py` |
| Walker 轨迹处理（离线源） | `/home/liu/work/UBTECH-IL-LAB/ubt_IL/walker_c1/chunk_processor.py` |
| 前端手部换算入口 | `/data/work/robot_viewer/src/features/robot/robotMotion.js:325-403` |
| 夹爪单通道单测 | `/data/work/robot_viewer/tests/robot/robot-motion.test.js`（`pgc-gripper single channel`） |
| S2 夹爪话题（离线源） | `/home/liu/work/UBTECH-IL-LAB/ubt_IL/walker_s2/.../ecat_task_msgs/msg/GripCmd.msg` |
| 相机 relay | `/data/work/robot_viewer/bridge/dex/models/tienkung_dex/dex_camera.py:31-42` |
| URDF/USD 模型 | `/home/liu/work/UBTECH-IL-LAB/ubt_sim/assets/robots/` |
