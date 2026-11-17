# Robot Motion Bridge（真机桥接服务）

RobotMotion-Editor 的真机接入层。部署后网页端即可搜索同网段的机器人设备并直连，实现动作编辑、预览与真机播放。

## 架构

```
浏览器 (RobotMotion-Editor)
   │  HTTP GET  /api/devices        设备发现与列表
   │  WebSocket /ws?device=<id>     控制指令 / 遥测（station 代理转发）
   ▼
station.js (操作站网关, :8090)
   │  UDP :45678                   信标监听 + discover 探测
   │  SSH/SFTP :22                 推送固件、拉起服务（仅部署时）
   │  WebSocket                    代理转发到机器人
   ▼
机器人端桥接
   ├── :8081  控制通道（全部消息，向后兼容）
   ├── :8082  状态通道（只读遥测）
   ├── :8083  相机通道（只读 JPEG 推流，仅 DEX）
   └── :45678 UDP 设备发现
```

- **robot-server.js**：部署在机器人板载计算机上。周期广播 UDP 信标、响应探测、接受 WebSocket 控制指令，并把指令路由给机型适配器。
- **station.js**：运行在操作员电脑。浏览器无法直接发 UDP，因此由 station 代为发现设备（信标 + 广播探测），并提供 WebSocket 反向代理；同时提供设备列表 API。
- **deploy/**：固件清单与部署编排。`manifest.json` 定义固件类型、文件清单、默认端口；`deployer.js` 负责预检、上传、依赖安装、启停与校验。
- **adapters/**：机型适配层。`MockAdapter` 用于无硬件联调；`UbtechAdapter` 为优必选 Walker 系列接入接缝层（注入 SDK 实现）。
- **dex/**：天工 DEX（TienKung Dex）真机 Python 桥接，直连 ROS 2 话题，支持 31 个身体关节、BrainCo/Inspire 灵巧手与 4 路相机推流，协议与 Node 版一致并扩展了手部/相机消息。详见 [`dex/README.md`](dex/README.md)。

## 端口约定

| 端口 | 协议 | 用途 | 说明 |
|---|---|---|---|
| 8081 | WebSocket | 控制通道 | 接受全部消息；网页端默认连接此端口 |
| 8082 | WebSocket | 状态通道 | 只读：`hello` / `get_status` + 周期 `status`；其余消息返回 `readonly` |
| 8083 | WebSocket | 相机通道 | 只读：`camera_list` / `camera_subscribe` / `camera_unsubscribe`（Node 版不监听） |
| 45678 | UDP | 设备发现 | 信标广播与 `discover` 探测 |
| 8090 | HTTP/WS | station 网关 | 设备列表、部署 API、WS 代理 |
| 22 | TCP | SSH | 管理器 / 脚本安装与运维时使用，可自定义 |

控制通道保持向后兼容：单连 8081 仍可收到全部消息。分端口的意义在于把高频遥测与相机流从控制连接上剥离。

## 快速开始

```bash
cd bridge
npm install

# 1. 启动操作站网关（操作员电脑）
npm run station

# 2. 启动机器人桥接（真机板载计算机；无真机时用模拟器）
npm run robot:mock          # 模拟器
npm run robot               # 默认 walker-s2 + mock 适配器
```

网页端"真机控制"面板填入"设备地址"后点"连接"，一个地址只对应一台设备：

- 填机器人 IP（如 `192.168.41.2`）：直连控制口 8081；若该 IP 在操作站注册过，会自动改用其注册端口；
- 填操作站地址（如 `http://192.168.1.100:8090`）：从操作站取该网段在线设备并连接；
- 失败时状态栏显示原因（如"未发现设备"、"无法访问操作站"）。

面板只保留"连接/断开"：连接成功后会自动下发一次 `enable`（失败仅在日志告警，不阻断连接），不再提供手动使能/失能按钮。

使能意味着桥接会按 `--rate` 持续重发同一组目标（关节保持）。为免"用过一次就一直占用双臂"，释放有三处：点「断开」或关闭「真机同步控制」时前端补发 `disable`；动画真机播放结束立即失能；轨迹结束/停止后静置 `--release-after-s` 秒（默认 5，Dex 桥接）自动失能；控制通道最后一个客户端断开时桥接也会自动失能。再次下发动作前前端会自动补 `enable`。

> station 默认只监听 `127.0.0.1`：仅供本机浏览器访问设备列表与 WS 代理。
> 若浏览器与 station 不同机，加 `npm run station -- --host 0.0.0.0` 并确认网络可信。

## 远程运维（管理器 / 脚本）

机器人端服务由自包含 `.deb` 提供，两个入口等价，都**不经 station**、直接 SSH 到机器人：

| 入口 | 场景 |
|---|---|
| `manager/robot_manager.py`（GUI，随包含 `.deb`） | 日常运维：安装 / 启停 / 重启 / 日志 / 开机自启 / 卸载 |
| `scripts/install-remote.sh`（命令行） | 无图形界面、批量或自动化 |

安装流程（GUI 用 Python 实现，脚本复用 `deploy/deployer.js`，步骤一致）：

| 步骤 | 动作 |
|---|---|
| 1 | 按固件型号匹配 `Release/robot-editor_*.deb`（多版本取最高版本） |
| 2 | SSH 连接（密码或私钥，12s 超时） |
| 3 | scp 上传安装包到 `/tmp/`（带进度） |
| 4 | `apt-get install -y` 安装（自动补 nginx / python3-websockets 依赖，保留已有 bridge.conf） |
| 5 | 写入 `/etc/robot-editor/bridge.conf`（机型 + 四路端口 + 型号参数） |
| 6 | 可选 `systemctl enable`；若服务原本在运行则重启一次应用新代码 |
| 7 | 校验包版本、桥接程序与前端 3000，回传 journald 尾部 |

安装**默认不启动**桥接（避免装完上电就动）；装完点「启动」或在脚本里 `start`。

启动 / 停止 / 重启 / 开机自启都成对作用于桥接与前端 nginx：

| 操作 | 实际命令 |
|---|---|
| 启动 | `systemctl start robot-editor nginx` |
| 停止 | `systemctl stop robot-editor nginx` |
| 重启 | `systemctl restart robot-editor nginx` |
| 开机自启 | `systemctl enable robot-editor nginx` |
| 取消自启 | `systemctl disable robot-editor nginx` |

安装时会先确保前端 3000 可用（`systemctl enable --now nginx`），否则前端打开是空白/拒绝连接。

管理器：

```bash
scripts/build-manager.sh            # 增量更新 dist-manager/（deb 用硬链接，秒级）
dist-manager/robot-manager_<ver>_<arch>/run-manager.sh
```

脚本：

```bash
scripts/install-remote.sh list                                    # 列型号 → 匹配到的安装包
scripts/install-remote.sh install --host 192.168.41.2 --user nvidia --enable
scripts/install-remote.sh status  --host 192.168.41.2 --user nvidia
scripts/install-remote.sh start|stop|restart|logs --host <IP> --user <用户名>
```

密码交互输入（不回显）；自动化时预设 `ROBOT_SSH_PASSWORD`。型号 `--firmware` 默认 `tienkung_dex`。

卸载（管理器「卸载…」或脚本）：

```bash
scripts/install-remote.sh uninstall --host <IP> --user <用户名>          # dpkg -r，保留配置
scripts/install-remote.sh uninstall --host <IP> --user <用户名> --purge  # dpkg -P，彻底删除
```

安全约定：

- 密码只在管理进程内存中用于一次 SSH 握手；远端非 root 时同一份密码经 `sudo -S` 的 stdin 提权，不写进命令行、不写日志、不回传、不落盘；GUI 也不写本地存储；
- 所有端口、型号参数与用户名经校验，远端命令参数走白名单 + shell 引号转义；写入 `bridge.conf` 的键名与值都有正则白名单；
- 同一台机器人同时只允许一个安装任务（脚本侧实际执行时间很短，管理器里按钮会自动禁用）。

固件型号清单见 [`deploy/manifest.json`](deploy/manifest.json)：型号（`tienkung_dex` / `tienkung_pro` / `walker_c1` / `walker_s2`）是参数列表，每个型号用 `package` 指定 `Release/` 下的匹配模式、用 `ports` 覆盖默认端口；当前只有 `tienkung_dex` 已打包，其余型号会被拦下并提示。

## 机器人端启动参数（robot-server.js）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--adapter` | `mock` | `mock`（模拟器）或 `ubtech`（优必选） |
| `--model` | `walker-s2` | 机型标识，对应 `robot/<机型>/` 目录：walker-s2 / walker-c1 / walker-tienkung-pro / walker-tienkung-dex（详见 [`robot/README.md`](../robot/README.md)） |
| `--name` | 自动 | 设备显示名称 |
| `--ws-port` | `8081` | WebSocket 控制通道端口 |
| `--status-port` | `8082` | 只读状态通道端口（0 = 禁用） |
| `--beacon-port` | `45678` | UDP 发现端口 |
| `--sdk-module` | 无 | 优必选 SDK 实现模块路径（见下文） |

## 接入优必选 Walker 系列真机

1. 在 `robot/<机型>/profile.json` 中将 `joints` 替换为真实关节定义（来自机型 URDF 或 SDK 文档：名称/限位/最大速度），并把 URDF/网格放入 `robot/<机型>/model/`。
2. 实现优必选 SDK 封装模块（示例 `ubtech-sdk-impl.js`）：

```js
// ubtech-sdk-impl.js
export default function createSdk(profile, options) {
  return {
    async init() { /* 连接机器人控制器 */ },
    async enable() { /* 上电使能 */ },
    async disable() { /* 下电失能 */ },
    async setJointTargets(targets) { /* 下发单步关节目标（弧度，已限位） */ },
    async playTrajectory(frames, fps, loop) { /* 下发并执行轨迹 */ },
    async stop() { /* 平滑停止 */ },
    async emergencyStop() { /* 急停 */ },
    getJointStates() { return {}; }, // {joint: {position, velocity, effort, temperature}}
    async dispose() {}
  };
}
```

3. 启动：

```bash
node robot-server.js --adapter ubtech --model walker-s2 --sdk-module ./ubtech-sdk-impl.js
```

未提供 `--sdk-module` 时适配器以 dry-run 模式运行（只打日志，不下发硬件指令），可用于验证链路。

## 通信协议

### 设备发现（UDP :45678）

- 机器人每 2s 广播信标：

```json
{ "type": "robot-beacon", "protocol": 1, "id": "walker-s2-1a2b3c", "name": "Walker S2 #01",
  "model": "walker-s2", "ips": ["192.168.1.66"], "wsPort": 8081,
  "statusPort": 8082, "cameraPort": 0, "beaconPort": 45678,
  "state": "ready", "t": 1699900000000 }
```

- 操作站广播 `{"type":"discover","t":...}`，机器人单播回应信标。
- `statusPort` / `cameraPort` 为 0 表示该机型不提供对应通道。

### WebSocket 消息（JSON）

同一套 JSON 协议在 8081/8082/8083 上复用，`welcome` 的 `channel` 字段标识当前通道：

| 通道 | 端口 | 允许的客户端消息 | 推送 |
|---|---|---|---|
| control | 8081 | 全部 | 全部 |
| status | 8082 | `hello`、`get_status` | `status`、`robot_event`、`trajectory_done` |
| camera | 8083 | `hello`、`get_status`、`camera_*` | `cameras`、`camera_frame` |

非本通道消息会返回 `{"type":"error","code":"readonly"}`。

浏览器 → 机器人：

| type | 字段 | 说明 |
|---|---|---|
| `hello` | - | 握手，机器人回 `welcome` |
| `get_status` | - | 立即获取一次状态 |
| `set_mode` | `mode: idle\|follow\|execute` | 切换工作模式 |
| `enable` / `disable` | - | 上电使能 / 下电失能 |
| `joint_targets` | `targets: {joint: rad}` | follow 模式单步目标（遥操作） |
| `play_trajectory` | `trajectoryId, frames:[{t, targets}], fps, loop` | 下发关键帧轨迹并执行，t 为毫秒 |
| `stop` | - | 平滑停止 |
| `estop` | - | 急停（最高优先级） |

机器人 → 浏览器：

| type | 说明 |
|---|---|
| `welcome` | 设备档案：id/名称/机型/关节定义（名称、限位、最大速度） |
| `status` | 周期遥测：`state/mode/enabled/jointStates{position,velocity,effort,temperature}` |
| `ack` | 指令确认，含 `accepted` 与失败原因 |
| `trajectory_done` | 轨迹执行完成 |
| `robot_event` | 机器人侧事件（告警/错误） |
| `error` | 协议错误（`code` + `message`） |

### 安全约定

- 所有下发关节目标在服务端经**限位裁剪**（`robot/<机型>/profile.json` 的 lower/upper）；
- `follow` 模式单步目标由适配器按关节**最大速度限速**执行；
- `estop` 在服务端最短路径直达适配器，不排队；
- 轨迹下发前网页端会与机器人关节定义做一致性校验，关节名不匹配将被拒绝。
