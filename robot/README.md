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

## 机型档案 `profile.json`

| 字段 | 说明 |
|---|---|
| `model` | 机型标识，与目录名一致，桥接服务 `--model` 参数使用该值 |
| `vendor` / `displayName` | 厂商与显示名称（设备列表中展示） |
| `joints[]` | 关节定义：`name`、`type`、`lower`/`upper`（限位，rad）、`velocity`（最大速度，rad/s）。**接真机前必须替换为真实定义** |
| `bridge` | 桥接默认配置：`adapter`（`mock`/`ubtech`）、`wsPort`、`beaconPort`、`protocol` 版本 |
| `assets` | 模型资源路径：`urdf`（相对本机型目录）、`meshes`（网格目录） |

## 模型资源 `model/`

放置该机型的 URDF 及网格资源，约定：

```
<机型>/model/
├── <机型>.urdf      机器人模型描述
└── meshes/          视觉/碰撞网格（STL/DAE/OBJ）
```

在网页端加载该目录中的 URDF 即可在 3D 视口中编辑动作，桥接服务按 `profile.json` 的关节定义与真机对齐。

## 新增机型

1. 复制任一机型目录为 `robot/<新机型>/`，重命名为新机型标识；
2. 修改 `profile.json` 的 `model`/`displayName`/`joints`；
3. 将 URDF 与网格放入 `model/`；
4. 机器人端启动：`node bridge/robot-server.js --model <新机型>`。
