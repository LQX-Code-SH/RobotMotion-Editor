# Robot Motion Bridge（真机桥接服务）

RobotMotion-Editor 的真机接入层。部署后网页端即可搜索同网段的机器人设备并直连，实现动作编辑、预览与真机播放。

## 架构

```
浏览器 (RobotMotion-Editor)
   │  HTTP GET /api/devices        设备发现与列表
   │  WebSocket /ws?device=<id>    控制指令 / 遥测（station 代理转发）
   ▼
station.js (操作站网关, :8090)
   │  UDP :45678                   信标监听 + discover 探测
   │  WebSocket                    代理转发
   ▼
robot-server.js (机器人端, :8081)  ──►  adapters/*  ──►  机器人 SDK / 硬件
```

- **robot-server.js**：部署在机器人板载计算机上。周期广播 UDP 信标、响应探测、接受 WebSocket 控制指令，并把指令路由给机型适配器。
- **station.js**：运行在操作员电脑。浏览器无法直接发 UDP，因此由 station 代为发现设备（信标 + 广播探测），并提供 WebSocket 反向代理，浏览器经 station 连接任一在线机器人。
- **adapters/**：机型适配层。`MockAdapter` 用于无硬件联调；`UbtechAdapter` 为优必选 Walker 系列接入接缝层（注入 SDK 实现）。

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

网页端"真机控制"面板中填入 station 地址（默认 `ws://localhost:8090`），点击"搜索设备"即可发现设备并连接。

## 机器人端启动参数（robot-server.js）

| 参数 | 默认 | 说明 |
|---|---|---|
| `--adapter` | `mock` | `mock`（模拟器）或 `ubtech`（优必选） |
| `--model` | `walker-s2` | 机型标识，对应 `robot/<机型>/` 目录：walker-s2 / walker-c1 / walker-tienkung-pro / walker-tienkung-dex（详见 [`robot/README.md`](../robot/README.md)） |
| `--name` | 自动 | 设备显示名称 |
| `--ws-port` | `8081` | WebSocket 控制端口 |
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
  "model": "walker-s2", "ips": ["192.168.1.66"], "wsPort": 8081, "state": "ready", "t": 1699900000000 }
```

- 操作站广播 `{"type":"discover","t":...}`，机器人单播回应信标。

### WebSocket 消息（JSON）

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
