![screenshot](./docs/screenshot.png)

---

# Robot Motion Editor

[![Version](https://img.shields.io/badge/version-v1.5.0-blue.svg)](https://github.com/LQX-Code-SH/RobotMotion-Editor)
[![License](https://img.shields.io/badge/license-Apache--2.0-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-orange.svg)](https://github.com/LQX-Code-SH/RobotMotion-Editor)
[![JavaScript](https://img.shields.io/badge/language-JavaScript-f1e05a.svg)](https://github.com/LQX-Code-SH/RobotMotion-Editor)
[![Three.js](https://img.shields.io/badge/Three.js-0.163.0-black.svg)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-4.5.0-646cff.svg)](https://vitejs.dev/)

**Robot Motion Editor**（原 Robot Viewer）是一个面向多款人形机器人的动作编辑 Web 平台。在浏览器中完成机器人模型可视化、动作编辑与预览，并通过真机桥接服务把关键帧轨迹下发到真实机器人执行。内置支持优必选（UBTech）Walker 系列人形机器人（Walker S2 / C1 / TienKung Pro / TienKung Dex），可搜索管理同一网段下的多台设备。

## 真机动作编辑（Robot Motion Bridge）

- **设备发现与管理**：机器人端部署 `bridge/robot-server.js`，操作员电脑运行 `bridge/station.js` 网关，网页端可搜索、管理同一网段下的全部在线设备并直连
- **动作编辑**：3D 视口拖拽关节 / 动画编辑器录制关键帧（Dope Sheet + 贝塞尔曲线）
- **预览**：编辑器内实时回放，真机"视口同步"模式可将机器人姿态实时映射到 3D 视口
- **真机播放**：动画 clip 按 fps 采样成关键帧轨迹，下发真机执行（带进度与完成回调）
- **安全性**：服务端限位裁剪 + 关节限速 + 一键急停；遥操作（实时跟随）模式已预留
- **机型适配**：`bridge/adapters/` 适配器层，`UbtechAdapter` 提供优必选 SDK 接缝，`MockAdapter` 支持无硬件联调

支持机型的模型与档案资源统一存放在 [`robot/`](robot/README.md) 目录，按机器人类型分目录管理（`robot/<机型>/profile.json` + `robot/<机型>/model/`）。

详细协议与部署说明见 [`bridge/README.md`](bridge/README.md)。

```bash
# 操作员电脑：启动网关
cd bridge && npm install && npm run station

# 机器人端：启动桥接（无真机时用模拟器联调）
node robot-server.js --adapter mock
```

## 模型与编辑器功能

- **Format Support**: URDF / Xacro / MJCF / USD（部分支持）
- **Robot Types**: 串联、分支结构及 MJCF 并联机构（闭链联动）
- **Visualization**: 视觉/碰撞几何、惯量、质心、坐标系、关节轴、阴影、地面网格
- **Animation Editor (Experimental)**: 多 clip Dope Sheet 与贝塞尔曲线编辑器，自动关键帧、多选、撤销/重做、事件与媒体轨道、自动保存、可移植 `.robotanim.json`
- **Measurement Tools**: 关节/连杆距离测量
- **Code Editor**: CodeMirror 编辑器 + 实时预览
- **Physics Simulation**: 内置 MuJoCo 引擎（MJCF 动力学）

## Getting Started

```bash
git clone https://github.com/LQX-Code-SH/RobotMotion-Editor.git
cd RobotMotion-Editor
pnpm install
pnpm run dev      # http://localhost:3000
pnpm run build    # 产物输出到 dist/
pnpm test         # 回归测试
```


## MJCF Parallel Mechanisms

Example mechanisms include the [Robotiq 2F-85 four-bar gripper](https://github.com/google-deepmind/mujoco_menagerie/tree/main/robotiq_2f85) and a [Stewart platform with six closed branches](https://github.com/duccuongvu/stewart_platform_mujoco). Obtain the XML and assets from the source repository, then drag the model folder into the viewer. It opens the robot model XML by default; select `scene.xml` in the file tree when you want the complete scene. Keep the XML and `assets/` together when importing your own models.

Move a Robotiq driver joint or a Stewart `joint_lu_*` slider. The selected coordinate stays fixed at your requested value while passive joints follow to close all branches. The solver changes only joints in the affected closed chain; shared ancestors and unrelated branches keep their poses. Other actuators stay fixed unless coupled to the selected actuator by a joint equality. Sliders, viewport dragging, animation and reset use the same constraint solver. Unreachable edits restore the previous valid pose and show a message in the joint panel.

Supported MJCF constraints are body/site `connect`, body/site `weld` (including relative poses), and polynomial joint equalities. Passive ball joints and floating platforms participate in closure; scalar sliders and animation tracks control hinge/slide joints. The pose editor performs kinematic closure; use **Simulate** for MuJoCo dynamics. Tendon equalities, contact-based closure and arbitrary mechanism-specific inverse kinematics are outside this support.

The importer also handles nested includes, default classes and `childclass`, multiple joints per body, joint anchors/references, degree/radian units and MJCF frame orientations. Controls use radians for rotation and meters for translation.

Additional regression models include Cassie, Robotiq 2F-85 v4, ToddlerBot 2XC and IIT SoftFoot. SoftFoot's original `scene.xml` is supported, including its loading slide and attached foot.

MJCF [`<attach>` model composition](https://mujoco.readthedocs.io/en/stable/XMLreference.html#body-attach) uses the bundled MuJoCo compiler to preserve prefixes, defaults, assets, actuators, sensors and equality references. It supports external body subtrees or whole models, nested/repeated attachments, and placement inside frames. Keep all referenced XML and asset files together; assembly imports require a model that compiles in MuJoCo. Newer self-attachment and named-frame selection syntax are outside the bundled runtime's support and report explicit errors.

On import, joints outside their limits are clamped to the nearest limit. Closed mechanisms then project the assembly within those limits, keeping already valid actuators fixed; linked joints may need to move together to achieve closure. Passive spring joints retain their current deflection whenever closure permits. Spring meshes remain rigid, so directly changing a spring joint can create a visible gap rather than a bent spring.

Run the regression suite with:

```bash
pnpm test
```

Tests cover all six parallel models, forward/reverse motion and reset, complete equality import, actuator preservation, passive ball joints and rejection of unreachable poses. Serial regressions compare every body of Panda, UR5e and Lite6 against MuJoCo `mj_forward` in five poses each. Original XML, licenses, source revisions and references are in `tests/fixtures/mjcf/`. Mesh rendering and physics compilation require the full downloaded examples.

## Contributing

We welcome contributions from the community! Whether you're fixing bugs, adding features, or improving documentation, your help is appreciated.

- **Bug Reports**: Open an [issue](https://github.com/fan-ziqi/robot_viewer/issues) with details
- **Feature Requests**: Discuss ideas in [Discussions](https://github.com/fan-ziqi/robot_viewer/discussions)
- **Pull Requests**: Submit PRs with clear descriptions and tests

## License

This project is licensed under the [Apache License 2.0](LICENSE).

## Acknowledgements

Robot Viewer builds upon the excellent work of the open-source robotics community. This project integrates several powerful open-source projects:

- **[urdf-loader](https://github.com/gkjohnson/urdf-loaders)** - Robust URDF loading for Three.js
- **[xacro-parser](https://github.com/gkjohnson/xacro-parser)** - ROS Xacro file format parser for Javascript
- **[mujoco_wasm](https://github.com/zalo/mujoco_wasm)** - MuJoCo physics engine compiled to WebAssembly
- **[usd-viewer](https://github.com/needle-tools/usd-viewer)** - OpenUSD viewer with rich USDStage support
- **[mechaverse](https://github.com/jurmy24/mechaverse)** - Universal 3D viewer for robot models, providing valuable design inspiration

Special thanks to all the maintainers and contributors of these projects for their foundational work.

Parts of this project were developed with the assistance of [Cursor](https://cursor.sh).
