/**
 * 固件部署面板的表单默认值逻辑。
 *
 * 关注两条约定：
 *  - 端口默认值优先级：当前连接的桥接实际端口 > 上次用过的端口 > 固件默认值；
 *  - 固件类型与机型共用一个存储 key（"固件ID|机型"），避免切换固件后机型残留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { RobotDeployUI } from '../../src/robot/RobotDeployUI.js';

const FORM_HTML = `<!doctype html><html><body>
    <input id="robot-deploy-host" />
    <input id="robot-deploy-ssh-port" value="22" />
    <input id="robot-deploy-username" />
    <input id="robot-deploy-password" />
    <select id="robot-deploy-firmware"></select>
    <select id="robot-deploy-model"></select>
    <div id="robot-deploy-model-field" style="display:none"></div>
    <input id="robot-deploy-port-control" value="8081" />
    <input id="robot-deploy-port-status" value="8082" />
    <input id="robot-deploy-port-camera" value="8083" />
    <input id="robot-deploy-port-beacon" value="45678" />
    <div id="robot-deploy-log"></div>
    <details id="robot-deploy"></details>
    <input id="robot-device-address" />
</body></html>`;

const FIRMWARES = [
    {
        id: 'tienkung-dex',
        label: '天工 DEX',
        model: 'walker-tienkung-dex',
        models: ['walker-tienkung-dex'],
        supportsCamera: true,
        ports: { control: 8081, status: 8082, camera: 8083, beacon: 45678 }
    },
    {
        id: 'tienkung-dex-dryrun',
        label: '天工 DEX dry-run',
        model: 'walker-tienkung-dex',
        models: ['walker-tienkung-dex'],
        supportsCamera: false,
        ports: { control: 8081, status: 8082, camera: 8083, beacon: 45678 }
    },
    {
        id: 'walker-node',
        label: 'Walker Node',
        model: 'walker-s2',
        models: ['walker-s2', 'walker-c1'],
        supportsCamera: false,
        ports: { control: 8081, status: 8082, camera: 8083, beacon: 45678 }
    }
];

function setup(storage = {}) {
    // linkedom 的 parseFromString 直接返回 Document
    const document = new DOMParser().parseFromString(FORM_HTML, 'text/html');
    globalThis.document = document;
    globalThis.window = { location: { hostname: 'localhost' } };
    const store = new Map(Object.entries(storage));
    globalThis.localStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key)
    };

    const ui = new RobotDeployUI();
    ui.firmwares = FIRMWARES.map((firmware) => ({ ...firmware, ports: { ...firmware.ports } }));
    return { ui, store, document };
}

const portValue = (document, key) => document.getElementById(`robot-deploy-port-${key}`).value;

test('restored ports beat firmware defaults after the firmware list loads', () => {
    const { ui, document } = setup({
        'robot-deploy-ports': JSON.stringify({ control: 18081, status: 18082, camera: 0, beacon: 14567 })
    });
    ui._restore();
    ui._renderFirmwares();

    assert.equal(portValue(document, 'control'), '18081');
    assert.equal(portValue(document, 'status'), '18082');
    assert.equal(portValue(document, 'camera'), '0');
    assert.equal(portValue(document, 'beacon'), '14567');
});

test('firmware defaults still apply when nothing was used before', () => {
    const { ui, document } = setup();
    ui._restore();
    ui._renderFirmwares();
    assert.equal(portValue(document, 'control'), '8081');
    assert.equal(portValue(document, 'beacon'), '45678');
});

test('syncFromDevice uses the live bridge ports and persists them', () => {
    const { ui, document, store } = setup();
    ui._restore();
    ui._renderFirmwares();

    const applied = ui.syncFromDevice({
        wsPort: 19001,
        statusPort: 19002,
        cameraPort: 0,
        beaconPort: 19003
    });

    assert.equal(applied, true);
    assert.equal(portValue(document, 'control'), '19001');
    assert.equal(portValue(document, 'status'), '19002');
    assert.equal(portValue(document, 'camera'), '0');
    assert.equal(portValue(document, 'beacon'), '19003');
    assert.deepEqual(JSON.parse(store.get('robot-deploy-ports')), {
        control: 19001, status: 19002, camera: 0, beacon: 19003
    });

    // 之后再切固件，也不会把"当前使用的端口"改回固件默认值
    ui._applyFirmwareDefaults();
    assert.equal(portValue(document, 'control'), '19001');
});

test('syncFromDevice ignores devices without a control port', () => {
    const { ui, document } = setup();
    ui._restore();
    assert.equal(ui.syncFromDevice({}), false);
    assert.equal(portValue(document, 'control'), '8081');
});

test('firmware without camera support defaults the camera port to 0', () => {
    const { ui, document } = setup();
    ui._restore();
    ui._firmwarePreferred = 'tienkung-dex-dryrun';
    ui._renderFirmwares();
    assert.equal(document.getElementById('robot-deploy-firmware').value, 'tienkung-dex-dryrun');
    assert.equal(portValue(document, 'camera'), '0');
});

test('firmware type and model share one storage key', () => {
    const { ui, store, document } = setup();
    ui._firmwarePreferred = 'walker-node';
    ui._modelPreferred = 'walker-c1';
    ui._renderFirmwares();
    assert.equal(document.getElementById('robot-deploy-firmware').value, 'walker-node');
    assert.equal(document.getElementById('robot-deploy-model').value, 'walker-c1');

    ui._persist();
    assert.equal(store.get('robot-deploy-selection'), 'walker-node|walker-c1');
    assert.equal(store.has('robot-deploy-firmware'), false, '不再单独写固件 key');
    assert.equal(store.has('robot-deploy-model'), false, '不再单独写机型 key');

    // 重新载入：一个 key 同时恢复固件与机型
    const reloaded = setup(Object.fromEntries(store));
    reloaded.ui._restore();
    reloaded.ui._renderFirmwares();
    assert.equal(reloaded.document.getElementById('robot-deploy-firmware').value, 'walker-node');
    assert.equal(reloaded.document.getElementById('robot-deploy-model').value, 'walker-c1');
});

test('legacy firmware/model keys still restore the selection', () => {
    const { ui, document } = setup({
        'robot-deploy-firmware': 'walker-node',
        'robot-deploy-model': 'walker-c1'
    });
    ui._restore();
    ui._renderFirmwares();
    assert.equal(document.getElementById('robot-deploy-firmware').value, 'walker-node');
    assert.equal(document.getElementById('robot-deploy-model').value, 'walker-c1');
});
