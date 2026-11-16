#!/usr/bin/env python3
"""
robot-editor 管理器（可视化窗口，自带 Release 安装包）。

职责：远程安装 / 启动 / 停止 / 重启 / 状态 / 日志 / 开机自启 / 卸载。

打包后目录结构：
    robot-manager_<version>_<arch>/
        robot_manager.py        本程序
        manifest.json           固件型号配置（型号 → .deb 匹配模式 / 端口）
        Release/*.deb           随包分发的安装包
        run-manager.sh          双击启动

用法：
    ./run-manager.sh                    # 打开窗口
    python3 robot_manager.py --list     # 无界面自检：列型号与匹配到的安装包

依赖：python3-tk（系统）、paramiko（SSH/SFTP）。
"""

import fnmatch
import json
import os
import queue
import re
import shlex
import sys
import threading
import time
import warnings

# paramiko 2.x 在 cryptography 42+ 上会刷 TripleDES 弃用警告，与安装流程无关
warnings.filterwarnings("ignore", message=".*TripleDES.*")

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, scrolledtext, ttk
except ImportError:  # 无 GUI 环境（如 --list 自检）
    tk = None

try:
    import paramiko
except ImportError:
    paramiko = None


DEFAULT_FIRMWARE = "tienkung_dex"
PORT_KEYS = ("control", "status", "camera", "beacon")
FALLBACK_PORTS = {"control": 8081, "status": 8082, "camera": 8083, "beacon": 45678}


# ============================================================
# 配置与安装包解析
# ============================================================

def script_dir():
    return os.path.dirname(os.path.abspath(__file__))


def load_manifest(base=None):
    base = base or script_dir()
    candidates = [
        os.path.join(base, "manifest.json"),
        os.path.join(base, "..", "bridge", "deploy", "manifest.json"),
        os.path.join(base, "..", "..", "bridge", "deploy", "manifest.json"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as handle:
                return json.load(handle), os.path.abspath(path)
    return {"version": 0, "defaults": {"ports": dict(FALLBACK_PORTS)}, "firmwares": []}, ""


def find_release_dir(base=None):
    base = base or script_dir()
    for path in (os.path.join(base, "Release"), os.path.join(base, "..", "Release")):
        if os.path.isdir(path):
            return os.path.abspath(path)
    return None


def compare_version(left, right):
    def pick(value):
        parts = []
        for piece in re.split(r"[.+-]", str(value or "")):
            parts.append(int(piece) if piece.isdigit() else piece)
        return parts

    a, b = pick(left), pick(right)
    for index in range(max(len(a), len(b))):
        x = a[index] if index < len(a) else 0
        y = b[index] if index < len(b) else 0
        if isinstance(x, int) and isinstance(y, int):
            if x != y:
                return x - y
        else:
            if str(x) != str(y):
                return -1 if str(x) < str(y) else 1
    return 0


def parse_package_name(name):
    match = re.match(r"^(.+)_([0-9][^_]*)_([a-z0-9]+)\.deb$", name, re.IGNORECASE)
    if not match:
        return None
    return {"version": match.group(2), "arch": match.group(3)}


def resolve_package(firmware, defaults, release_dir):
    """返回 (包信息 dict, 错误信息)。多个版本取最高版本。"""
    if firmware.get("supported") is False:
        return None, firmware.get("reason") or f"{firmware.get('id')} 暂不支持安装"
    pattern = firmware.get("package") or defaults.get("package")
    if not pattern:
        return None, "该型号未配置安装包（package）"
    if not release_dir:
        return None, "找不到 Release 目录：安装包未随本程序分发"

    candidates = []
    for name in os.listdir(release_dir):
        if not fnmatch.fnmatchcase(name, pattern):
            continue
        meta = parse_package_name(name)
        if not meta:
            continue
        path = os.path.join(release_dir, name)
        candidates.append({
            "name": name,
            "path": path,
            "version": meta["version"],
            "arch": meta["arch"],
            "size": os.path.getsize(path),
        })
    if not candidates:
        return None, f"Release/ 下没有匹配 {pattern} 的安装包"
    candidates.sort(key=lambda item: VersionKey(item["version"]), reverse=True)
    return candidates[0], ""


class VersionKey:
    """给 sorted 用的版本比较包装。"""

    def __init__(self, version):
        self.version = version

    def __lt__(self, other):
        return compare_version(self.version, other.version) < 0

    def __eq__(self, other):
        return compare_version(self.version, other.version) == 0


def firmware_list(manifest, directory=None):
    defaults = manifest.get("defaults", {})
    default_ports = {**FALLBACK_PORTS, **defaults.get("ports", {})}
    release_dir = directory or find_release_dir()
    items = []
    for firmware in manifest.get("firmwares", []):
        ports = {**default_ports, **firmware.get("ports", {})}
        package, error = resolve_package(firmware, defaults, release_dir)
        items.append({
            "id": firmware.get("id"),
            "label": firmware.get("label") or firmware.get("id"),
            "supported": firmware.get("supported") is not False,
            "reason": firmware.get("reason", ""),
            "service": firmware.get("service") or defaults.get("service") or "robot-editor",
            "model": firmware.get("model", ""),
            "config": firmware.get("config", {}),
            "ports": ports,
            "pattern": firmware.get("package") or defaults.get("package"),
            "package": package,
            "package_error": error,
        })
    return items


def scan_packages(directory, pattern):
    """扫描目录下的 .deb，匹配型号模式的排在前面，同级按版本降序。"""
    if not directory or not os.path.isdir(directory):
        return []
    items = []
    for name in os.listdir(directory):
        if not name.lower().endswith(".deb"):
            continue
        meta = parse_package_name(name) or {"version": "0", "arch": "?"}
        path = os.path.join(directory, name)
        items.append({
            "name": name,
            "path": path,
            "version": meta["version"],
            "arch": meta["arch"],
            "size": os.path.getsize(path),
            "matches": bool(pattern) and fnmatch.fnmatchcase(name, pattern),
        })
    items.sort(key=lambda item: VersionKey(item["version"]), reverse=True)
    items.sort(key=lambda item: not item["matches"])
    return items


def print_list(directory=None):
    manifest, manifest_path = load_manifest()
    release_dir = directory or find_release_dir()
    print(f"配置：{manifest_path or '未找到'}")
    print(f"安装包目录：{release_dir or '未找到'}")
    items = firmware_list(manifest, release_dir)
    matched = set()
    for item in items:
        if item["package"]:
            matched.add(item["package"]["name"])
            state = f'{item["package"]["name"]}（{item["package"]["size"] / 1024 / 1024:.1f} MB）'
        else:
            state = f'不可用：{item["package_error"]}'
        mark = "✓" if item["package"] else "·"
        print(f"  {mark} {item['id']:<14} {item['label']}  →  {state}")

    extra = [entry for entry in scan_packages(release_dir, None) if entry["name"] not in matched]
    if extra:
        print("目录内其它安装包（可在「更多」里手动指定）：")
        for entry in extra:
            print(f'  · {entry["name"]}（{entry["size"] / 1024 / 1024:.1f} MB · {entry["arch"]}）')


# ============================================================
# 远端操作（paramiko）
# ============================================================

class RemoteInstaller:
    """一次安装会话：SSH 连接 → 上传 → apt 安装 → 写配置 → 可选 enable。"""

    def __init__(self, host, port, username, password, log):
        self.host = host
        self.port = int(port)
        self.username = username
        self.password = password
        self.log = log
        self.client = None
        self.is_root = False

    # ---------- 连接 ----------
    def connect(self):
        if paramiko is None:
            raise RuntimeError("缺少 paramiko：请先执行 pip3 install paramiko")
        self.log("system", f"连接 {self.username}@{self.host}:{self.port} …")
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            hostname=self.host,
            port=self.port,
            username=self.username,
            password=self.password,
            timeout=12,
            banner_timeout=12,
            auth_timeout=12,
            look_for_keys=False,
            allow_agent=False,
        )
        self.client = client
        code, out = self.run("id -u")
        self.is_root = code == 0 and out.strip() == "0"
        self.log("system", f"已连接（{'root' if self.is_root else 'sudo 提权'}）")

    def close(self):
        if self.client is not None:
            try:
                self.client.close()
            except Exception:
                pass
            self.client = None

    # ---------- 执行 ----------
    def run(self, command, sudo=False, timeout=600):
        """执行远端命令，返回 (exit_code, 合并输出)。sudo 时用 stdin 传密码。"""
        if self.client is None:
            raise RuntimeError("SSH 尚未连接")
        use_sudo = sudo and not self.is_root
        if use_sudo:
            command = f"sudo -S -p '' {command}"

        channel = self.client.get_transport().open_session()
        channel.settimeout(timeout)
        channel.exec_command(command)
        if use_sudo:
            channel.sendall((self.password + "\n").encode())

        output = bytearray()
        deadline = time.time() + timeout
        while True:
            if channel.recv_ready():
                output.extend(channel.recv(65536))
            elif channel.recv_stderr_ready():
                output.extend(channel.recv_stderr(65536))
            elif channel.exit_status_ready():
                break
            elif time.time() > deadline:
                channel.close()
                raise TimeoutError(f"远端命令超时（{timeout}s）：{command[:80]}")
            else:
                time.sleep(0.02)

        code = channel.recv_exit_status()
        channel.close()
        return code, output.decode("utf-8", errors="replace")

    def run_checked(self, command, sudo=False, timeout=600):
        code, out = self.run(command, sudo=sudo, timeout=timeout)
        if code != 0:
            detail = " ".join(line for line in out.strip().splitlines()[-3:])
            raise RuntimeError(f"命令失败（code {code}）：{detail or command[:120]}")
        return out

    # ---------- 查询 ----------
    def installed_version(self, service):
        _, out = self.run(f"dpkg-query -W -f='${{Version}}' {shlex.quote(service)} 2>/dev/null || true")
        return out.strip()

    def service_active(self, service):
        _, out = self.run(f"systemctl is-active {shlex.quote(service)} 2>/dev/null || true")
        state = out.strip() or "unknown"
        return state == "active", state

    def listening_ports(self):
        """返回远端正在监听的 TCP/UDP 端口集合。"""
        result = set()
        for flag in ("-ltn", "-lun"):
            _, out = self.run(
                f"(ss {flag} 2>/dev/null || netstat {flag} 2>/dev/null) "
                "| awk '{print $4}' | sed 's/.*://' | sort -u"
            )
            for line in out.splitlines():
                line = line.strip()
                if line.isdigit():
                    result.add(int(line))
        return result

    def log_tail(self, service, lines=20):
        _, out = self.run(
            f"journalctl -u {shlex.quote(service)} -n {lines} --no-pager 2>/dev/null || true"
        )
        return out.strip()

    # ---------- 安装 ----------
    def upload(self, local_path, remote_path, progress=None):
        sftp = self.client.open_sftp()
        try:
            sftp.put(local_path, remote_path, callback=progress)
        finally:
            sftp.close()

    def apply_config(self, config_path, updates):
        script = [
            f"conf={shlex.quote(config_path)}",
            'if [ ! -f "$conf" ]; then echo "缺少配置文件 $conf" >&2; exit 1; fi',
            "set_val() {",
            '  k="$1"; v="$2"',
            '  if grep -q "^$k=" "$conf"; then sed -i "s|^$k=.*|$k=$v|" "$conf"; '
            'else printf "%s=%s\\n" "$k" "$v" >> "$conf"; fi',
            "}",
        ]
        for key, value in updates.items():
            script.append(f"set_val {shlex.quote(key)} {shlex.quote(str(value))}")
        script.append('echo "已更新 $conf"')
        self.run_checked(f"bash -c {shlex.quote(chr(10).join(script))}", sudo=True, timeout=60)


# ============================================================
# GUI
# ============================================================

class InstallerApp(tk.Tk if tk else object):
    def __init__(self, manifest, manifest_path):
        super().__init__()
        self.title("robot-editor 管理器")
        self.geometry("620x640")
        self.minsize(560, 560)

        self.manifest = manifest
        self.manifest_path = manifest_path
        self.firmwares = firmware_list(manifest)
        self.defaults = manifest.get("defaults", {})
        self.service = self.defaults.get("service", "robot-editor")
        self.config_path = self.defaults.get("configPath", "/etc/robot-editor/bridge.conf")
        self.busy = False
        self.events = queue.Queue()
        self.package_candidates = []
        self.package_dir = None   # None = 使用随包的 Release/
        self._purge_requested = False

        self._build()
        self._render_firmware()
        self.after(80, self._drain_events)

    # ---------- 布局 ----------
    def _build(self):
        pad = {"padx": 6, "pady": 4}
        root = ttk.Frame(self, padding=10)
        root.pack(fill="both", expand=True)

        conn = ttk.LabelFrame(root, text="连接信息", padding=8)
        conn.pack(fill="x")
        conn.columnconfigure(1, weight=1)
        conn.columnconfigure(3, weight=1)

        ttk.Label(conn, text="机器人 IP").grid(row=0, column=0, sticky="w", **pad)
        self.host_var = tk.StringVar()
        ttk.Entry(conn, textvariable=self.host_var).grid(row=0, column=1, sticky="ew", **pad)

        ttk.Label(conn, text="SSH 端口").grid(row=0, column=2, sticky="w", **pad)
        self.port_var = tk.StringVar(value="22")
        ttk.Entry(conn, textvariable=self.port_var, width=8).grid(row=0, column=3, sticky="ew", **pad)

        ttk.Label(conn, text="用户名").grid(row=1, column=0, sticky="w", **pad)
        self.user_var = tk.StringVar()
        ttk.Entry(conn, textvariable=self.user_var).grid(row=1, column=1, sticky="ew", **pad)

        ttk.Label(conn, text="登录密码").grid(row=1, column=2, sticky="w", **pad)
        self.password_var = tk.StringVar()
        ttk.Entry(conn, textvariable=self.password_var, show="•").grid(row=1, column=3, sticky="ew", **pad)

        model = ttk.LabelFrame(root, text="固件型号", padding=8)
        model.pack(fill="x", pady=(8, 0))
        model.columnconfigure(1, weight=1)

        ttk.Label(model, text="型号").grid(row=0, column=0, sticky="w", **pad)
        self.firmware_var = tk.StringVar()
        self.firmware_box = ttk.Combobox(
            model, textvariable=self.firmware_var, state="readonly",
            values=[item["label"] for item in self.firmwares],
        )
        self.firmware_box.grid(row=0, column=1, sticky="ew", **pad)
        self.firmware_box.bind("<<ComboboxSelected>>", lambda _event: self._on_firmware_change())

        self.enable_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(model, text="安装后设为开机启动（systemctl enable）", variable=self.enable_var)\
            .grid(row=1, column=0, columnspan=2, sticky="w", **pad)

        self.more_btn = ttk.Button(model, text="更多 ▾（安装包与端口）", command=self._toggle_more)
        self.more_btn.grid(row=2, column=0, columnspan=2, sticky="w", **pad)

        self.more_frame = ttk.Frame(model)
        self.more_frame.columnconfigure(1, weight=1)

        # 安装包来源：默认随包 Release/，可切换到任意文件夹或直接指定某个 .deb
        self.source_var = tk.StringVar()
        ttk.Label(self.more_frame, text="安装包来源").grid(row=0, column=0, sticky="w", **pad)
        ttk.Label(self.more_frame, textvariable=self.source_var, foreground="#4b5563")\
            .grid(row=0, column=1, sticky="w", **pad)
        source_btns = ttk.Frame(self.more_frame)
        source_btns.grid(row=0, column=2, columnspan=2, sticky="e", **pad)
        ttk.Button(source_btns, text="选择文件夹…", width=11, command=self._choose_dir).pack(side="left")
        ttk.Button(source_btns, text="选择 .deb…", width=10, command=self._choose_file)\
            .pack(side="left", padx=(4, 0))
        ttk.Button(source_btns, text="恢复默认", width=8, command=self._reset_dir)\
            .pack(side="left", padx=(4, 0))

        self.package_choice = tk.StringVar()
        ttk.Label(self.more_frame, text="安装包").grid(row=1, column=0, sticky="w", **pad)
        self.package_box = ttk.Combobox(self.more_frame, textvariable=self.package_choice,
                                        state="readonly")
        self.package_box.grid(row=1, column=1, columnspan=3, sticky="ew", **pad)
        self.package_box.bind("<<ComboboxSelected>>", lambda _event: self._update_package_hint())

        self.package_hint = ttk.Label(self.more_frame, text="")
        self.package_hint.grid(row=2, column=0, columnspan=4, sticky="w", padx=6)

        self.port_vars = {}
        labels = {"control": "控制端口", "status": "状态端口", "camera": "相机端口", "beacon": "发现端口 (UDP)"}
        for index, key in enumerate(PORT_KEYS):
            row = 3 + index // 2
            col = 0 if index % 2 == 0 else 2
            ttk.Label(self.more_frame, text=labels[key]).grid(row=row, column=col, sticky="w", **pad)
            var = tk.StringVar()
            self.port_vars[key] = var
            ttk.Entry(self.more_frame, textvariable=var, width=8)\
                .grid(row=row, column=col + 1, sticky="ew", **pad)

        actions = ttk.Frame(root)
        actions.pack(fill="x", pady=(10, 0))
        self.buttons = {}
        for name, text in (("status", "状态"), ("install", "安装"), ("start", "启动"),
                           ("stop", "停止"), ("restart", "重启"), ("logs", "日志")):
            button = ttk.Button(actions, text=text, command=lambda n=name: self._dispatch(n))
            button.pack(side="left", padx=(0, 6))
            self.buttons[name] = button

        # 第二行：开机自启开关 + 本地清空 + 卸载
        tools = ttk.Frame(root)
        tools.pack(fill="x", pady=(6, 0))
        self.autostart_var = tk.BooleanVar(value=False)
        self.autostart_box = ttk.Checkbutton(
            tools, text="开机自启（robot-editor + nginx）",
            variable=self.autostart_var, command=self._toggle_autostart)
        self.autostart_box.pack(side="left")

        self.clear_btn = ttk.Button(tools, text="清空日志", width=9, command=self._clear_log)
        self.clear_btn.pack(side="right")
        self.uninstall_btn = ttk.Button(tools, text="卸载…", width=8, command=self._confirm_uninstall)
        self.uninstall_btn.pack(side="right", padx=(0, 6))

        self.progress = ttk.Progressbar(root, mode="determinate", maximum=100)
        self.progress.pack(fill="x", pady=(8, 0))

        log_frame = ttk.LabelFrame(root, text="日志", padding=6)
        log_frame.pack(fill="both", expand=True, pady=(8, 0))
        self.log_view = scrolledtext.ScrolledText(log_frame, height=14, state="disabled", wrap="word")
        self.log_view.pack(fill="both", expand=True)
        for tag, color in (("system", "#15803d"), ("warning", "#b45309"),
                           ("error", "#b91c1c"), ("info", "#1d4ed8")):
            self.log_view.tag_configure(tag, foreground=color)

    def _toggle_more(self):
        if self.more_frame.winfo_manager():
            self.more_frame.grid_forget()
            self.more_btn.configure(text="更多 ▾（安装包与端口）")
        else:
            self.more_frame.grid(row=3, column=0, columnspan=2, sticky="ew")
            self.more_btn.configure(text="更多 ▴（安装包与端口）")

    # ---------- 状态联动 ----------
    def current_firmware(self):
        index = self.firmware_box.current()
        if 0 <= index < len(self.firmwares):
            return self.firmwares[index]
        return self.firmwares[0] if self.firmwares else None

    def _render_firmware(self):
        if not self.firmwares:
            self.source_var.set("配置中没有固件型号")
            return
        ids = [item["id"] for item in self.firmwares]
        index = ids.index(DEFAULT_FIRMWARE) if DEFAULT_FIRMWARE in ids else 0
        self.firmware_box.current(index)
        self._on_firmware_change()

    def _on_firmware_change(self):
        firmware = self.current_firmware()
        if not firmware:
            return
        for key in PORT_KEYS:
            self.port_vars[key].set(str(firmware["ports"].get(key, FALLBACK_PORTS[key])))
        self._refresh_packages()

    # ---------- 安装包来源 ----------
    def _package_dir(self):
        return self.package_dir or find_release_dir()

    def _refresh_packages(self, select_path=None):
        firmware = self.current_firmware() or {}
        directory = self._package_dir()
        self.package_candidates = scan_packages(directory, firmware.get("pattern"))
        labels = [self._package_label(item) for item in self.package_candidates]

        self.package_box.configure(values=labels)
        if not labels:
            self.package_box.set("")
            self.package_box.configure(state="disabled")
            self.package_choice.set("")
            self.source_var.set(self.package_dir or (directory or "未找到 Release 目录"))
            self.package_hint.configure(
                text="该目录没有 .deb 安装包，点「选择文件夹…」加载", foreground="#b45309")
            return

        self.package_box.configure(state="readonly")
        selected = 0
        if select_path:
            target = os.path.abspath(select_path)
            for index, item in enumerate(self.package_candidates):
                if os.path.abspath(item["path"]) == target:
                    selected = index
                    break
        self.package_box.current(selected)
        self.source_var.set(self.package_dir or f"内置 {directory}")
        self._update_package_hint()

    def _package_label(self, item):
        size = item["size"] / 1024 / 1024
        suffix = "" if item["matches"] else "  ·  不匹配当前型号"
        return f'{item["name"]}  ·  {size:.1f} MB{suffix}'

    def _update_package_hint(self):
        item = self.selected_package()
        if not item:
            self.package_hint.configure(text="")
            return
        if item["matches"]:
            self.package_hint.configure(text="匹配当前型号，可直接安装", foreground="#15803d")
            return
        firmware = self.current_firmware() or {}
        pattern = firmware.get("pattern") or "（该型号未配置匹配模式）"
        self.package_hint.configure(
            text=f"手动指定的包与型号模式 {pattern} 不一致，确认无误可继续安装",
            foreground="#b45309")

    def selected_package(self):
        index = self.package_box.current() if hasattr(self, "package_box") else -1
        if 0 <= index < len(self.package_candidates):
            return self.package_candidates[index]
        return None

    def _choose_dir(self):
        initial = self._package_dir() or os.getcwd()
        directory = filedialog.askdirectory(title="选择包含 .deb 的文件夹", initialdir=initial)
        if not directory:
            return
        self.package_dir = os.path.abspath(directory)
        self._refresh_packages()

    def _choose_file(self):
        initial = self._package_dir() or os.getcwd()
        path = filedialog.askopenfilename(
            title="选择 .deb 安装包",
            initialdir=initial,
            filetypes=[("Debian 安装包", "*.deb"), ("所有文件", "*")],
        )
        if not path:
            return
        self.package_dir = os.path.dirname(os.path.abspath(path))
        self._refresh_packages(select_path=path)

    def _reset_dir(self):
        self.package_dir = None
        self._refresh_packages()

    # ---------- 日志与事件 ----------
    def log(self, level, message):
        self.events.put(("log", level, message))

    def _drain_events(self):
        try:
            while True:
                event = self.events.get_nowait()
                if event[0] == "log":
                    _, level, message = event
                    self.log_view.configure(state="normal")
                    self.log_view.insert("end", message + "\n", level)
                    self.log_view.see("end")
                    self.log_view.configure(state="disabled")
                elif event[0] == "progress":
                    self.progress.configure(value=event[1])
                elif event[0] == "busy":
                    self._set_busy(event[1])
                elif event[0] == "autostart":
                    self.autostart_var.set(bool(event[1]))
        except queue.Empty:
            pass
        self.after(80, self._drain_events)

    def _set_busy(self, busy):
        self.busy = busy
        state = "disabled" if busy else "normal"
        for button in self.buttons.values():
            button.configure(state=state)
        for widget in (self.uninstall_btn, self.autostart_box):
            widget.configure(state=state)

    # ---------- 参数 ----------
    def _connection(self):
        host = self.host_var.get().strip()
        username = self.user_var.get().strip()
        password = self.password_var.get()
        if not host:
            raise ValueError("请填写机器人 IP")
        if not username:
            raise ValueError("请填写 SSH 用户名")
        if not password:
            raise ValueError("请填写登录密码")
        try:
            port = int(self.port_var.get() or 22)
        except ValueError:
            raise ValueError("SSH 端口必须是数字")
        return host, port, username, password

    def _ports(self):
        ports = {}
        for key in PORT_KEYS:
            raw = self.port_vars[key].get().strip() or "0"
            if not raw.isdigit():
                raise ValueError(f"端口 {key} 必须是数字")
            ports[key] = int(raw)
        if not ports["control"]:
            raise ValueError("控制端口不能为 0")
        return ports

    def _config_updates(self, firmware, ports):
        updates = {
            "BRIDGE_MODEL": firmware["model"],
            "WS_PORT": ports["control"],
            "STATUS_PORT": ports["status"],
            "CAMERA_PORT": ports["camera"],
            "BEACON_PORT": ports["beacon"],
        }
        updates.update(firmware.get("config") or {})
        return updates

    # ---------- 本地操作 ----------
    def _clear_log(self):
        self.log_view.configure(state="normal")
        self.log_view.delete("1.0", "end")
        self.log_view.configure(state="disabled")

    def _toggle_autostart(self):
        """勾选状态变化 → systemctl enable/disable robot-editor nginx"""
        if self.busy:
            return
        enable = bool(self.autostart_var.get())
        try:
            connection = self._connection()
        except ValueError as error:
            self.autostart_var.set(not enable)
            messagebox.showwarning("参数不完整", str(error))
            return

        self._set_busy(True)
        thread = threading.Thread(
            target=self._run_action,
            args=("enable" if enable else "disable", connection, {},
                  self.current_firmware(), None, False),
            daemon=True)
        thread.start()

    def _confirm_uninstall(self):
        if self.busy:
            return
        try:
            connection = self._connection()
        except ValueError as error:
            messagebox.showwarning("参数不完整", str(error))
            return

        host = connection[0]
        firmware = self.current_firmware() or {}
        service = firmware.get("service", "robot-editor")
        if not messagebox.askokcancel(
                "确认卸载",
                f"将从 {host} 卸载 {service}，并停止 robot-editor 与 nginx。\n\n继续？"):
            return
        # 二次确认：默认保留现场配置
        purge = messagebox.askyesno(
            "是否删除配置",
            "是否同时删除 /etc/robot-editor 配置与前端产物？\n\n"
            "是：dpkg -P（彻底删除，ROS_SETUP / 手型 / 限速参数会丢失）\n"
            "否：dpkg -r（保留配置，推荐）")
        self._purge_requested = bool(purge)
        self._dispatch("uninstall")

    # ---------- 动作 ----------
    def _dispatch(self, name):
        if self.busy:
            return
        try:
            connection = self._connection()
            # 卸载不需要端口，避免端口填错把卸载也拦下来
            ports = {} if name == "uninstall" else self._ports()
            firmware = self.current_firmware()
            if not firmware:
                raise ValueError("配置中没有固件型号")
            if name == "install":
                if not firmware["supported"]:
                    raise ValueError(firmware["reason"] or f'{firmware["id"]} 暂不支持安装')
                package = self.selected_package()
                if not package:
                    raise ValueError("当前目录没有可用的 .deb 安装包（点「选择文件夹…」加载）")
            else:
                package = None
        except ValueError as error:
            messagebox.showwarning("参数不完整", str(error))
            return

        self._set_busy(True)
        enable = bool(self.enable_var.get())
        thread = threading.Thread(target=self._run_action,
                                  args=(name, connection, ports, firmware, package, enable),
                                  daemon=True)
        thread.start()

    def _run_action(self, name, connection, ports, firmware, package, enable):
        host, port, username, password = connection
        installer = RemoteInstaller(host, port, username, password, self.log)
        try:
            installer.connect()
            if name == "install":
                self._do_install(installer, firmware, package, ports, connection, enable)
            elif name == "status":
                self._do_status(installer, firmware, ports, host, username)
            elif name in ("start", "restart"):
                self._do_start(installer, firmware, ports, restart=(name == "restart"))
            elif name == "stop":
                self._do_stop(installer, firmware)
            elif name in ("enable", "disable"):
                self._do_autostart(installer, firmware, enable=(name == "enable"))
            elif name == "uninstall":
                self._do_uninstall(installer, firmware, purge=bool(self._purge_requested))
            elif name == "logs":
                self._do_logs(installer, firmware)
        except Exception as error:
            self.log("error", f"✗ {name} 失败：{error}")
        finally:
            installer.close()
            self.events.put(("progress", 0))
            self.events.put(("busy", False))

    def _do_install(self, installer, firmware, package, ports, connection, enable):
        host, _port, username, _password = connection
        service = firmware["service"]
        remote_deb = f"/tmp/{package['name']}"

        self.log("info", "══ 安装开始 ══")
        self.log("system", f'型号    {firmware["label"]}')
        self.log("system", f'目标    {username}@{host}')
        self.log("system",
                 f'安装包  {package["name"]}（{package["size"] / 1024 / 1024:.1f} MB · {package["arch"]}）')
        self.log("system", f'自启    {"是（systemctl enable）" if enable else "否"}')

        self.log("system", "▶ 上传安装包")
        last = [0]

        def progress(transferred, total):
            if not total:
                return
            percent = int(transferred * 100 / total)
            if percent >= last[0] + 10:
                last[0] = percent
                self.events.put(("progress", percent))
                self.log("system", f"    上传 {percent}%")

        installer.upload(package["path"], remote_deb, progress)
        self.events.put(("progress", 100))
        self.log("system",
                 f"✓ 上传安装包  {package['size'] / 1024 / 1024:.1f} MB → {remote_deb}")

        self.log("system", "▶ apt 安装")
        apt = (
            "env DEBIAN_FRONTEND=noninteractive apt-get install -y "
            "-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "
            f"{shlex.quote(remote_deb)}"
        )
        code, out = installer.run(apt, sudo=True, timeout=900)

        # apt 输出可达上百行，只保留关键行
        key_line = re.compile(
            r"^(E:|W:|dpkg:|Setting up |Unpacking |Preparing to unpack|Processing triggers)", re.I)
        shown = 0
        for raw in out.splitlines():
            text = raw.strip()
            if not text:
                continue
            if key_line.match(text) or "error" in text.lower() or "失败" in text:
                if shown < 8:
                    self.log("system", f"    {text}")
                    shown += 1
        if code != 0:
            raise RuntimeError(
                f"apt 安装失败（code {code}），可在机器人上手动执行：sudo apt install {remote_deb}")

        installed = installer.installed_version(service)
        self.log("system", f"✓ apt 安装  {service} {installed or ''}".rstrip())

        installer.apply_config(self.config_path, self._config_updates(firmware, ports))
        self.log("system",
                 f"✓ 写入配置  控制 {ports['control']} / 状态 {ports['status']} "
                 f"/ 相机 {ports['camera']} / 发现 {ports['beacon']}")

        if enable:
            installer.run_checked(f"systemctl enable {shlex.quote(service)} nginx", sudo=True, timeout=60)
            self.log("system", f"✓ 开机自启  {service} + nginx")
        else:
            self.log("system", "· 开机自启  未设置（勾选后重装，或点「启动」）")

        # 前端由 nginx 提供：robot-editor 停止时 nginx 会被连带停掉，安装后显式确保 3000 就绪
        if not self._port_listening(installer, 3000):
            self.log("system", "▶ 启动前端 nginx")
            code, _ = installer.run("systemctl enable --now nginx", sudo=True, timeout=120)
            if code != 0:
                self.log("warning", "    nginx 启动失败：sudo nginx -t 查看原因")
            time.sleep(1.2)
        web_ok = self._port_listening(installer, 3000)
        self.log("system" if web_ok else "warning",
                 f"{'✓' if web_ok else '!'} 前端 3000  {'可访问' if web_ok else '未监听'}")

        running, _state = installer.service_active(service)
        if running:
            installer.run_checked(f"systemctl restart {shlex.quote(service)}", sudo=True, timeout=120)

        self.log("info", "══ 安装完成 ══")
        self.log("system",
                 f"服务    {service} {installed or ''}（{'运行中' if running else '未启动，点「启动」'}）")
        self.log("system" if web_ok else "warning",
                 f"网页    http://{host}:3000 {'可访问' if web_ok else '未监听'}")
        if not web_ok:
            self.log("warning", "修复    sudo systemctl enable --now nginx")

    def _port_listening(self, installer, port):
        try:
            return port in installer.listening_ports()
        except Exception:
            return False

    def _do_status(self, installer, firmware, ports, host, username):
        service = firmware["service"]
        version = installer.installed_version(service)
        running, state = installer.service_active(service)
        listening = installer.listening_ports()

        self.log("info", "══ 检查状态 ══")
        self.log("system", f"主机    {host}（{username}）")
        self.log("system" if version else "warning",
                 f"桥接    {service} {version if version else '未安装（点「安装」）'}")
        self.log("system" if running else "warning",
                 f"运行    {'运行中' if running else f'未运行（{state}）'}")

        web_ok = 3000 in listening
        try:
            nginx_state = installer.run("systemctl is-active nginx 2>/dev/null || true")[1].strip() or "unknown"
        except Exception:
            nginx_state = "unknown"
        self.log("system" if web_ok else "warning",
                 f"前端    nginx {nginx_state} · 3000 {'可访问' if web_ok else '未监听'}")

        port_bits = [
            f"{ports[key]} {'✓' if ports[key] in listening else '✗'}"
            for key in PORT_KEYS if ports[key]
        ]
        if port_bits:
            self.log("system", f"端口    {'   '.join(port_bits)}")

        try:
            enabled = installer.run(
                f"systemctl is-enabled {shlex.quote(service)} 2>/dev/null || true")[1].strip() == "enabled"
        except Exception:
            enabled = False
        self.log("system", f"自启    {'已启用' if enabled else '未启用'}")
        self.events.put(("autostart", enabled))

        if not web_ok:
            self.log("warning", "修复    sudo systemctl enable --now nginx")
        if version:
            tail = installer.log_tail(service, 15)
            if tail:
                self.log("system", "最近日志")
                for line in tail.splitlines()[-8:]:
                    self.log("system", f"    {line}")

    def _do_start(self, installer, firmware, ports, restart=False):
        service = firmware["service"]
        verb = "restart" if restart else "start"
        self.log("info", f"══ {'重启' if restart else '启动'}服务 ══")
        # 桥接与前端一起启动
        installer.run_checked(f"systemctl {verb} {shlex.quote(service)} nginx", sudo=True, timeout=120)
        time.sleep(2)
        running, state = installer.service_active(service)
        if not running:
            raise RuntimeError(f"{'重启' if restart else '启动'}后服务未进入 active（{state}）")
        listening = installer.listening_ports()
        self.log("system", f"✓ {service} 与 nginx 已{'重启' if restart else '启动'}")

        port_bits = [
            f"{ports[key]} {'✓' if ports[key] in listening else '✗'}"
            for key in PORT_KEYS if ports[key]
        ]
        if port_bits:
            self.log("system", f"端口    {'   '.join(port_bits)}")

        if 3000 in listening:
            self.log("system", "网页    3000 可访问（http://<机器人IP>:3000）")
        else:
            self.log("warning", "网页    3000 未监听：sudo systemctl enable --now nginx")
        self.log("system", "提示    可在网页真机面板点「连接」接入设备")

    def _do_stop(self, installer, firmware):
        service = firmware["service"]
        self.log("info", "══ 停止服务 ══")
        installer.run_checked(f"systemctl stop {shlex.quote(service)} nginx", sudo=True, timeout=60)
        self.log("system", f"✓ {service} 与 nginx 已停止")

    def _do_autostart(self, installer, firmware, enable):
        service = firmware["service"]
        verb = "enable" if enable else "disable"
        self.log("info", "══ 开机自启 ══")
        installer.run_checked(f"systemctl {verb} {shlex.quote(service)} nginx", sudo=True, timeout=60)
        self.log("system", f"✓ 已{'启用' if enable else '取消'}开机自启（{service} + nginx）")
        self.events.put(("autostart", enable))

    def _do_uninstall(self, installer, firmware, purge):
        service = firmware["service"]
        self.log("info", "══ 卸载 ══")
        self.log("system",
                 f"模式    {'dpkg -P（删除配置与前端产物）' if purge else 'dpkg -r（保留 /etc/robot-editor 配置）'}")

        installer.run_checked(f"systemctl stop {shlex.quote(service)} nginx || true",
                              sudo=True, timeout=60)
        installer.run_checked(f"systemctl disable {shlex.quote(service)} nginx || true",
                              sudo=True, timeout=60)
        self.log("system", "✓ 已停止服务并取消开机自启")
        self.events.put(("autostart", False))

        if installer.installed_version(service):
            code, out = installer.run(
                f"dpkg {'-P' if purge else '-r'} {shlex.quote(service)}", sudo=True, timeout=300)
            for line in out.splitlines()[-6:]:
                if line.strip():
                    self.log("system", f"    {line}")
            if code != 0:
                raise RuntimeError(f"dpkg 卸载失败（code {code}）")
        else:
            self.log("system", "· 系统里没有该包，跳过 dpkg")

        installer.run_checked(
            "rm -f /etc/nginx/sites-enabled/robot-editor.conf; "
            "systemctl is-active nginx >/dev/null 2>&1 && systemctl reload nginx || true",
            sudo=True, timeout=60)

        remaining = installer.installed_version(service)
        if remaining:
            self.log("error", f"✗ 卸载未完成：{service} 仍在（{remaining}）")
            return

        self.log("system", f"✓ {service} 已从系统移除")
        self.log("system", "· 前端站点已摘除（nginx 保留，3000 不再提供服务）")
        if purge:
            self.log("system", "· 配置与前端产物已删除")
        else:
            self.log("system", "· 配置保留在 /etc/robot-editor/bridge.conf，重装后继续生效")

    def _do_logs(self, installer, firmware):
        service = firmware["service"]
        tail = installer.log_tail(service, 200)
        if not tail:
            self.log("warning", "暂无日志（服务可能未启动过）")
            return
        for line in tail.splitlines():
            self.log("system", line)


def main():
    if "--list" in sys.argv:
        directory = None
        if "--dir" in sys.argv:
            index = sys.argv.index("--dir")
            if index + 1 < len(sys.argv):
                directory = os.path.abspath(sys.argv[index + 1])
        print_list(directory)
        return 0
    if tk is None:
        print("缺少 tkinter：请安装 python3-tk 后重试", file=sys.stderr)
        return 1
    if paramiko is None:
        print("缺少 paramiko：请执行 pip3 install paramiko 后重试", file=sys.stderr)
        return 1

    manifest, manifest_path = load_manifest()
    if not manifest.get("firmwares"):
        print("警告：未找到固件型号配置（manifest.json）", file=sys.stderr)

    try:
        app = InstallerApp(manifest, manifest_path)
    except Exception as error:  # 无 X/Wayland 会话时 Tk 会抛 TclError
        print(f"无法打开窗口：{error}", file=sys.stderr)
        print("如需无界面安装，请用 scripts/install-remote.sh", file=sys.stderr)
        return 1
    app.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
