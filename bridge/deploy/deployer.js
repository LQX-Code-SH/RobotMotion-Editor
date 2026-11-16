/**
 * 一键部署器：通过 SSH/SFTP 把桥接固件推到机器人主机并拉起。
 *
 * 设计约束：
 * - 只由操作站的 station.js 调用；浏览器不接触 SSH 凭据。
 * - 密码仅在该模块内用于一次 SSH 握手，不写日志、不进事件流、不落盘。
 * - 所有远端命令都经过白名单参数拼装 + shell 引号转义。
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'ssh2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = resolve(__dirname, '..');
const MANIFEST = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf-8'));

const DEFAULT_PORTS = MANIFEST.defaults.ports;
const REMOTE_ROOT = MANIFEST.defaults.remoteRoot || '.robot-motion-bridge';
const PORT_KEYS = ['control', 'status', 'camera', 'beacon'];

// ============================================================
// 公开信息（不含凭据）
// ============================================================

export function listFirmwares() {
    return MANIFEST.firmwares.map((firmware) => ({
        id: firmware.id,
        label: firmware.label,
        description: firmware.description,
        runtime: firmware.runtime,
        model: firmware.model,
        models: firmware.models || [firmware.model],
        supportsCamera: firmware.supportsCamera !== false,
        ports: { ...DEFAULT_PORTS, ...(firmware.ports || {}) },
    }));
}

// ============================================================
// 参数校验
// ============================================================

const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$/;
const USER_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const HAND_VALUES = new Set(['auto', 'brainco', 'inspire', 'none']);

function bad(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function getFirmware(firmwareId) {
    const firmware = MANIFEST.firmwares.find((f) => f.id === firmwareId);
    if (!firmware) throw bad(`未知固件类型 "${firmwareId}"`);
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
    const privateKeyPath = input.privateKeyPath ? String(input.privateKeyPath) : '';
    if (!password && !privateKeyPath) throw bad('需要登录密码或私钥');
    return { host, port, username, password, privateKeyPath };
}

function normalizeModel(firmware, requested) {
    const model = requested && firmware.models?.includes(requested) ? requested : firmware.model;
    if (!firmware.models?.includes(model) && model !== firmware.model) {
        throw bad(`固件 ${firmware.id} 不支持机型 ${requested}`);
    }
    return model;
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

function exec(conn, command, { onLog, timeoutMs = 30000 } = {}) {
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

function sftpMkdir(sftp, remoteDir) {
    const parts = remoteDir.split('/').filter(Boolean);
    let current = remoteDir.startsWith('/') ? '' : '.';
    const makeOne = (dir) => new Promise((resolvePromise) => {
        sftp.mkdir(dir, { mode: 0o755 }, () => resolvePromise());
    });
    return (async () => {
        for (const part of parts) {
            current = current === '' ? `/${part}` : `${current}/${part}`;
            await makeOne(current);
        }
    })();
}

function sftpPut(sftp, localPath, remotePath) {
    return new Promise((resolvePromise, rejectPromise) => {
        sftp.fastPut(localPath, remotePath, (err) => (err ? rejectPromise(err) : resolvePromise()));
    });
}

// ============================================================
// 文件收集与脚本生成
// ============================================================

function collectFiles(entry, model) {
    const from = resolve(BRIDGE_DIR, entry.from.replaceAll('{{model}}', model));
    const to = entry.to.replaceAll('{{model}}', model);
    const files = [];
    const walk = (path, rel) => {
        const stat = statSync(path);
        if (stat.isDirectory()) {
            for (const name of readdirSync(path)) {
                if (name === '__pycache__' || name.endsWith('.pyc')) continue;
                walk(join(path, name), rel ? `${rel}/${name}` : name);
            }
            return;
        }
        files.push({ local: path, remote: rel ? `${to}/${rel}` : to });
    };
    walk(from, '');
    return files;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildArgs(firmware, model, ports) {
    const args = [];
    if (firmware.runtime === 'python') {
        args.push('--model', model);
        args.push('--host', '0.0.0.0');
        args.push('--ws-port', String(ports.control));
        args.push('--status-port', String(ports.status));
        args.push('--camera-port', String(ports.camera));
        args.push('--beacon-port', String(ports.beacon));
        const hand = HAND_VALUES.has(firmware.args?.hand) ? firmware.args.hand : 'auto';
        args.push('--hand', hand);
        if (firmware.args?.['dry-run']) args.push('--dry-run');
    } else {
        args.push('--model', model);
        args.push('--adapter', firmware.args?.adapter === 'ubtech' ? 'ubtech' : 'mock');
        args.push('--ws-port', String(ports.control));
        args.push('--status-port', String(ports.status));
        args.push('--beacon-port', String(ports.beacon));
    }
    return args.map(shellQuote).join(' ');
}

function buildRunScript(firmware, model, ports) {
    // 不能用 set -u：ROS 2 的 setup.bash 会引用未定义的 AMENT_TRACE_SETUP_FILES
    // 等变量，在 nounset 下会直接中止脚本，导致真机固件启动失败。
    const lines = ['#!/usr/bin/env bash', 'set -o pipefail', 'cd "$(dirname "$0")"'];
    if (firmware.runtime === 'python') {
        for (const setup of firmware.rosSetup || []) {
            lines.push(`if [ -f ${setup} ]; then source ${setup}; fi`);
        }
        lines.push('echo $$ > bridge.pid');
        // -u：不缓冲 stdout，否则 bridge.log 要攒满一个缓冲区才落盘，
        // 「日志」按钮和部署校验的 logTail 会是空的。
        lines.push(`exec python3 -u ${firmware.entry} ${buildArgs(firmware, model, ports)}`);
    } else {
        lines.push('cd bridge');
        lines.push('echo $$ > ../bridge.pid');
        lines.push(`exec node ${firmware.entry.replace(/^bridge\//, '')} ${buildArgs(firmware, model, ports)}`);
    }
    return `${lines.join('\n')}\n`;
}

/**
 * 把 run.sh 写到远端。
 * 部署与「启动」共用同一份逻辑：启动前按当前端口重写脚本，
 * 避免「改了端口点启动」仍在用上一次部署留下的旧脚本。
 */
async function writeRunScript(conn, baseDir, firmware, model, ports) {
    const sftp = await getSftp(conn);
    const scriptPath = `${baseDir}/run.sh`;
    const script = buildRunScript(firmware, model, ports);
    await new Promise((resolvePromise, rejectPromise) => {
        const stream = sftp.createWriteStream(scriptPath, { mode: 0o755 });
        stream.on('close', resolvePromise);
        stream.on('error', rejectPromise);
        stream.end(script);
    });
    await execChecked(conn, `chmod +x ${shellQuote(scriptPath)}`);
}

// ============================================================
// 远端操作片段
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

async function isProcessAlive(conn, baseDir) {
    const result = await exec(
        conn,
        `if [ -f ${shellQuote(`${baseDir}/bridge.pid`) } ]; then ` +
        `pid=$(cat ${shellQuote(`${baseDir}/bridge.pid`)}); ` +
        `if kill -0 "$pid" 2>/dev/null; then echo alive; else echo dead; fi; ` +
        `else echo missing; fi`
    );
    return result.stdout.trim() || 'missing';
}

function startCommand(baseDir) {
    // 必须用子 shell 组 `( ... & )` 后台化：写成 `A && B &` 时 `&` 的优先级更低，
    // 整条链会被放到后台而前台 shell 仍在等待它，SSH 通道不关闭，
    // 部署会在「启动桥接」步骤 30s 超时（其实进程已经起来了）。
    return `cd ${shellQuote(baseDir)} && chmod +x run.sh && ` +
        `(setsid nohup ./run.sh > bridge.log 2>&1 < /dev/null &) ; echo started`;
}

async function installPythonDeps(conn, firmware, onLog) {
    const deps = firmware.pythonDeps || [];
    if (!deps.length) return '无需安装 Python 依赖';
    const check = await exec(conn, `python3 -c "import websockets"`);
    if (check.code === 0) return 'Python 依赖已存在（websockets）';

    onLog('缺少 websockets，尝试 pip --user 安装…');
    const spec = deps.map(shellQuote).join(' ');
    let install = await exec(conn, `python3 -m pip install --user --no-input ${spec}`, { onLog, timeoutMs: 180000 });
    if (install.code !== 0) {
        onLog('pip --user 失败，尝试 --break-system-packages（Ubuntu 24.04 PEP 668）…');
        install = await exec(conn, `python3 -m pip install --user --no-input --break-system-packages ${spec}`,
            { onLog, timeoutMs: 180000 });
    }
    if (install.code !== 0) {
        throw new Error('websockets 安装失败：机器人可能无外网。可先在机器人上执行 '
            + '`sudo apt install python3-websockets` 或 `pip install --user websockets` 后重试');
    }
    const verify = await exec(conn, `python3 -c "import websockets"`);
    if (verify.code !== 0) throw new Error('websockets 安装后仍无法导入');
    return '已安装 Python 依赖（websockets）';
}

async function installNodeDeps(conn, baseDir, onLog) {
    const dir = `${baseDir}/bridge`;
    const check = await exec(conn, `cd ${shellQuote(dir)} && node -e "require.resolve('ws')"`);
    if (check.code === 0) return 'Node 依赖已存在（ws）';

    onLog('缺少 ws 模块，执行 npm install --omit=dev…');
    const install = await exec(conn, `cd ${shellQuote(dir)} && npm install --omit=dev --no-audit --no-fund`,
        { onLog, timeoutMs: 300000 });
    if (install.code !== 0) {
        const output = `${install.stdout || ''}${install.stderr || ''}`;
        if (/command not found|not recognized/i.test(output)) {
            throw new Error('机器人缺少 npm：请先安装 Node.js（含 npm）后重试，或改用 Python 固件');
        }
        throw new Error('npm install 失败：机器人可能无外网，请先手动安装依赖或改用 Python 固件');
    }
    return '已安装 Node 依赖（ws）';
}

// ============================================================
// 预检
// ============================================================

export async function preflight(options) {
    const firmware = getFirmware(options.firmwareId);
    const connInfo = normalizeConnection(options);
    const ports = normalizePorts(firmware, options.ports);
    const model = normalizeModel(firmware, options.model);

    const checks = [];
    const add = (id, label, status, detail = '') => checks.push({ id, label, status, detail });

    add('firmware', '固件类型', 'ok', `${firmware.label}（${firmware.runtime} / ${model}）`);

    let conn;
    try {
        conn = await connect(connInfo);
        add('ssh', 'SSH 连接', 'ok', `${connInfo.username}@${connInfo.host}:${connInfo.port}`);
    } catch (err) {
        add('ssh', 'SSH 连接', 'fail', err.message);
        return { ok: false, checks, firmware: firmware.id, model, ports };
    }

    try {
        const runtimeCmd = firmware.runtime === 'python' ? 'python3 -V' : 'node -v';
        const runtime = await exec(conn, runtimeCmd);
        add('runtime', firmware.runtime === 'python' ? 'Python 运行时' : 'Node 运行时',
            runtime.code === 0 ? 'ok' : 'fail',
            (runtime.stdout || runtime.stderr).trim() || '未找到');

        const home = (await exec(conn, 'printf %s "$HOME"')).stdout.trim();
        add('home', '远端目录', 'ok', `${home}/${REMOTE_ROOT}/${firmware.id}`);

        const osName = await exec(conn, '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"');
        add('os', '操作系统', osName.code === 0 ? 'ok' : 'warn', osName.stdout.trim() || '未知');

        const disk = await exec(conn, `df -h ${shellQuote(home)} | tail -1`);
        add('disk', '磁盘空间', 'ok', disk.stdout.trim().replace(/\s+/g, ' '));

        const baseDir = `${home}/${REMOTE_ROOT}/${firmware.id}`;
        const state = await isProcessAlive(conn, baseDir);

        const probe = await exec(conn, portProbeCommand(ports));
        const probeResult = parsePortProbe(probe.stdout);
        const busy = Object.entries(probeResult)
            .filter(([, value]) => value.ok)
            .map(([port]) => port);
        add('ports', '端口占用', busy.length ? 'warn' : 'ok',
            busy.length
                ? (state === 'alive'
                    ? `已占用：${busy.join(', ')}（部署会先停止旧实例）`
                    : `已占用：${busy.join(', ')}（不是本面板启动的进程，请换端口或先手动停止，否则启动会失败）`)
                : '全部可用');

        add('instance', '已有实例', state === 'alive' ? 'warn' : 'ok',
            state === 'alive' ? '检测到运行中的桥接，部署将重启' : '无运行实例');

        if (firmware.runtime === 'python') {
            const dep = await exec(conn, 'python3 -c "import websockets"');
            add('dep', 'Python 依赖 websockets', dep.code === 0 ? 'ok' : 'warn',
                dep.code === 0 ? '已安装' : '缺失，部署时自动安装（需机器人可访问软件源）');
            const ros = firmware.rosSetup || [];
            const missing = [];
            for (const setup of ros) {
                const r = await exec(conn, `if [ -f ${setup} ]; then echo yes; else echo no; fi`);
                if (r.stdout.trim() !== 'yes') missing.push(setup);
            }
            add('ros', 'ROS 2 环境', missing.length ? 'warn' : 'ok',
                missing.length
                    ? `缺少：${missing.join(', ')}（真机运行前需补齐；dry-run 固件可忽略）`
                    : 'ROS 2 setup.bash 齐全');
        } else {
            const dep = await exec(conn, `cd ${shellQuote(`${baseDir}/bridge`)} 2>/dev/null && node -e "require.resolve('ws')"`);
            add('dep', 'Node 依赖 ws', dep.code === 0 ? 'ok' : 'warn',
                dep.code === 0 ? '已安装' : '缺失，部署时 npm install');
        }

        const dfOk = checks.find((c) => c.id === 'ssh')?.status === 'ok';
        return {
            ok: dfOk && checks.every((c) => c.status !== 'fail'),
            checks,
            firmware: firmware.id,
            model,
            ports,
        };
    } finally {
        try { conn.end(); } catch { /* ignore */ }
    }
}

// ============================================================
// 部署
// ============================================================

export async function deploy(options, emit = () => {}) {
    const firmware = getFirmware(options.firmwareId);
    const connInfo = normalizeConnection(options);
    const ports = normalizePorts(firmware, options.ports);
    const model = normalizeModel(firmware, options.model);
    const step = (id, label, status, message = '') => emit({ type: 'step', id, label, status, message });
    const log = (message) => emit({ type: 'log', message: String(message).replace(/\s+$/, '') });

    step('connect', 'SSH 连接', 'running', `${connInfo.username}@${connInfo.host}:${connInfo.port}`);
    const conn = await connect(connInfo);
    step('connect', 'SSH 连接', 'ok');

    try {
        // 先确认远端运行时：缺 node/python3 时立刻给出明确提示，不必等上传完再失败
        step('runtime', '检查运行时', 'running', firmware.runtime === 'python' ? 'python3' : 'node');
        const runtime = await exec(conn, firmware.runtime === 'python' ? 'python3 -V' : 'node -v');
        if (runtime.code !== 0) {
            const hint = firmware.runtime === 'python'
                ? '机器人上找不到 python3：请先安装 Python 3 后重试'
                : '机器人上找不到 node：请先安装 Node.js 18+（含 npm），或改用 Python 固件（天工 DEX）';
            step('runtime', '检查运行时', 'fail', hint);
            throw new Error(hint);
        }
        step('runtime', '检查运行时', 'ok', (runtime.stdout || runtime.stderr).trim());

        const home = (await execChecked(conn, 'printf %s "$HOME"')).stdout.trim();
        const baseDir = `${home}/${REMOTE_ROOT}/${firmware.id}`;

        step('remote', '准备远端目录', 'running', baseDir);
        await execChecked(conn, `mkdir -p ${shellQuote(baseDir)}`);
        step('remote', '准备远端目录', 'ok');

        step('upload', '上传固件文件', 'running');
        const sftp = await getSftp(conn);
        const files = (firmware.files || []).flatMap((entry) => collectFiles(entry, model));
        if (!files.length) throw new Error('固件清单未包含任何文件');
        const dirs = new Set();
        for (const file of files) {
            const remoteDir = `${baseDir}/${file.remote.split('/').slice(0, -1).join('/')}`;
            if (!dirs.has(remoteDir)) {
                await sftpMkdir(sftp, remoteDir);
                dirs.add(remoteDir);
            }
        }
        for (const file of files) {
            await sftpPut(sftp, file.local, `${baseDir}/${file.remote}`);
            log(`upload ${file.remote}`);
        }
        step('upload', '上传固件文件', 'ok', `${files.length} 个文件`);

        step('script', '生成启动脚本', 'running');
        await writeRunScript(conn, baseDir, firmware, model, ports);
        step('script', '生成启动脚本', 'ok', `control:${ports.control} status:${ports.status} camera:${ports.camera}`);

        step('deps', '安装运行依赖', 'running');
        const depMessage = firmware.runtime === 'python'
            ? await installPythonDeps(conn, firmware, log)
            : await installNodeDeps(conn, baseDir, log);
        step('deps', '安装运行依赖', 'ok', depMessage);

        step('stop', '停止旧实例', 'running');
        await stopInstance(conn, baseDir, log);
        step('stop', '停止旧实例', 'ok');

        step('start', '启动桥接', 'running');
        await execChecked(conn, startCommand(baseDir));
        step('start', '启动桥接', 'ok');

        step('verify', '校验服务状态', 'running');
        await new Promise((r) => setTimeout(r, 2500));
        const alive = await isProcessAlive(conn, baseDir);
        if (alive !== 'alive') {
            const tail = await exec(conn, `tail -n 40 ${shellQuote(`${baseDir}/bridge.log`)}`);
            throw new Error(`桥接进程未存活（${alive}）。日志：\n${tail.stdout.trim()}`);
        }
        const probe = await exec(conn, portProbeCommand(ports));
        const probeResult = parsePortProbe(probe.stdout);
        const failed = PORT_KEYS
            .map((key) => ports[key])
            .filter((port) => port && !probeResult[port]?.ok);
        const logTail = (await exec(conn, `tail -n 20 ${shellQuote(`${baseDir}/bridge.log`)}`)).stdout.trim();
        step('verify', '校验服务状态', failed.length ? 'warn' : 'ok',
            failed.length ? `端口未就绪：${failed.join(', ')}` : '全部端口已就绪');

        const result = {
            ok: true,
            firmware: firmware.id,
            firmwareLabel: firmware.label,
            model,
            host: connInfo.host,
            username: connInfo.username,
            baseDir,
            ports,
            directUrls: {
                control: `ws://${connInfo.host}:${ports.control}`,
                status: ports.status ? `ws://${connInfo.host}:${ports.status}` : null,
                camera: ports.camera ? `ws://${connInfo.host}:${ports.camera}` : null,
            },
            logTail,
            warnings: failed.length ? [`端口未就绪：${failed.join(', ')}`] : [],
        };
        emit({ type: 'result', ok: true, data: result });
        return result;
    } finally {
        try { conn.end(); } catch { /* ignore */ }
    }
}

// ============================================================
// 启停 / 状态 / 日志
// ============================================================

async function stopInstance(conn, baseDir, log) {
    const state = await isProcessAlive(conn, baseDir);
    if (state !== 'alive') {
        await exec(conn, `rm -f ${shellQuote(`${baseDir}/bridge.pid`)}`);
        return '无运行实例';
    }
    log('停止旧实例…');
    await exec(conn, `pid=$(cat ${shellQuote(`${baseDir}/bridge.pid`)}); ` +
        `kill "$pid" 2>/dev/null; ` +
        `for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done; ` +
        `kill -9 "$pid" 2>/dev/null; true`);
    await exec(conn, `rm -f ${shellQuote(`${baseDir}/bridge.pid`)}`);
    return '旧实例已停止';
}

export async function action(options) {
    const firmware = getFirmware(options.firmwareId);
    const connInfo = normalizeConnection(options);
    const ports = normalizePorts(firmware, options.ports);
    const model = normalizeModel(firmware, options.model);
    const actionName = String(options.action || '').trim();

    const conn = await connect(connInfo);
    try {
        const home = (await execChecked(conn, 'printf %s "$HOME"')).stdout.trim();
        const baseDir = `${home}/${REMOTE_ROOT}/${firmware.id}`;
        const exists = await exec(conn, `[ -f ${shellQuote(`${baseDir}/run.sh`)} ] && echo yes || echo no`);
        if (exists.stdout.trim() !== 'yes') {
            throw bad(`固件 ${firmware.id} 尚未部署到 ${connInfo.host}`);
        }

        if (actionName === 'stop') {
            const message = await stopInstance(conn, baseDir, () => {});
            return { ok: true, action: 'stop', message };
        }

        if (actionName === 'start' || actionName === 'restart') {
            if (actionName === 'restart') await stopInstance(conn, baseDir, () => {});
            else {
                const state = await isProcessAlive(conn, baseDir);
                if (state === 'alive') {
                    return {
                        ok: true,
                        action: actionName,
                        message: '已在运行（如需改用新端口，请先「停止」再「启动」，或直接「一键安装」）'
                    };
                }
            }
            // 按本次请求的端口重写启动脚本，避免沿用上一次部署的旧端口
            await writeRunScript(conn, baseDir, firmware, model, ports);
            await execChecked(conn, startCommand(baseDir));
            await new Promise((r) => setTimeout(r, 2500));
            const alive = await isProcessAlive(conn, baseDir);
            if (alive !== 'alive') {
                const tail = await exec(conn, `tail -n 40 ${shellQuote(`${baseDir}/bridge.log`)}`);
                throw new Error(`启动失败，日志：\n${tail.stdout.trim()}`);
            }
            const probe = parsePortProbe((await exec(conn, portProbeCommand(ports))).stdout);
            return {
                ok: true,
                action: actionName,
                message: '已启动',
                ports: Object.fromEntries(Object.entries(probe).map(([port, value]) => [port, value.ok])),
            };
        }

        if (actionName === 'status') {
            const state = await isProcessAlive(conn, baseDir);
            const probe = parsePortProbe((await exec(conn, portProbeCommand(ports))).stdout);
            const tail = (await exec(conn, `tail -n 20 ${shellQuote(`${baseDir}/bridge.log`)}`)).stdout.trim();
            return {
                ok: true,
                action: 'status',
                running: state === 'alive',
                baseDir,
                ports: Object.fromEntries(Object.entries(probe).map(([port, value]) => [port, value.ok])),
                logTail: tail,
            };
        }

        if (actionName === 'logs') {
            const lines = Math.min(1000, Math.max(20, Number(options.lines) || 200));
            const tail = await exec(conn, `tail -n ${lines} ${shellQuote(`${baseDir}/bridge.log`)}`);
            return { ok: true, action: 'logs', log: tail.stdout };
        }

        throw bad(`不支持的 action "${actionName}"`);
    } finally {
        try { conn.end(); } catch { /* ignore */ }
    }
}
