import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'bridge', 'deploy', 'manifest.json'), 'utf-8'));

const MODELS = [
    'walker-tienkung-dex',
    'walker-tienkung-pro',
    'walker-c1',
    'walker-s2',
];

function loadProfile(model) {
    return JSON.parse(readFileSync(join(ROOT, 'robot', model, 'profile.json'), 'utf-8'));
}

test('manifest 由生成器产出且覆盖四款机型', () => {
    assert.equal(manifest.generatedBy, 'scripts/generate-deploy-manifest.mjs');
    assert.deepEqual(manifest.firmwares.map(f => f.id).sort(), [
        'tienkung_dex', 'tienkung_pro', 'walker_c1', 'walker_s2',
    ]);
    assert.deepEqual(
        manifest.firmwares.map(f => f.model).sort(),
        MODELS.slice().sort(),
    );
});

test('固件 ID、支持状态与末端配置来自 profile', () => {
    for (const model of MODELS) {
        const profile = loadProfile(model);
        const deploy = profile.bridge.deploy;
        const firmware = manifest.firmwares.find(f => f.model === model);

        assert.ok(firmware, `${model} 缺少 manifest 条目`);
        assert.equal(firmware.id, deploy.id);
        assert.equal(firmware.label, `${deploy.label}（${deploy.id}）`);
        assert.equal(firmware.supported, deploy.supported !== false);
        assert.deepEqual(firmware.config, { BRIDGE_HAND: deploy.hand });
        if (deploy.supported === false) {
            assert.equal(firmware.reason, deploy.reason);
        }
    }
});

test('固件端口来自 profile 且默认端口来自 Dex', () => {
    const dex = loadProfile('walker-tienkung-dex').bridge;
    assert.deepEqual(manifest.defaults.ports, {
        control: dex.wsPort,
        status: dex.statusPort,
        camera: dex.cameraPort,
        beacon: dex.beaconPort,
    });

    for (const model of MODELS) {
        const bridge = loadProfile(model).bridge;
        const firmware = manifest.firmwares.find(f => f.model === model);
        assert.deepEqual(firmware.ports, {
            control: bridge.wsPort,
            status: bridge.statusPort,
            camera: bridge.cameraPort,
            beacon: bridge.beaconPort,
        });
    }
});
