/**
 * 固件部署器：把 Release/robot-editor_<version>_<arch>.deb 推到机器人本体并安装启动。
 *
 * 两种部署形态共用同一个安装包：
 * 1. 机器人本体：本机执行 `sudo apt install ./Release/robot-editor_<version>_<arch>.deb`；
 * 2. 本体之外：本面板（浏览器 → station）选固件型号 → 匹配 Release 下对应安装包 →
 *    scp 到机器人 → apt 安装 → `systemctl enable --now robot-editor`。
 *
 * 设计约束：
 * - 只由操作站的 station.js 调用；浏览器不接触 SSH 凭据。
 * - 密码仅在该模块内用于 SSH 握手与 sudo 提权，不写日志、不进事件流、不落盘。
 * - 所有远端命令都经过白名单参数拼装 + shell 引号转义。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'ssh2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const MANIFEST = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf-8'));

const DEFAULT_PORTS = MANIFEST.defaults.ports;
const RELEASE_DIR = resolve(PROJECT_ROOT, MANIFEST.defaults.releaseDir || 'Release');
const DEFAULT_SERVICE = MANIFEST.defaults.service || 'robot-editor';
const DEFAULT_CONFIG = MANIFEST.defaults.configPath || '/etc/robot-editor/bridge.conf';
const DEFAULT_INSTALL_DIR = MANIFEST.defaults.installDir || '/opt/robot-editor';
const REMOTE_TMP = MANIFEST.defaults.remoteTempDir || '/tmp';
const PORT_KEYS = ['control', 'status', 'camera', 'beacon'];

// ============================================================
// 安装包解析（固件型号 → Release 下匹配的 .deb）
// ============================================================

function globToRegExp(pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** 版本比较：1.10.0 > 1.9.2，兼容 -rc1 之类的后缀 */
function compareVersion(a, b) {
    const pick = (value) => String(value || '').split(/[.+-]/).map((part) => {
        const num = Number.parseInt(part, 10);
        return Number.isNaN(num) ? part : num;
    });
    const left = pick(a);
    const right = pick(b);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const x = left[i] ?? 0;
        const y = right[i] ?? 0;
        if (typeof x === 'number' && typeof y === 'number') {
            if (x !== y) return x - y;
            continue;
        }
        const diff = String(x).localeCompare(String(y));
        if (diff !== 0) return diff;
    }
    return 0;
}

/** 从 robot-editor_<version>_<arch>.deb 解析出版本与架构 */
function parsePackageName(name) {
    const match = String(name).match(/^(.+)_([0-9][^_]*)_([a-z0-9]+)\.deb$/i);
    if (!match) return null;
    return { stem: match[1], version: match[2], arch: match[3] };
}

/**
 * 在 Release 目录解析该固件型号对应的安装包，多个版本取最高版本。
 * @param {object} firmware manifest 条目
 * @returns {{available:boolean,name?:string,version?:string,arch?:string,size?:number,file?:string,error?:string}}
 */
export function resolvePackage(firmware) {
    if (firmware.supported === false) {
        return { available: false, error: firmware.reason || `固件型号 ${firmware.id} 暂不支持安装` };
    }
    const pattern = firmware.package || MANIFEST.defaults.package;
    if (!pattern) {
        return { available: false, error: `固件型号 ${firmware.id} 未配置安装包（package 字段）` };
    }
    if (!existsSync(RELEASE_DIR)) {
        return { available: false, error: `操作站缺少 Release 目录：${RELEASE_DIR}` };
    }
    const re = globToRegExp(pattern);
    const candidates = readdirSync(RELEASE_DIR)
        .filter((name) => re.test(name))
        .map((name) => {
            const meta = parsePackageName(name);
            if (!meta) return null;
            const file = join(RELEASE_DIR, name);
            const stat = statSync(file);
            return { name, version: meta.version, arch: meta.arch, size: stat.size, file, mtime: stat.mtimeMs };
        })
        .filter(Boolean)
        .sort((a, b) => compareVersion(b.version, a.version));

    if (!candidates.length) {
        return {
            available: false,
            error: `Release/ 下没有匹配 ${pattern} 的安装包（先在操作站执行 scripts/build-deb.sh）`,
        };
    }
    const best = candidates[0];
    return { available: true, ...best };
}

function publicPackageInfo(firmware) {
    const pkg = resolvePackage(firmware);
    if (!pkg.available) return { available: false, error: pkg.error };
    return {
        available: true,
        name: pkg.name,
        version: pkg.version,
        arch: pkg.arch,
        size: pkg.size,
    };
}

// ============================================================
// 公开信息（不含凭据）
// ============================================================

export function listFirmwares() {
    return MANIFEST.firmwares.map((firmware) => ({
        id: firmware.id,
        label: firmware.label,
        description: firmware.description,
        supported: firmware.supported !== false,
        reason: firmware.reason || '',
        model: firmware.model,
        service: firmware.service || DEFAULT_SERVICE,
        package: publicPackageInfo(firmware),
        ports: { ...DEFAULT_PORTS, ...(firmware.ports || {}) },
    }));
}

// ============================================================
// 参数校验
// ============================================================

const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$/;
const USER_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const CONFIG_KEY_RE = /^[A-Z][A-Z0-9_]{1,40}$/;
const CONFIG_VALUE_RE = /^[A-Za-z0-9 _.,:/@+=-]{0,200}$/;

function bad(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function getFirmware(firmwareId) {
    const firmware = MANIFEST.firmwares.find((f) => f.id === firmwareId);
    if (!firmware) throw bad(`未知固件型号 "${firmwareId}"`);
    return firmware;
}

function normalizePorts(firmware, input = {}) {
    const defaults = { ...DEFAULT_PORTS, ...(firmware.ports || {}) };
    const ports = {};
    for (const key of PORT_KEYS) {
        const raw = input?.[key];
        const value = raw === undefined || raw === null || raw === ''
            ? defaults[key]
            : Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
            throw bad(`端口 ${key}=${raw} 非法（0-65535）`);
        }
        ports[key] = value;
    }
    if (!ports.control) throw bad('控制端口不能为 0');
    if (ports.control === ports.beacon && ports.beacon !== 0) {
        throw bad('控制端口与发现端口不能相同');
    }
    const used = new Map();
    for (const key of PORT_KEYS) {
        const value = ports[key];
        if (!value) continue;
        if (used.has(value)) {
            throw bad(`端口 ${value} 被 ${used.get(value)} 与 ${key} 重复占用`);
        }
        used.set(value, key);
    }
    return ports;
}

function normalizeConnection(input = {}) {
    const host = String(input.host || '').trim();
    if (!HOST_RE.test(host)) throw bad('机器人 IP / 主机名不合法');
    const username = String(input.username || '').trim();
    if (!USER_RE.test(username)) throw bad('用户名不合法');
    const port = input.port === undefined || input.port === '' ? 22 : Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('SSH 端口不合法');
    const password = input.password === undefined ? '' : String(input.password);
    if (password.length > 256) throw bad('密码过长');
    if (/[\r\n]/.test(password)) throw bad('密码不能包含换行符');
    const privateKeyPath = input.privateKeyPath ? String(input.privateKeyPath) : '';
    if (!password && !privateKeyPath) throw bad('需要登录密码或私钥');
    return { host, port, username, password, privateKeyPath };
}

/** 需要写进 /etc/robot-editor/bridge.conf 的键值（机型 + 端口 + 固件参数） */
function configUpdates(firmware, ports) {
    const updates = {
        BRIDGE_MODEL: firmware.model,
        WS_PORT: String(ports.control),
        STATUS_PORT: String(ports.status),
        CAMERA_PORT: String(ports.camera),
        BEACON_PORT: String(ports.beacon),
        ...(firmware.config || {}),
    };
    for (const [key, value] of Object.entries(updates)) {
        if (!CONFIG_KEY_RE.test(key)) throw bad(`配置项键名非法：${key}`);
        if (!CONFIG_VALUE_RE.test(String(value))) throw bad(`配置项 ${key} 的值非法：${value}`);
    }
    return updates;
}

// ============================================================
// SSH / SFTP 基础能力
// ============================================================

function sshErrorMessage(err) {
    const code = err?.code || '';
    if (code === 'ECONNREFUSED') return 'SSH 端口拒绝连接：机器人未开启 sshd，或端口不是 22';
    if (code === 'ETIMEDOUT' || code === 'ENETUNREACH') return 'SSH 连接超时：检查 IP、网段与防火墙';
    if (err?.level === 'client-authentication') return '认证失败：用户名或密码错误';
    if (err?.level === 'client-timeout') return 'SSH 握手超时';
    return err?.message || String(err);
}

function connect({ host, port, username, password, privateKeyPath }, timeoutMs = 12000) {
    return new Promise((resolvePromise, rejectPromise) => {
        const conn = new Client();
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const timer = setTimeout(() => {
            try { conn.end(); } catch { /* ignore */ }
            finish(rejectPromise, new Error(`连接 ${host}:${port} 超时`));
        }, timeoutMs);

        conn.on('ready', () => finish(resolvePromise, conn));
        conn.on('error', (err) => finish(rejectPromise, new Error(sshErrorMessage(err))));

        const config = {
            host,
            port,
            username,
            readyTimeout: timeoutMs,
            keepaliveInterval: 10000,
        };
        if (privateKeyPath) config.privateKey = readFileSync(privateKeyPath);
        else config.password = password;

        try {
            conn.connect(config);
        } catch (err) {
            finish(rejectPromise, new Error(sshErrorMessage(err)));
        }
    });
}

function exec(conn, command, { onLog, timeoutMs = 30000, stdin } = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            rejectPromise(new Error(`远端命令超时（${timeoutMs}ms）：${command.slice(0, 120)}`));
        }, timeoutMs);

        conn.exec(command, (err, stream) => {
            if (err) {
                clearTimeout(timer);
                rejectPromise(err);
                return;
            }
            stream.on('close', (code) => {
                clearTimeout(timer);
                resolvePromise({ code: code ?? 0, stdout, stderr });
            });
            stream.on('data', (data) => {
                const text = data.toString();
                stdout += text;
                onLog?.(text);
            });
            stream.stderr.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                onLog?.(text);
            });
            if (stdin !== undefined) stream.end(stdin);
        });
    });
}

function execChecked(conn, command, options = {}) {
    return exec(conn, command, options).then((result) => {
        if (result.code !== 0) {
            const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ');
            throw new Error(`命令失败（code ${result.code}）：${detail || command}`);
        }
        return result;
    });
}

function getSftp(conn) {
    return new Promise((resolvePromise, rejectPromise) => {
        conn.sftp((err, sftp) => (err ? rejectPromise(err) : resolvePromise(sftp)));
    });
}

/**
 * 上传安装包。deb 往往上百 MB，按 10% 步进回报进度，避免日志刷屏。
 */
function sftpPut(sftp, localPath, remotePath, onProgress) {
    return new Promise((resolvePromise, rejectPromise) => {
        let lastMilestone = 0;
        sftp.fastPut(localPath, remotePath, {
            step: (transferred, _chunk, total) => {
                if (!onProgress || !total) return;
                const percent = Math.floor((transferred / total) * 100);
                const milestone = Math.floor(percent / 10) * 10;
                if (milestone > lastMilestone) {
                    lastMilestone = milestone;
                    onProgress(milestone);
                }
            },
        }, (err) => (err ? rejectPromise(err) : resolvePromise()));
    });
}

async function isRoot(conn) {
    const whoami = await exec(conn, 'id -u');
    return whoami.stdout.trim() === '0';
}

/**
 * 以 root 执行命令：远端用户是 root 时直连，否则 `sudo -S` 用登录密码提权。
 * 密码只经 stdin 传递，不写进命令行（避免出现在进程列表/日志里）。
 */
async function runSudo(conn, command, { password, onLog, timeoutMs = 30000 } = {}) {
    if (await isRoot(conn)) return execChecked(conn, command, { onLog, timeoutMs });
    if (!password) throw new Error('远端不是 root，且没有可用于 sudo 的密码');
    return execChecked(conn, `sudo -S -p '' ${command}`, { onLog, timeoutMs, stdin: `${password}\n` });
}

/** 管道到 onLog 的流式输出按行拆分，去掉空行，避免 apt 输出把面板刷满 */
function lineLogger(log) {
    return (text) => {
        for (const line of String(text).split(/\r?\n/)) {
            if (line.trim()) log(line.trimEnd());
        }
    };
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ============================================================
// 远端探针
// ============================================================

function portProbeCommand(ports) {
    // 控制/状态/相机是 TCP，发现信标是 UDP——都用 TCP connect 探会让信标端口永远"未就绪"。
    // 优先用 `ss` 读监听表（不建立连接，避免在桥接日志里刷 websockets 握手异常），
    // 没有 ss 时退回 socket 探测：TCP 判断能否连上，UDP 判断能否 bind。
    const tcp = PORT_KEYS.filter((key) => key !== 'beacon').map((key) => ports[key]).filter(Boolean);
    const udp = [ports.beacon].filter(Boolean);
    return `python3 - <<'PY'\n` +
        `import socket, subprocess\n` +
        `tcp = ${JSON.stringify(tcp)}\n` +
        `udp = ${JSON.stringify(udp)}\n` +
        `def listening(flag):\n` +
        `    try:\n` +
        `        out = subprocess.run(['ss', flag], capture_output=True, text=True, timeout=3).stdout\n` +
        `    except Exception:\n` +
        `        return None\n` +
        `    found = set()\n` +
        `    for line in out.splitlines()[1:]:\n` +
        `        parts = line.split()\n` +
        `        if len(parts) < 4:\n` +
        `            continue\n` +
        `        port = parts[3].rsplit(':', 1)[-1]\n` +
        `        if port.isdigit():\n` +
        `            found.add(int(port))\n` +
        `    return found\n` +
        `tcp_listen = listening('-ltn')\n` +
        `udp_listen = listening('-lun')\n` +
        `for p in tcp:\n` +
        `    ok = (p in tcp_listen) if tcp_listen is not None else None\n` +
        `    if ok is None:\n` +
        `        s = socket.socket()\n` +
        `        s.settimeout(1)\n` +
        `        try:\n` +
        `            s.connect(('127.0.0.1', p))\n` +
        `            ok = True\n` +
        `        except Exception:\n` +
        `            ok = False\n` +
        `        finally:\n` +
        `            s.close()\n` +
        `    print(f'{p} ' + ('ok tcp 已监听' if ok else 'fail 未监听'))\n` +
        `for p in udp:\n` +
        `    ok = (p in udp_listen) if udp_listen is not None else None\n` +
        `    if ok is None:\n` +
        `        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)\n` +
        `        try:\n` +
        `            u.bind(('', p))\n` +
        `            ok = False\n` +
        `        except OSError:\n` +
        `            ok = True\n` +
        `        finally:\n` +
        `            u.close()\n` +
        `    print(f'{p} ' + ('ok udp 已监听' if ok else 'fail 未监听'))\n` +
        `PY`;
}

function parsePortProbe(stdout) {
    const result = {};
    for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(ok|fail)\b(.*)$/);
        if (match) result[Number(match[1])] = { ok: match[2] === 'ok', detail: match[3].trim() };
    }
    return result;
}

async function queryInstalledVersion(conn, service) {
    const result = await exec(conn, `dpkg-query -W -f='\${Version}' ${shellQuote(service)} 2>/dev/null || true`);
    return result.stdout.trim();
}

async function serviceActive(conn, service) {
    const result = await exec(conn, `systemctl is-active ${shellQuote(service)} 2>/dev/null || true`);
    const state = result.stdout.trim();
    return { active: state === 'active', state: state || 'unknown' };
}

async function serviceLogTail(conn, service, lines = 20) {
    const result = await exec(conn,
        `journalctl -u ${shellQuote(service)} -n ${lines} --no-pager 2>/dev/null || true`);
    return result.stdout.trim();
}

/** 把型号/端口/固件参数写进远端 bridge.conf（键不存在时追加） */
async function applyConfig(conn, { configPath, updates, password, onLog }) {
    const body = [
        `conf=${shellQuote(configPath)}`,
        'if [ ! -f "$conf" ]; then echo "缺少配置文件 $conf（安装包可能不完整）" >&2; exit 1; fi',
        'set_val() {',
        '    k="$1"; v="$2"',
        '    if grep -q "^$k=" "$conf"; then',
        '        sed -i "s|^$k=.*|$k=$v|" "$conf"',
        '    else',
        '        printf \'%s=%s\\n\' "$k" "$v" >> "$conf"',
        '    fi',
        '}',
        ...Object.entries(updates).map(([key, value]) => `set_val ${shellQuote(key)} ${shellQuote(value)}`),
        'echo "已更新 $conf"',
    ].join('\n');
    await runSudo(conn, `bash -c ${shellQuote(body)}`, { password, onLog, timeoutMs: 30000 });
}

// ============================================================
// 预检
// ============================================================

export async function preflight(options) {
    const firmware = getFirmware(options.firmwareId);
    const connInfo = normalizeConnection(options);
    const ports = normalizePorts(firmware, options.ports);
    const model = firmware.model;
    const service = firmware.service || DEFAULT_SERVICE;
    const pkg = resolvePackage(firmware);

    const checks = [];
    const add = (id, label, status, detail = '') => checks.push({ id, label, status, detail });

    add('firmware', '固件型号',
        firmware.supported === false ? 'fail' : 'ok',
        `${firmware.label}（${model}）${firmware.supported === false ? '：' + (firmware.reason || '暂不支持') : ''}`);
    if (pkg.available) {
        add('package', '安装包', 'ok',
            `${pkg.name} · ${(pkg.size / 1024 / 1024).toFixed(1)} MB`);
    } else {
        add('package', '安装包', 'fail', pkg.error);
    }

    let conn;
    try {
        conn = await connect(connInfo);
        add('ssh', '连接机器人', 'ok', `${connInfo.username}@${connInfo.host}:${connInfo.port}`);
    } catch (err) {
        add('ssh', '连接机器人', 'fail', err.message);
        return { ok: false, checks, firmware: firmware.id, model, ports, package: publicPackageInfo(firmware) };
    }

    try {
        // 安装需要 root：root 直连，普通用户走 sudo（密码即登录密码）
        const root = await isRoot(conn);
        if (root) {
            add('privilege', '检查权限', 'ok', 'SSH 用户为 root，无需 sudo');
        } else {
            const sudo = await exec(conn, `sudo -n true 2>/dev/null && echo ok || echo need-password`);
            add('privilege', '检查权限',
                sudo.stdout.includes('ok') ? 'ok' : 'warn',
                sudo.stdout.includes('ok') ? 'sudo 免密，直接安装' : '需用登录密码 sudo 提权（安装时使用）');
        }

        const osName = await exec(conn, '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"');
        add('os', '操作系统', osName.code === 0 ? 'ok' : 'warn', osName.stdout.trim() || '未知');

        const arch = (await exec(conn, 'dpkg --print-architecture 2>/dev/null || uname -m')).stdout.trim();
        if (pkg.available && arch) {
            const archOk = pkg.arch === arch;
            add('arch', '架构匹配', archOk ? 'ok' : 'fail',
                archOk ? `${arch}` : `安装包为 ${pkg.arch}，机器人是 ${arch}`);
        }

        const tools = await exec(conn, 'command -v apt-get >/dev/null && command -v dpkg >/dev/null && echo ok');
        add('tools', '安装工具', tools.stdout.trim() === 'ok' ? 'ok' : 'fail',
            tools.stdout.trim() === 'ok' ? 'apt-get / dpkg 可用' : '缺少 apt-get 或 dpkg（非 Debian 系系统？）');

        if (pkg.available) {
            const avail = await exec(conn, `df -k ${shellQuote(REMOTE_TMP)} | tail -1 | awk '{print $4}'`);
            const freeKb = Number.parseInt(avail.stdout.trim(), 10);
            const needKb = Math.ceil((pkg.size / 1024) * 1.5);
            add('disk', '磁盘空间', Number.isFinite(freeKb) && freeKb > needKb ? 'ok' : 'warn',
                Number.isFinite(freeKb)
                    ? `${REMOTE_TMP} 剩余 ${(freeKb / 1024).toFixed(0)} MB，需要约 ${(needKb / 1024).toFixed(0)} MB`
                    : '无法读取剩余空间');
        }

        const installed = await queryInstalledVersion(conn, service);
        add('installed', '已安装版本', 'ok', installed ? `${service} ${installed}` : '未安装');

        const { active, state } = await serviceActive(conn, service);
        add('service', '服务状态', active ? 'warn' : 'ok',
            active ? `运行中（安装会重启 ${service}）` : `未运行（${state}）`);

        const probe = parsePortProbe((await exec(conn, portProbeCommand(ports))).stdout);
        const busy = Object.entries(probe)
            .filter(([, value]) => value.ok)
            .map(([port]) => port);
        add('ports', '端口占用', busy.length ? (active ? 'warn' : 'fail') : 'ok',
            busy.length
                ? (active
                    ? `已占用：${busy.join(', ')}（由当前服务持有，安装后会重启复用）`
                    : `已占用：${busy.join(', ')}（不是本服务，请换端口或先停止占用进程）`)
                : '全部可用');

        const blocking = checks.some((c) => c.status === 'fail');
        return {
            ok: !blocking,
            checks,
            firmware: firmware.id,
            model,
            ports,
            service,
            package: publicPackageInfo(firmware),
        };
    } finally {
        try { conn.end(); } catch { /* ignore */ }
    }
}

// ============================================================
// 部署（上传 → apt 安装 → 写配置 → systemd 启动 → 校验）
// ============================================================

export async function deploy(options, emit = () => {}) {
    const firmware = getFirmware(options.firmwareId);
    const connInfo = normalizeConnection(options);
    const ports = normalizePorts(firmware, options.ports);
    const model = firmware.model;
    const service = firmware.service || DEFAULT_SERVICE;
    const configPath = firmware.configPath || DEFAULT_CONFIG;
    const step = (id, label, status, message = '') => emit({ type: 'step', id, label, status, message });
    const log = lineLogger((message) => emit({ type: 'log', message }));
    // apt 输出可达上百行，只透出关键行，避免把日志区刷满
    const aptLog = (text) => {
        for (const raw of String(text).split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            if (/^(E:|W:|dpkg:|Setting up |Unpacking |Preparing to unpack|Processing triggers)/.test(line)
                || /error|failed|失败/i.test(line)) {
                log(line);
            }
        }
    };

    const pkg = resolvePackage(firmware);
    if (!pkg.available) throw bad(pkg.error);

    const remoteDeb = `${REMOTE_TMP}/${pkg.name}`;
    const updates = configUpdates(firmware, ports);

    step('connect', '连接机器人', 'running', `${connInfo.username}@${connInfo.host}:${connInfo.port}`);
    const conn = await connect(connInfo);
    step('connect', '连接机器人', 'ok');

    try {
        const root = await isRoot(conn);
        step('privilege', '检查权限', 'ok', root ? 'root' : 'sudo（使用登录密码提权）');

        step('package', '匹配安装包', 'running', pkg.name);
        log(`安装包：${pkg.name}（${(pkg.size / 1024 / 1024).toFixed(1)} MB · ${pkg.arch}）`);
        step('package', '匹配安装包', 'ok', `v${pkg.version}`);

        step('upload', '上传安装包', 'running', remoteDeb);
        const sftp = await getSftp(conn);
        await sftpPut(sftp, pkg.file, remoteDeb, (percent) => log(`上传进度 ${percent}%`));
        step('upload', '上传安装包', 'ok', `${(pkg.size / 1024 / 1024).toFixed(1)} MB`);

        step('install', '安装（apt）', 'running');
        // apt 会自动补齐依赖（nginx / python3 / python3-websockets）；
        // conffile 冲突时保留现有配置，避免覆盖现场已调好的 bridge.conf。
        const apt = `env DEBIAN_FRONTEND=noninteractive apt-get install -y ` +
            `-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ${shellQuote(remoteDeb)}`;
        try {
            await runSudo(conn, apt, {
                password: connInfo.password,
                onLog: aptLog,
                timeoutMs: 600000,
            });
        } catch (err) {
            const hint = '若因缺少依赖或无法访问软件源失败，可在机器人上手动执行：'
                + `sudo apt install ${remoteDeb}`;
            step('install', '安装（apt）', 'fail', hint);
            throw new Error(`${err.message}\n${hint}`);
        }
        const installedNow = await queryInstalledVersion(conn, service);
        step('install', '安装（apt）', 'ok', installedNow ? `${service} ${installedNow}` : pkg.version);

        step('config', '写入配置', 'running', configPath);
        await applyConfig(conn, { configPath, updates, password: connInfo.password, onLog: log });
        step('config', '写入配置', 'ok',
            `控制=${ports.control} 状态=${ports.status} 相机=${ports.camera} 信标=${ports.beacon}`);

        // 安装默认不启动（避免装完上电就动）；原本在运行的实例重启一次以应用新代码
        const { active: wasActive } = await serviceActive(conn, service);
        if (wasActive) {
            step('restart', '重启旧实例', 'running');
            await runSudo(conn, `systemctl restart ${shellQuote(service)}`, {
                password: connInfo.password,
                onLog: log,
                timeoutMs: 120000,
            });
            step('restart', '重启旧实例', 'ok');
        }

        const enable = options.enable === true || options.enable === '1' || options.enable === 'true';
        if (enable) {
            step('enable', '设为开机启动', 'running');
            // 桥接与前端一起托管：systemctl enable robot-editor nginx
            await runSudo(conn, `systemctl enable ${shellQuote(service)} nginx`, {
                password: connInfo.password,
                onLog: log,
                timeoutMs: 60000,
            });
            step('enable', '设为开机启动', 'ok', `${service} + nginx`);
        }

        // 前端由 nginx 提供。robot-editor 停止时 PropagatesStopTo 会连带停掉 nginx，
        // 之后 start 只靠 Wants 不保证拉起，所以要显式确保 3000 在监听。
        step('web', '启动前端', 'running');
        const webProbe = async () => {
            const result = await exec(conn, `ss -ltn 2>/dev/null | grep -q ':3000 ' && echo ok || echo no`);
            return result.stdout.trim() === 'ok';
        };
        let webOk = await webProbe();
        if (!webOk) {
            try {
                await runSudo(conn, 'systemctl enable --now nginx', {
                    password: connInfo.password,
                    onLog: log,
                    timeoutMs: 120000,
                });
                await new Promise((r) => setTimeout(r, 1200));
                webOk = await webProbe();
            } catch (err) {
                log(`启动 nginx 失败：${err.message}`);
            }
        }
        step('web', '启动前端', webOk ? 'ok' : 'warn',
            webOk ? `http://${connInfo.host}:3000` : '3000 未监听：在机器人上执行 sudo nginx -t 查看原因');

        step('verify', '校验安装', 'running');
        const installed = await queryInstalledVersion(conn, service);
        if (!installed) {
            step('verify', '校验安装', 'fail', 'dpkg-query 查不到版本');
            throw new Error('安装后查不到包版本，安装可能失败（检查 apt 输出）');
        }
        const entry = await exec(conn,
            `test -f ${shellQuote(`${DEFAULT_INSTALL_DIR}/dex/dex_bridge.py`)} && echo ok`);
        if (entry.stdout.trim() !== 'ok') {
            step('verify', '校验安装', 'fail', `缺少 ${DEFAULT_INSTALL_DIR}/dex/dex_bridge.py`);
            throw new Error(`安装后缺少桥接程序 ${DEFAULT_INSTALL_DIR}/dex/dex_bridge.py`);
        }
        const { active, state } = await serviceActive(conn, service);
        const probe = parsePortProbe((await exec(conn, portProbeCommand(ports))).stdout);
        const failed = PORT_KEYS
            .map((key) => ports[key])
            .filter((port) => port && !probe[port]?.ok);
        const logTail = active ? await serviceLogTail(conn, service, 20) : '';
        step('verify', '校验安装', 'ok',
            active
                ? `${service} ${installed} 已安装，服务运行中`
                : `${service} ${installed} 已安装，服务未启动（点「启动」）`);

        // 安装包留在 /tmp 会占几百 MB，装完即删
        await exec(conn, `rm -f ${shellQuote(remoteDeb)}`);

        const result = {
            ok: true,
            firmware: firmware.id,
            firmwareLabel: firmware.label,
            model,
            host: connInfo.host,
            username: connInfo.username,
            package: { name: pkg.name, version: pkg.version, arch: pkg.arch, size: pkg.size },
            installedVersion: installed,
            service,
            configPath,
            installDir: DEFAULT_INSTALL_DIR,
            enabled: enable,
            running: active,
            state,
            ports,
            webUrl: `http://${connInfo.host}:3000`,
            web: { url: `http://${connInfo.host}:3000`, ok: webOk },
            directUrls: {
                control: `ws://${connInfo.host}:${ports.control}`,
                status: ports.status ? `ws://${connInfo.host}:${ports.status}` : null,
                camera: ports.camera ? `ws://${connInfo.host}:${ports.camera}` : null,
            },
            logTail,
            warnings: [
                ...(active && failed.length ? [`端口未就绪：${failed.join(', ')}`] : []),
                ...(webOk ? [] : ['前端 3000 未监听：nginx 未启动，可在机器人上执行 sudo systemctl enable --now nginx']),
            ],
        };
        emit({ type: 'result', ok: true, data: result });
        return result;
    } finally {
        try { conn.end(); } catch { /* ignore */ }
    }
}

// ============================================================
// 启停 / 状态 / 日志（systemd 托管）
// ============================================================

export async function action(options) {
    const firmware = getFirmware(options.firmwareId);
    const connInfo = normalizeConnection(options);
    const ports = normalizePorts(firmware, options.ports);
    const service = firmware.service || DEFAULT_SERVICE;
    const actionName = String(options.action || '').trim();

    const conn = await connect(connInfo);
    try {
        const installed = await queryInstalledVersion(conn, service);

        // 状态查询要在「未安装」时也能回答：用登录用户进来查包、服务与端口
        if (actionName === 'status') {
            const { active, state } = await serviceActive(conn, service);
            const probe = parsePortProbe((await exec(conn, portProbeCommand(ports))).stdout);
            const nginx = (await exec(conn, 'systemctl is-active nginx 2>/dev/null || true')).stdout.trim();
            const enabledState = (await exec(conn,
                `systemctl is-enabled ${shellQuote(service)} 2>/dev/null || true`)).stdout.trim();
            const webListening = (await exec(conn,
                `ss -ltn 2>/dev/null | grep -q ':3000 ' && echo ok || echo no`)).stdout.trim() === 'ok';
            const tail = installed ? await serviceLogTail(conn, service, 20) : '';
            return {
                ok: true,
                action: 'status',
                host: connInfo.host,
                username: connInfo.username,
                service,
                installed: Boolean(installed),
                installedVersion: installed,
                running: active,
                state,
                enabled: enabledState === 'enabled',
                web: { nginx: nginx || 'unknown', port3000: webListening },
                ports: Object.fromEntries(Object.entries(probe).map(([port, value]) => [port, value.ok])),
                logTail: tail,
            };
        }

        if (actionName === 'logs') {
            const lines = Math.min(1000, Math.max(20, Number(options.lines) || 200));
            const result = await exec(conn,
                `journalctl -u ${shellQuote(service)} -n ${lines} --no-pager 2>/dev/null || true`);
            return { ok: true, action: 'logs', log: result.stdout, installed: Boolean(installed) };
        }

        if (actionName === 'uninstall') {
            const purge = options.purge === true || options.purge === '1' || options.purge === 'true';
            // 先停服；可能本来就没装，失败不阻断
            await runSudo(conn, `systemctl stop ${shellQuote(service)} nginx || true`, {
                password: connInfo.password,
                timeoutMs: 60000,
            });
            await runSudo(conn, `systemctl disable ${shellQuote(service)} nginx || true`, {
                password: connInfo.password,
                timeoutMs: 60000,
            });
            if (installed) {
                // -r 保留 /etc/robot-editor 配置；-P 连配置与前端产物一起删
                await runSudo(conn, `dpkg ${purge ? '-P' : '-r'} ${shellQuote(service)}`, {
                    password: connInfo.password,
                    timeoutMs: 180000,
                });
            }
            // prerm 会摘站点链接，这里兜底清理并让 nginx 放掉 3000
            await runSudo(conn,
                'rm -f /etc/nginx/sites-enabled/robot-editor.conf; '
                + 'systemctl is-active nginx >/dev/null 2>&1 && systemctl reload nginx || true',
                { password: connInfo.password, timeoutMs: 60000 });

            const remaining = await queryInstalledVersion(conn, service);
            const webListening = (await exec(conn,
                `ss -ltn 2>/dev/null | grep -q ':3000 ' && echo ok || echo no`)).stdout.trim() === 'ok';
            return {
                ok: !remaining,
                action: 'uninstall',
                purge,
                removed: !remaining,
                installedVersion: remaining || '',
                message: remaining
                    ? `${service} 仍在系统上（${remaining}），请检查 dpkg 输出`
                    : `${service} 已卸载${purge ? '（配置与前端产物已删除）' : '（保留 /etc/robot-editor 配置）'}`,
                web: { port3000: webListening },
            };
        }

        if (!installed) {
            throw bad(`${service} 尚未安装到 ${connInfo.host}（先执行「安装」）`);
        }

        if (actionName === 'enable' || actionName === 'disable') {
            // 开机自启一起设置：systemctl enable|disable robot-editor nginx
            await runSudo(conn, `systemctl ${actionName} ${shellQuote(service)} nginx`, {
                password: connInfo.password,
                timeoutMs: 60000,
            });
            return {
                ok: true,
                action: actionName,
                message: `${service} 与 nginx 已${actionName === 'enable' ? '设为开机启动' : '取消开机启动'}`,
            };
        }

        if (actionName === 'stop') {
            // 桥接与前端一起停：systemctl stop robot-editor nginx
            await runSudo(conn, `systemctl stop ${shellQuote(service)} nginx`, {
                password: connInfo.password,
                timeoutMs: 60000,
            });
            return { ok: true, action: 'stop', message: `${service} 与 nginx 已停止` };
        }

        if (actionName === 'start' || actionName === 'restart') {
            const verb = actionName === 'restart' ? 'restart' : 'start';
            // 桥接与前端一起起：systemctl start|restart robot-editor nginx
            await runSudo(conn, `systemctl ${verb} ${shellQuote(service)} nginx`, {
                password: connInfo.password,
                timeoutMs: 120000,
            });
            await new Promise((r) => setTimeout(r, 2500));
            const { active, state } = await serviceActive(conn, service);
            if (!active) {
                const tail = await serviceLogTail(conn, service, 40);
                throw new Error(`${verb} 后服务未进入 active（${state}）。日志：\n${tail}`);
            }
            const probe = parsePortProbe((await exec(conn, portProbeCommand(ports))).stdout);
            const webListening = (await exec(conn,
                `ss -ltn 2>/dev/null | grep -q ':3000 ' && echo ok || echo no`)).stdout.trim() === 'ok';
            return {
                ok: true,
                action: actionName,
                message: `${service} 与 nginx 已${verb === 'restart' ? '重启' : '启动'}`,
                web: { port3000: webListening },
                ports: Object.fromEntries(Object.entries(probe).map(([port, value]) => [port, value.ok])),
            };
        }

        throw bad(`不支持的 action "${actionName}"`);
    } finally {
        try { conn.end(); } catch { /* ignore */ }
    }
}
