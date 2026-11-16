# Robot Motion Editor 安装与使用（.deb）

## 安装（一条命令，自包含）

```bash
sudo apt install ./robot-editor_<version>_<arch>.deb
```

`apt` 会自动装好依赖：`nginx`、`python3`、`python3-websockets`。
装完**不依赖源码目录**，可直接访问 `http://<机器人IP>:3000`。

安装位置：

| 内容 | 路径 |
|---|---|
| 桥接程序 | `/opt/robot-editor/dex/` |
| 桥接配置 | `/etc/robot-editor/bridge.conf` |
| 管理命令 | `/usr/bin/robot-editor` |
| systemd 单元 | `/usr/lib/systemd/system/robot-editor.service` |
| nginx 站点 | `/etc/nginx/sites-available/robot-editor.conf` |
| 前端产物 | `/var/www/robot-editor/`（含模型资源，约 430MB） |
| 文档 | `/usr/share/doc/robot-editor/USAGE.md` |

## 桥接：配置与启动

```bash
sudo robot-editor config nano        # 编辑 ROS_SETUP / 端口 / 手型 / spd / cur
robot-editor check                   # 自检：配置/依赖/ROS 环境、端口
sudo systemctl enable --now robot-editor   # 开机自启 + 立即启动（同时拉起前端 nginx）
robot-editor status                  # 桥接 + nginx 状态、端口、连接地址
robot-editor logs -f                 # 实时日志（journald）
sudo robot-editor restart            # 改完配置重启桥接
```

`robot-editor.service` 按"本项目是一个整体"设计：

- `start robot-editor` → 同时启动**桥接 + 前端 nginx**（`Wants=nginx.service`）；
- `stop robot-editor` → **同时停止桥接与前端**（`PropagatesStopTo=nginx.service`，systemd ≥ 249）；
- `restart robot-editor` 只重启桥接，nginx 不动（前端是静态文件，无需重启）。

关键配置项：

- `ROS_SETUP`：三个 `setup.bash` 绝对路径，冒号分隔
- `WS_PORT` / `STATUS_PORT` / `CAMERA_PORT` / `BEACON_PORT`（相机 0 = 禁用）
- `BRIDGE_HAND`：`auto|brainco|inspire|none`
- `BRIDGE_SPD` / `BRIDGE_CUR` / `BRIDGE_MAX_SPEED`：驱动速度、电流限幅、桥接斜坡
- `BRIDGE_EXTRA`：附加开关，如 `--trace`

> 桥接默认**不自动启用**，避免装完上电就动；确认端口与手型后再 `enable`。

## 前端

nginx 已由包安装并启动，站点监听 3000：

```bash
curl -I http://127.0.0.1:3000/
sudo systemctl status nginx
sudo tail -f /var/log/nginx/robot-editor.access.log
```

- 站点根目录 `/var/www/robot-editor` 由包内产物填充；
- `COOP/COEP` 头已配置（USD/WASM 需要 `SharedArrayBuffer`）；
- 更新前端：在自己机器上 `scripts/build-deb.sh` 重新打包并升级，或开发期用 `scripts/deploy-web.sh` 推送。

## 验证

```bash
ss -ltn | grep -E ':(8081|8082|8083|3000)'
ss -lun | grep ':45678'
```

网页端「设备地址」填机器人 IP → 连接 → 看到关节数即通。

## 卸载

```bash
sudo dpkg -r robot-editor     # 卸载，保留 /etc 配置
sudo dpkg -P robot-editor     # 彻底清除（含 /opt 与 /var/www）
```

## 与网页「固件一键部署」的关系

- `.deb`：机器人本体一次性安装，带 systemd 服务与开机自启（推荐）；
- 网页「固件一键部署」：从操作站远程推送（装到 `~/.robot-motion-bridge/<固件ID>/`，`run.sh` 拉起，无系统服务）；
- 两者跑同一份 `bridge/dex` 代码，**不要同时运行**（抢同一组端口）。
