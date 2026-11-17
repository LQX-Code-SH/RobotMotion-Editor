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
- **真机幽灵层**：连接真机后以半透明蓝色镜像显示真机**实际**关节角，与视口目标叠加对比；同步控制下遥测栏额外显示最大跟踪误差
- **键盘控制**：真机控制面板可开启键盘 jog——W/S 前后、A/D 左右、Q/E 升降（机器人基座坐标系），1-6 分别控制横滚/俯仰/偏航的正反方向（绕末端工具轴）；按住连续移动，松开后记录一次关键帧，配合「真机同步控制」可实时驱动机器人
- **末端控制**：控制栏开启后在手臂末端显示平移/旋转 gizmo，拖动即通过数值 IK（阻尼最小二乘 + 一阶 active-set 限位）反解整条关节链，关节面板实时同步，Auto Key 自动记录姿态；下拉菜单可切换平移/旋转、锁定腰部关节、选择左右末端（也可直接点击 3D 中的手臂切换）
- **动作预览**：编辑器内实时回放；连接真机后可用「视口同步」以半透明幽灵层实时显示真机实际姿态（主模型保持为可编辑目标），「读取真机姿态」一次性把真机当前角度拉进视口；反向的「真机同步控制」把视口里的关节拖动 / 末端 IK / 键盘 jog 以约 12.5Hz 节流下发到真机，两者可同时开启
- **真机播放**：在动画编辑器工具栏点“真机播放”，把当前 clip 采样为关节轨迹下发执行——**只播一遍、不循环**，首帧从真机当前位姿平滑过渡（面板限速），手型匹配时手指沿同一时间轴走独立通道；与「真机同步控制」互斥，播放期间自动禁用。真机控制面板提供“发送当前位姿”“真机回零”、停止与一键急停
- **设备管理**：按"设备地址"一键连接（直连机器人或经操作站网关），状态、遥测与动作下发集中在一个面板
- **远程运维管理器**：独立的「robot-editor 管理器」（Tkinter 窗口，含随包 `.deb`）填 IP / SSH 端口 / 用户名 / 密码 / 固件型号（按型号匹配 `Release/robot-editor_*.deb`），即可安装、启停、重启、看日志、改开机自启、卸载；「更多」里可切换安装包目录与四路端口；无 GUI 场景用 `scripts/install-remote.sh`
- **一键安装包**：`scripts/build-deb.sh` 产出自包含 `.deb`（桥接 + nginx 站点 + 完整前端产物），机器人本体一条 `apt install` 装完即可用，带 systemd 服务；安装包随 [GitHub Release](https://github.com/LQX-Code-SH/RobotMotion-Editor/releases/latest) 附件分发（不入仓库）
- **模型支持**：URDF / Xacro / MJCF（含并联机构闭链联动）/ USD（部分支持）；内置优必选 Walker S2 / C1 / TienKung Pro / TienKung Dex 四款机型资源
- **机型切换**：页面左上角机型列表按“机器人型号-末端执行器”标识（如 `walker-tienkung-dex-inspire`），切换即预览对应 URDF
- **其他能力**：惯量/质心/坐标系可视化、距离测量、内置 CodeMirror 编辑器、MuJoCo 物理仿真

## 目录结构

| 路径 | 内容 |
|---|---|
| `src/`、`index.html` | 前端（Three.js 视口、动画编辑器、真机控制面板） |
| `bridge/` | 机器人端桥接 `robot-server.js` 与操作站网关 `station.js` |
| `bridge/dex/` | 天工 DEX 的 ROS 2 桥接（`dex_bridge.py`） |
| `bridge/deploy/` | 型号清单与安装编排（`manifest.json` / `deployer.js` / `cli.js`） |
| `manager/` | **robot-editor 管理器**（Tkinter GUI：安装 / 启停 / 重启 / 日志 / 自启 / 卸载） |
| `packaging/` | `.deb` 打包素材（systemd 单元、postinst、nginx 站点、管理命令） |
| `scripts/` | 构建与部署脚本（`build-deb.sh` / `build-manager.sh` / `install-remote.sh` / `deploy-web.sh`） |
| `Release/` | 本地构建产物（`*.deb` 不入库，随 [GitHub Release](https://github.com/LQX-Code-SH/RobotMotion-Editor/releases) 附件分发） |
| `robot/` | 机型资源（URDF / STL / 贴图，约 400 MB） |
| `tests/` | `node --test` 单元测试 |
| `docs/` | 部署形态与演进路线 |

## 快速开始

```bash
# 1) 开发前端（dev 与 preview 统一 3000）
pnpm install
pnpm run dev                        # http://localhost:3000

# 2) 生产产物 + 打包机器人本体安装包
pnpm run build                      # 输出 dist/
scripts/build-deb.sh                # → Release/robot-editor_<version>_<arch>.deb

# 2a) 机器人本体安装：优先用官方发布包（或自建后拷到机器人）
gh release download v1.5.1 -p '*.deb' -D Release/
# 无 gh 时直接下载：
# https://github.com/LQX-Code-SH/RobotMotion-Editor/releases/download/v1.5.1/robot-editor_1.5.1_arm64.deb
sudo apt install ./Release/robot-editor_1.5.1_arm64.deb   # 机器人上执行

# 2b) 管理器：打包分发，或直接源码运行
scripts/build-manager.sh            # → dist-manager/robot-manager_<version>_<arch>/（增量，秒级）
scripts/build-manager.sh --tar      # 需要拷到别的电脑时再加 tar（deb 用硬链接，不重拷）
python3 manager/robot_manager.py    # 不打包也能直接开窗口（需 python3-tk + paramiko）

# 3) 操作站网关（设备发现 + WS 代理，跑在浏览器那台电脑）
cd bridge && npm install
npm run station -- --host 0.0.0.0   # 仅本机访问可去掉 --host

# 4) 桥接（源码直跑，调试用；正式环境用上面的 .deb）
cd bridge/dex && python3 -u dex_bridge.py --hand inspire --spd 1.5 --cur 40 --max-speed 3.0
```

端口约定：

| 端口 | 用途 |
|---|---|
| 3000 | 前端（dev / preview / nginx 统一） |
| 8090 | 操作站 station（设备发现、WebSocket 代理） |
| 8081 / 8082 / 8083 | 桥接控制 / 状态 / 相机 |
| 45678/UDP | 桥接信标（设备发现） |

同一台机器人装好服务后，浏览器直接访问 `http://<机器人IP>:3000` 即可使用，不需要再开 station；
station 只在“浏览器不直连机器人、需要代为发现设备/代理连接”时才需要。

安装包与桥接用法见 [`packaging/USAGE.md`](packaging/USAGE.md)，协议与远程运维见 [`bridge/README.md`](bridge/README.md)，机型资源见 [`robot/README.md`](robot/README.md)，部署形态与演进路线（本地安装为主，边缘网关 + TLS 为备选）见 [`docs/deployment.md`](docs/deployment.md)。

## 规划与进度

| 功能 | 状态 |
|---|---|
| 模型可视化与关节编辑（URDF / Xacro / MJCF / USD） | ✅ 已完成 |
| 动画编辑器（关键帧、贝塞尔曲线、多 clip） | ✅ 已完成 |
| 真机桥接服务与设备发现/管理 | ✅ 已完成 |
| 真机控制面板（连接、使能、轨迹播放、急停、视口同步、读取姿态、键盘 jog） | ✅ 已完成 |
| 末端笛卡尔空间拖动（IK，含并联主链简化） | ✅ 已完成 |
| 远程运维管理器（GUI：安装 / 启停 / 重启 / 日志 / 自启 / 卸载，型号→`.deb` 匹配） | ✅ 已完成 |
| 自包含 `.deb` 安装包（桥接 + nginx + 前端产物，systemd 托管） | ✅ 已完成 |
| Walker S2 / C1 / TienKung Pro 机型资源与关节档案 | ✅ 已完成 |
| **TienKung Dex 真机适配**（桥接服务已完成，待真机联调） | 🔄 **进行中** |
| 优必选 SDK 实机对接 | 🔄 进行中 |
| 实时遥操作（真机低延迟跟随） | ⏳ 计划中 |
| 多机协同与动作库 | ⏳ 计划中 |
| 边缘网关 + TLS 远程访问（[方案已记录](docs/deployment.md)，暂不开发） | ⏳ 计划中 |

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
