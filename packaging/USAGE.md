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
robot-editor status                  # 桥接 + nginx 状态、端口、连接地址
robot-editor logs -f                 # 实时日志（journald）
sudo robot-editor restart            # 改完配置重启（桥接 + 前端）
```

桥接与前端始终一起管理，命令等价于 `systemctl <动词> robot-editor nginx`：

```bash
sudo systemctl start   robot-editor nginx   # 启动桥接 + 前端
sudo systemctl stop    robot-editor nginx   # 停止桥接 + 前端
sudo systemctl enable  robot-editor nginx   # 开机自启
sudo systemctl disable robot-editor nginx   # 取消开机自启
```

`/usr/bin/robot-editor` 的 `start` / `stop` / `restart` 已经内置了 `nginx`，不必再手动带；
`robot-editor.service` 还保留 `PropagatesStopTo=nginx.service` 作为兜底（直接 `systemctl stop robot-editor` 时前端也会停）。

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

## 与远程安装（弹窗 / 脚本）的关系

- 直接装：`sudo apt install ./robot-editor_<version>_<arch>.deb`，带 systemd 服务与开机自启；
- 远程装：`manager/robot_manager.py`（GUI）或 `scripts/install-remote.sh`（命令），按固件型号匹配 `Release/` 下的同一个安装包，scp 到机器人后 `apt` 安装，可选 `systemctl enable`，装完点「启动」；
- 两条路径装的是同一个包、同一个 systemd 单元：`dpkg` 按版本升级而不是并存，端口始终只有一组。
