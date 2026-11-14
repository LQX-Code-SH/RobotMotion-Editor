![screenshot](./docs/screenshot.png)

---

# Robot Motion Editor

[![License](https://img.shields.io/badge/license-Apache--2.0-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-web-orange.svg)](https://github.com/LQX-Code-SH/RobotMotion-Editor)
[![Three.js](https://img.shields.io/badge/Three.js-0.163.0-black.svg)](https://threejs.org/)
[![Vite](https://img.shields.io/badge/Vite-4.5.0-646cff.svg)](https://vitejs.dev/)

## 本项目简介

**Robot Motion Editor** 是一个面向多款人形机器人的动作编辑 Web 平台。在浏览器中完成机器人模型可视化、动作编辑与预览，并通过真机桥接服务把关键帧轨迹下发到真实机器人执行。

- **动作编辑**：3D 视口拖拽关节，配合动画编辑器的 Dope Sheet 与贝塞尔曲线编辑关键帧，支持多 clip、撤销/重做、事件与媒体轨道，工程可保存为 `.robotanim.json`
- **动作预览**：编辑器内实时回放；连接真机后可开启“视口同步”，把机器人姿态实时映射到 3D 视口
- **真机播放**：在动画编辑器工具栏点“真机播放”，把当前 clip 按 fps 采样为关节轨迹下发执行；真机控制面板提供“发送当前位姿”“真机回零”、停止与一键急停
- **设备管理**：按"设备地址"一键连接（直连机器人或经操作站网关），状态、遥测与动作下发集中在一个面板
- **一键部署**：网页端填机器人 IP / 用户名 / 密码 / 固件类型，经操作站 SSH/SFTP 上传桥接并拉起；桥接固定开放 8081 控制 / 8082 状态 / 8083 相机通道
- **模型支持**：URDF / Xacro / MJCF（含并联机构闭链联动）/ USD（部分支持）；内置优必选 Walker S2 / C1 / TienKung Pro / TienKung Dex 四款机型资源
- **机型切换**：页面左上角机型列表按“机器人型号-末端执行器”标识（如 `walker-tienkung-dex-inspire`），切换即预览对应 URDF
- **其他能力**：惯量/质心/坐标系可视化、距离测量、内置 CodeMirror 编辑器、MuJoCo 物理仿真

```bash
pnpm install
pnpm run dev                     # 前端 http://localhost:3000
cd bridge && npm install
npm run station                  # 操作站网关（操作员电脑）
node robot-server.js --adapter mock   # 机器人端桥接（无真机时用模拟器）
```

协议与部署见 [`bridge/README.md`](bridge/README.md)，机型资源见 [`robot/README.md`](robot/README.md)。

## 规划与进度

| 功能 | 状态 |
|---|---|
| 模型可视化与关节编辑（URDF / Xacro / MJCF / USD） | ✅ 已完成 |
| 动画编辑器（关键帧、贝塞尔曲线、多 clip） | ✅ 已完成 |
| 真机桥接服务与设备发现/管理 | ✅ 已完成 |
| 真机控制面板（连接、使能、轨迹播放、急停、视口同步） | ✅ 已完成 |
| 固件一键部署（SSH/SFTP，控制/状态/相机分端口） | ✅ 已完成 |
| Walker S2 / C1 / TienKung Pro 机型资源与关节档案 | ✅ 已完成 |
| **TienKung Dex 真机适配**（桥接服务已完成，待真机联调） | 🔄 **进行中** |
| 优必选 SDK 实机对接 | 🔄 进行中 |
| 实时遥操作（真机低延迟跟随） | ⏳ 计划中 |
| 多机协同与动作库 | ⏳ 计划中 |

## 致谢

本项目基于开源项目 [**fan-ziqi/robot_viewer**](https://github.com/fan-ziqi/robot_viewer)（Apache-2.0 License）开发。感谢原作者及所有贡献者的优秀工作，为本项目的人形机器人动作编辑平台奠定了坚实基础。

同时致谢以下开源项目与资源提供方：

- [urdf-loader](https://github.com/gkjohnson/urdf-loaders) — Three.js 的 URDF 加载器
- [xacro-parser](https://github.com/gkjohnson/xacro-parser) — JavaScript Xacro 解析器
- [mujoco_wasm](https://github.com/zalo/mujoco_wasm) — WebAssembly 版 MuJoCo 物理引擎
- [usd-viewer](https://github.com/needle-tools/usd-viewer) — OpenUSD 查看器
- [mechaverse](https://github.com/jurmy24/mechaverse) — 通用机器人 3D 查看器（设计参考）
- 优必选 Walker S2 模型资源来自 `Walker_S2_description`；Walker C1 / TienKung Pro / TienKung Dex 模型资源来自 `UBTECH-IL-LAB/ubt_sim`

项目采用 [Apache License 2.0](LICENSE) 许可。
