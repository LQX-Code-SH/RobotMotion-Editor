import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinateAxesManager } from '../../src/features/viewport/renderer/CoordinateAxesManager.js';

function createManager(names) {
    const manager = Object.create(CoordinateAxesManager.prototype);
    manager.linkAxesHelpers = new Map();
    manager.jointAxesHelpers = new Map();
    manager.showAxesEnabled = false;
    manager.showJointAxesEnabled = false;
    manager.jointAxisSelection = new Set();
    manager.jointAxisSelectionReady = false;

    for (const name of names) {
        const parent = {
            children: new Set(),
            add(mesh) { this.children.add(mesh); },
            remove(mesh) { this.children.delete(mesh); }
        };
        manager.jointAxesHelpers.set(name, {
            mesh: { name: `axis_${name}` },
            parent,
            joint: { name },
            isAttached: false
        });
    }
    return manager;
}

test('joint axis selection defaults to all and toggles individually', () => {
    const manager = createManager(['a', 'b', 'c']);

    // 未做选择前默认全选
    assert.equal(manager.isJointAxisSelected('a'), true);

    manager.showAllJointAxes();
    assert.equal(manager.jointAxesHelpers.get('a').isAttached, true);
    assert.equal(manager.jointAxesHelpers.get('b').isAttached, true);

    manager.setJointAxisVisible('b', false);
    assert.equal(manager.jointAxesHelpers.get('a').isAttached, true);
    assert.equal(manager.jointAxesHelpers.get('b').isAttached, false);
    assert.equal(manager.showJointAxesEnabled, true);

    manager.hideAllJointAxes();
    assert.equal(manager.jointAxesHelpers.get('a').isAttached, false);
    assert.equal(manager.showJointAxesEnabled, false);
    // 关闭总开关不清空勾选
    assert.equal(manager.isJointAxisSelected('a'), true);

    // 主按钮重新打开时按上次勾选恢复，而不是无脑全显
    manager.showSelectedJointAxes();
    assert.equal(manager.jointAxesHelpers.get('a').isAttached, true);
    assert.equal(manager.jointAxesHelpers.get('b').isAttached, false);
    manager.hideAllJointAxes();

    manager.setAllJointAxesVisible(false);
    assert.equal(manager.showJointAxesEnabled, false);
    assert.equal(manager.getSelectedJointAxisNames().length, 0);

    manager.setJointAxisVisible('c', true);
    assert.equal(manager.showJointAxesEnabled, true);
    assert.equal(manager.jointAxesHelpers.get('c').isAttached, true);
    assert.equal(manager.jointAxesHelpers.get('a').isAttached, false);
});

test('newly created joint axes follow the current selection', () => {
    const manager = createManager([]);
    manager.setAllJointAxesVisible(false);
    manager.setJointAxisVisible('hip_pitch_l_joint', true);
    assert.deepEqual(manager.getJointAxisNames(), []);
    assert.equal(manager.showJointAxesEnabled, true);
});

function createLinkManager(names) {
    const manager = Object.create(CoordinateAxesManager.prototype);
    manager.linkAxesHelpers = new Map();
    manager.jointAxesHelpers = new Map();
    manager.showAxesEnabled = false;
    manager.showJointAxesEnabled = false;
    manager.linkAxisSelection = new Set();
    manager.linkAxisSelectionReady = false;
    manager.jointAxisSelection = new Set();
    manager.jointAxisSelectionReady = false;

    for (const name of names) manager.linkAxesHelpers.set(name, { visible: false, name });
    return manager;
}

test('link coordinate axes support per-link selection', () => {
    const manager = createLinkManager(['base_link', 'arm_link']);

    manager.showAllAxes();
    assert.equal(manager.linkAxesHelpers.get('base_link').visible, true);
    assert.equal(manager.linkAxesHelpers.get('arm_link').visible, true);

    manager.setLinkAxesVisible('arm_link', false);
    assert.equal(manager.linkAxesHelpers.get('base_link').visible, true);
    assert.equal(manager.linkAxesHelpers.get('arm_link').visible, false);
    assert.equal(manager.showAxesEnabled, true);

    manager.hideAllAxes();
    assert.equal(manager.linkAxesHelpers.get('base_link').visible, false);
    assert.equal(manager.showAxesEnabled, false);
    // 关闭总开关保留勾选
    assert.equal(manager.isLinkAxesSelected('base_link'), true);
    assert.equal(manager.isLinkAxesSelected('arm_link'), false);

    manager.showSelectedLinkAxes();
    assert.equal(manager.linkAxesHelpers.get('base_link').visible, true);
    assert.equal(manager.linkAxesHelpers.get('arm_link').visible, false);
    manager.hideAllAxes();

    manager.setAllLinkAxesVisible(true);
    assert.equal(manager.linkAxesHelpers.get('arm_link').visible, true);
    assert.deepEqual(manager.getSelectedLinkAxesNames(), ['base_link', 'arm_link']);
});
