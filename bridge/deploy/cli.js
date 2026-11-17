#!/usr/bin/env node
/**
 * 机器人本体远程安装 CLI。
 *
 * 在操作站执行：按固件型号匹配 Release/robot-editor_<version>_<arch>.deb，
 * scp 到机器人 → apt 安装 → 可选设为开机启动；已装好的机器人日常可查状态、启停、看日志。
 *
 * 用法：
 *   node bridge/deploy/cli.js list
 *   node bridge/deploy/cli.js install --host 192.168.41.2 --user nvidia [--port 22]
 *                                     [--firmware tienkung_dex] [--enable]
 *   node bridge/deploy/cli.js status|start|stop|logs --host ... --user ...
 *
 * 密码：优先读环境变量 ROBOT_SSH_PASSWORD，否则在终端里隐藏输入。
 * 也支持 `--password-stdin`（从管道读一行），便于自动化。
 */
import { deploy, action, listFirmwares } from './deployer.js';

const HELP = `用法：
  node bridge/deploy/cli.js list
  node bridge/deploy/cli.js install --host <IP> --user <用户名> [选项]
  node bridge/deploy/cli.js status|start|stop|restart|enable|disable|logs|uninstall --host <IP> --user <用户名> [选项]

说明：start / stop / restart / enable / disable 会同时作用于
      robot-editor 与 nginx（systemctl <动词> robot-editor nginx）。
      uninstall 默认 dpkg -r 保留 /etc/robot-editor 配置，加 --purge 才彻底删除。

选项：
  --host <IP>           机器人 IP / 主机名（必填）
  --user <用户名>       SSH 用户名（必填；非 root 时用登录密码 sudo 提权）
  --port <端口>         SSH 端口，默认 22
  --firmware <型号>     固件型号，默认 tienkung_dex
  --enable              安装后设为开机启动（systemctl enable）
  --purge               uninstall 时同时删除配置与前端产物（dpkg -P）
  --lines <行数>        logs 命令取多少行，默认 200
  --password-stdin      从 stdin 读密码（默认读环境变量或交互输入）

示例：
  scripts/install-remote.sh install --host 192.168.41.2 --user nvidia --enable
  node bridge/deploy/cli.js status --host 192.168.41.2 --user nvidia
`;

function parseArgs(argv) {
    const positional = [];
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        const item = argv[i];
        if (!item.startsWith('--')) {
            positional.push(item);
            continue;
        }
        const key = item.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            options[key] = true;
        } else {
            options[key] = next;
            i += 1;
        }
    }
    return { positional, options };
}

/** 隐藏输入读取密码（TTY）或从管道读一行 */
function readPassword(prompt) {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        stdin.setEncoding('utf8');

        if (!stdin.isTTY) {
            let buffer = '';
            stdin.on('data', (chunk) => {
                buffer += chunk;
                const index = buffer.indexOf('\n');
                if (index >= 0) resolve(buffer.slice(0, index).replace(/\r$/, ''));
            });
            stdin.on('end', () => resolve(buffer.trim()));
            return;
        }

        process.stdout.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();
        let value = '';
        const cleanup = () => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
        };
        const onData = (chunk) => {
            for (const char of chunk) {
                if (char === '\n' || char === '\r' || char === '\u0004') {
                    cleanup();
                    process.stdout.write('\n');
                    resolve(value);
                    return;
                }
                if (char === '\u0003') {
                    cleanup();
                    process.stdout.write('\n');
                    reject(new Error('已取消'));
                    return;
                }
                if (char === '\u007f' || char === '\b') {
                    value = value.slice(0, -1);
                    continue;
                }
                value += char;
            }
        };
        stdin.on('data', onData);
    });
}

async function resolvePassword(options) {
    if (process.env.ROBOT_SSH_PASSWORD) return process.env.ROBOT_SSH_PASSWORD;
    if (options['password-stdin']) return readPassword('');
    return readPassword('机器人登录密码: ');
}

function printEvent(event) {
    if (event.type === 'step') {
        // 进行中的步骤不打点，完成时输出一行，避免 running/ok 重复两行
        if (event.status === 'running') return;
        const mark = event.status === 'fail' ? '✗' : event.status === 'warn' ? '!' : '✓';
        const detail = event.message ? `  ${event.message}` : '';
        console.log(`${mark} ${event.label || event.id}${detail}`);
        return;
    }
    if (event.type === 'log') {
        console.log(`    ${event.message}`);
        return;
    }
    if (event.type === 'error') {
        console.error(`✗ ${event.message}`);
        return;
    }
    if (event.type === 'result') {
        const data = event.data || {};
        const names = { control: '控制', status: '状态', camera: '相机', beacon: '发现' };
        console.log('');
        console.log('══ 安装结果 ══');
        console.log(`型号    ${data.firmwareLabel || data.firmware || '-'}`);
        console.log(`安装包  ${data.package?.name || '-'}（${data.package?.arch || '-'}）`);
        console.log(`服务    ${data.service} ${data.installedVersion || ''}（${data.running ? '运行中' : '未启动'}）`);
        console.log(`自启    ${data.enabled ? '已设为开机启动' : '未设置'}`);
        console.log(`端口    ${Object.entries(data.ports || {})
            .map(([key, value]) => `${value} ${names[key] || key}`).join('  ')}`);
        if (data.web) {
            console.log(`网页    ${data.web.url} ${data.web.ok ? '可访问' : '未监听（nginx 未启动）'}`);
        }
        for (const item of data.warnings || []) {
            console.log(`注意    ${item}`);
        }
    }
}

function printFirmwares() {
    console.log('固件型号：');
    for (const firmware of listFirmwares()) {
        const pkg = firmware.package;
        const state = pkg.available ? pkg.name : `不可用（${pkg.error}）`;
        console.log(`  ${firmware.supported ? '✓' : '·'} ${firmware.id.padEnd(14)} ${firmware.label}  →  ${state}`);
    }
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const command = positional[0] || 'help';

    if (command === 'help' || options.help) {
        console.log(HELP);
        return;
    }
    if (command === 'list') {
        printFirmwares();
        return;
    }
    if (!['install', 'status', 'start', 'stop', 'restart', 'enable', 'disable', 'logs', 'uninstall'].includes(command)) {
        console.error(`未知命令：${command}\n`);
        console.log(HELP);
        process.exitCode = 2;
        return;
    }

    const host = options.host;
    const username = options.user || options.username;
    if (!host || !username) {
        console.error('缺少 --host 或 --user\n');
        console.log(HELP);
        process.exitCode = 2;
        return;
    }

    const password = await resolvePassword(options);
    if (!password) {
        console.error('未提供密码');
        process.exitCode = 2;
        return;
    }

    const base = {
        host,
        port: options.port ? Number(options.port) : 22,
        username,
        password,
        firmwareId: options.firmware || 'tienkung_dex',
    };

    if (command === 'install') {
        console.log('');
        console.log('══ 开始安装 ══');
        console.log(`型号    ${base.firmwareId}`);
        console.log(`目标    ${base.username}@${base.host}:${base.port}`);
        console.log(`自启    ${options.enable ? '是' : '否'}`);
        await deploy({ ...base, enable: Boolean(options.enable) }, printEvent);
        return;
    }

    const result = await action({
        ...base,
        action: command,
        purge: Boolean(options.purge),
        lines: options.lines ? Number(options.lines) : 200,
    });

    if (command === 'status') {
        console.log('');
        console.log('══ 检查状态 ══');
        console.log(`主机    ${result.host}（${result.username}）`);
        console.log(`桥接    ${result.service} ${result.installed ? result.installedVersion : '未安装'}`);
        console.log(`运行    ${result.running ? '运行中' : `未运行（${result.state}）`}`);

        const web = result.web || {};
        console.log(`前端    nginx ${web.nginx || 'unknown'} · 3000 ${web.port3000 ? '可访问' : '未监听'}`);

        const ports = Object.entries(result.ports || {});
        if (ports.length) {
            console.log(`端口    ${ports.map(([port, ok]) => `${port} ${ok ? '✓' : '✗'}`).join('   ')}`);
        }
        if (!web.port3000) {
            console.log('修复    sudo systemctl enable --now nginx');
        }
        if (result.logTail) {
            console.log('最近日志');
            for (const line of String(result.logTail).split('\n').slice(-8)) {
                if (line.trim()) console.log(`    ${line}`);
            }
        }
        return;
    }

    if (command === 'logs') {
        console.log(result.log || '（暂无日志）');
        return;
    }

    console.log('');
    console.log(`══ ${command} ══`);
    console.log(`✓ ${result.message || `${command} 完成`}`);
    const ports = Object.entries(result.ports || {});
    if (ports.length) {
        console.log(`端口    ${ports.map(([port, ok]) => `${port} ${ok ? '✓' : '✗'}`).join('   ')}`);
    }
    if (result.web) {
        console.log(`网页    3000 ${result.web.port3000 ? '可访问' : '未监听'}`);
    }
}

main().catch((err) => {
    console.error(`失败：${err.message}`);
    process.exitCode = 1;
});
