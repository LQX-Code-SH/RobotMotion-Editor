# Robot Resources（机器人资源目录）

存放本平台支持的各机型机器人资源，一台机型一个目录，按机器人类型分目录管理。

## 目录结构

```
robot/
├── walker-s2/                 优必选 Walker S2
│   ├── profile.json           机型档案（关节定义 / 桥接配置 / 模型路径）
│   └── model/                 3D 模型资源（URDF、网格、贴图）
├── walker-c1/                 优必选 Walker C1
├── walker-tienkung-pro/       优必选 Walker TienKung Pro
└── walker-tienkung-dex/       优必选 Walker TienKung Dex（灵巧手）
```

## 机型索引 `index.json`

网页左上角"机型预览"下拉列表读取 `robot/index.json` 切换模型。该文件由脚本自动生成：

```bash
pnpm run robot:index    # 扫描 robot/<机型>/profile.json 的 assets.variants 生成索引
```

变体标识规则为 **`机器人型号-末端执行器`**，例如：

| 标识 | 说明 |
|---|---|
| `walker-s2-hand_v4` | Walker S2 + 灵巧手 v4（默认） |
| `walker-s2-gripper` | Walker S2 + 夹爪 |
| `walker-c1-hands` | Walker C1 + 双手（默认） |
| `walker-c1-none` | Walker C1 无末端执行器 |
| `walker-tienkung-pro-hands` | TienKung Pro + 双手 |
| `walker-tienkung-dex-inspire` | TienKung Dex + Inspire 手（默认） |
| `walker-tienkung-dex-brainco` | TienKung Dex + BrainCo 手 |
| `walker-tienkung-dex-none` | TienKung Dex 无手 |

手部独立 URDF（如 `ubt_left_hand_v3_lite.urdf`、`RH5DG2_L.urdf`）不进入索引，仅作为组合模型的子资源。

## 机型档案 `profile.json`

| 字段 | 说明 |
|---|---|
| `model` | 机型标识，与目录名一致，桥接服务 `--model` 参数使用该值 |
| `vendor` / `displayName` | 厂商与显示名称（设备列表中展示） |
| `joints[]` | 关节定义：`name`、`type`、`lower`/`upper`（限位，rad）、`velocity`（最大速度，rad/s）。当前已由各机型默认 URDF 自动提取；如与真机 SDK 定义不一致，以 SDK 为准修正 |
| `bridge` | 桥接默认配置：`adapter`（`mock`/`ubtech`）、`wsPort`、`beaconPort`、`protocol` 版本 |
| `assets` | 模型资源路径：`urdf`（相对本机型目录）、`meshes`（网格目录） |

## 模型资源 `model/`

放置该机型的 URDF 及网格资源。各机型均已包含可直接加载的 URDF：

| 机型 | 默认 URDF | 结构 | 体积 |
|---|---|---|---|
| walker-s2 | `model/urdf/s2_v1_simple_hand_v4.urdf` | `urdf/`（5 变体）+ `meshes/` | 18M |
| walker-c1 | `model/urdf/walker_c1_with_hands.urdf` | `urdf/` + `meshes/` + `textures/` | 27M |
| walker-tienkung-pro | `model/tienkung_pro_with_hands.urdf` | 单文件 + `meshes/` + `textures/` | 126M |
| walker-tienkung-dex | `model/urdf/tienkung_dex_inspire.urdf` | `urdf/` + `meshes/` + `hands/` + `textures/` | 230M |

可选变体（见各自 `profile.json` 的 `assets.variants`）：

- **walker-s2**（末端可选 hand_v4 / hand_v3 / gripper / clamp / 无执行器）：
  `s2_v1_simple_hand_v4`（默认）、`s2_v1_simple_hand_v3`、`s2_v1_simple_gripper`、`s2_v1_simple_clamp`、`s2_v1_simple_noactuator`
  （已移除 `complex` 高精网格变体，动作编辑用 `simple` 变体即可，体积减少约 217M）
- **walker-c1**：`walker_c1_with_hands.urdf`（双手，默认）、`walker_c1.urdf`（无手）
  （已移除 `with_dummyhands` 占位手变体）
- **walker-tienkung-dex**：`tienkung_dex_inspire.urdf`（默认，RH5DG2 双手）、`tienkung_dex_base.urdf`（无手）、`tienkung_dex_brainco.urdf`（Revo2 双手）

### 资源来源与路径处理

- walker-s2：取自 `Walker_S2_description` 包（10 个 URDF 变体 + `meshes/`），`package://walker_s2_all/meshes/` → `../meshes/`
- 其余机型：取自 `UBTECH-IL-LAB/ubt_sim/assets/robots/`（URDF、mesh、贴图、关键参数文档），USD 场景文件未纳入
  - walker-tienkung-pro：`package://tiangong2pro_urdf/meshes/` → `meshes/`
  - walker-tienkung-dex 灵巧手独立 URDF：`package://RH5DG2_*/meshes/` → `../meshes/`
- 已校验资源完整性：**15 个 URDF 全部可解析，网格引用缺失数为 0**（`robot/` 合计约 399M），并已清理无引用的冗余网格。

在网页端加载对应 URDF 即可在 3D 视口中编辑动作，桥接服务按 `profile.json` 的关节定义与真机对齐。

## 新增机型

1. 复制任一机型目录为 `robot/<新机型>/`，重命名为新机型标识；
2. 修改 `profile.json` 的 `model`/`displayName`/`joints`；
3. 将 URDF 与网格放入 `model/`；
4. 机器人端启动：`node bridge/robot-server.js --model <新机型>`。
