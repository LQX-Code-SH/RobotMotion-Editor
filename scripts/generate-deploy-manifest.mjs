#!/usr/bin/env node
/**
 * 扫描 robot/<机型>/profile.json，生成 bridge/deploy/manifest.json。
 *
 * 部署相关的机型元数据（型号、端口、末端配置、支持状态）只维护在 profile.json；
 * 部署公共常量（包通配、服务名、安装路径）在本脚本 defaults 中集中定义。
 *
 * 用法：
 *   node scripts/generate-deploy-manifest.mjs
 *   node scripts/generate-deploy-manifest.mjs --check
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROBOT_DIR = join(ROOT, 'robot');
const MANIFEST_PATH = join(ROOT, 'bridge', 'deploy', 'manifest.json');
const CHECK_ONLY = process.argv.includes('--check');

const DEFAULT_MODEL = 'walker-tienkung-dex';
const FIRMWARE_ORDER = ['walker-tienkung-dex', 'walker-tienkung-pro', 'walker-c1', 'walker-s2'];

function readProfiles() {
    const profiles = [];
    for (const entry of readdirSync(ROBOT_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        const profilePath = join(ROBOT_DIR, entry.name, 'profile.json');
        if (!existsSync(profilePath)) continue;
        profiles.push(JSON.parse(readFileSync(profilePath, 'utf-8')));
    }
    return profiles;
}

function order(model) {
    const index = FIRMWARE_ORDER.indexOf(model);
    return index < 0 ? FIRMWARE_ORDER.length : index;
}

const profiles = readProfiles().sort((a, b) => order(a.model) - order(b.model) || a.model.localeCompare(b.model));
const primary = profiles.find(p => p.model === DEFAULT_MODEL) || profiles[0];
if (!primary) {
    console.error('robot/ 下没有可用机型 profile.json');
    process.exitCode = 1;
}

const bridgeDefaults = primary?.bridge || {};
const defaults = {
    ports: {
        control: bridgeDefaults.wsPort || 8081,
        status: bridgeDefaults.statusPort || 8082,
        camera: bridgeDefaults.cameraPort || 8083,
        beacon: bridgeDefaults.beaconPort || 45678,
    },
    releaseDir: 'Release',
    package: 'robot-editor_*_arm64.deb',
    service: 'robot-editor',
    configPath: '/etc/robot-editor/bridge.conf',
    installDir: '/opt/robot-editor',
    remoteTempDir: '/tmp',
    enableOnInstall: false,
};

const primaryBackend = primary?.bridge?.deploy?.id
    || primary?.bridge?.backend
    || DEFAULT_MODEL.replace('walker-', '').replace(/-/g, '_');

function describe(profile, supported) {
    if (!supported) {
        return `预留型号：当前 Release 只提供 ${primaryBackend} 安装包`;
    }
    const caps = profile.bridge?.capabilities || {};
    const hands = caps.hands ? '灵巧手' : '无末端';
    const cameras = caps.cameras ? `${caps.cameras} 路相机推流` : '无相机推流';
    return `ROS 2 桥接 + ${hands} + ${cameras}；Release 中提供 robot-editor_*.deb`;
}

const firmwares = profiles.map((profile) => {
    const bridge = profile.bridge || {};
    const deploy = bridge.deploy || {};
    const backend = bridge.backend || profile.model.replace('walker-', '').replace(/-/g, '_');
    const firmwareId = deploy.id || backend;
    const supported = deploy.supported !== false;
    const firmware = {
        id: firmwareId,
        label: `${deploy.label || bridge.displayName || profile.displayName || profile.model}（${firmwareId}）`,
        description: deploy.description || describe(profile, supported),
        supported,
        package: defaults.package,
        service: defaults.service,
        model: profile.model,
        ports: {
            control: bridge.wsPort || defaults.ports.control,
            status: bridge.statusPort || defaults.ports.status,
            camera: bridge.cameraPort || defaults.ports.camera,
            beacon: bridge.beaconPort || defaults.ports.beacon,
        },
        config: { BRIDGE_HAND: deploy.hand || 'none' },
    };
    if (!supported && deploy.reason) firmware.reason = deploy.reason;
    return firmware;
});

const manifest = {
    version: 3,
    generatedBy: 'scripts/generate-deploy-manifest.mjs',
    defaults,
    firmwares,
};

const output = JSON.stringify(manifest, null, 2) + '\n';

if (CHECK_ONLY) {
    const current = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, 'utf-8') : '';
    if (current !== output) {
        console.error('bridge/deploy/manifest.json 与 robot/*/profile.json 不一致，请执行 pnpm run deploy:manifest');
        process.exitCode = 1;
    } else {
        console.log(`deploy manifest 检查通过：${firmwares.length} 个固件型号`);
    }
} else {
    writeFileSync(MANIFEST_PATH, output);
    console.log(`bridge/deploy/manifest.json 已生成：${firmwares.length} 个固件型号`);
    firmwares.forEach(f => console.log(`  ${f.supported ? '✓' : ' '} ${f.id} (${f.model})`));
}
