import test from 'node:test';
import assert from 'node:assert/strict';
import {
    findJointAxisName,
    isVisualizationObject,
    resolveJointAxisLink
} from '../../src/utils/JointDragControls.js';

const node = (extra = {}) => ({ userData: {}, parent: null, ...extra });

test('isVisualizationObject ignores robot geometry', () => {
    const link = node({ name: 'L_shoulder_link' });
    const mesh = node({ isMesh: true, parent: link });
    assert.equal(isVisualizationObject(mesh), false);
});

test('isVisualizationObject detects helpers and their children', () => {
    // 关节轴：group 上标记 isVisualization，箭头 mesh 是其子节点
    const axisGroup = node({ userData: { isVisualization: true } });
    const arrowMesh = node({ isMesh: true, parent: axisGroup });
    assert.equal(isVisualizationObject(axisGroup), true);
    assert.equal(isVisualizationObject(arrowMesh), true);

    // link 坐标轴同理
    const linkAxes = node({ userData: { isVisualization: true } });
    const axisChild = node({ isMesh: true, parent: linkAxes });
    assert.equal(isVisualizationObject(axisChild), true);

    // 多层嵌套
    const link = node({ name: 'base_link' });
    const axesGroup = node({ userData: { isVisualization: true }, parent: link });
    const deep = node({ isMesh: true, parent: node({ parent: axesGroup }) });
    assert.equal(isVisualizationObject(deep), true);
});

test('resolveJointAxisLink maps a joint axis arrow to its child link', () => {
    const childLink = node({ name: 'L_shoulder_pitch_link', isURDFLink: true });
    const jointObject = node({ name: 'L_shoulder_pitch_joint', isURDFJoint: true, children: [childLink] });
    childLink.parent = jointObject;

    const model = {
        joints: new Map([['L_shoulder_pitch_joint', {
            name: 'L_shoulder_pitch_joint',
            type: 'revolute',
            threeObject: jointObject
        }]]),
        links: new Map([['L_shoulder_pitch_link', { name: 'L_shoulder_pitch_link' }]])
    };

    const axisGroup = node({ userData: { isVisualization: true, jointAxisName: 'L_shoulder_pitch_joint' } });
    const arrowMesh = node({ isMesh: true, parent: axisGroup });

    assert.equal(findJointAxisName(arrowMesh), 'L_shoulder_pitch_joint');
    const resolved = resolveJointAxisLink(arrowMesh, model);
    assert.equal(resolved.name, 'L_shoulder_pitch_link');
    assert.equal(resolved.threeObject, childLink);
    assert.equal(resolved.linkData.name, 'L_shoulder_pitch_link');

    // 普通网格 / 非关节轴辅助对象不映射
    assert.equal(resolveJointAxisLink(node({ isMesh: true }), model), null);
    assert.equal(findJointAxisName(node({ isMesh: true })), null);
});
