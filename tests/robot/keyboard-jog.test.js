import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isJogKey,
    normalizeJogKey,
    summarizeJog
} from '../../src/utils/endEffectorJog.js';

const zero = () => ({ x: 0, y: 0, z: 0 });

test('translation keys map to base-frame axes', () => {
    assert.deepEqual(summarizeJog(['w']).translation, { x: 1, y: 0, z: 0 });
    assert.deepEqual(summarizeJog(['s']).translation, { x: -1, y: 0, z: 0 });
    assert.deepEqual(summarizeJog(['a']).translation, { x: 0, y: 1, z: 0 });
    assert.deepEqual(summarizeJog(['d']).translation, { x: 0, y: -1, z: 0 });
    assert.deepEqual(summarizeJog(['q']).translation, { x: 0, y: 0, z: 1 });
    assert.deepEqual(summarizeJog(['e']).translation, { x: 0, y: 0, z: -1 });
});

test('rotation keys map to roll/pitch/yaw signs', () => {
    assert.deepEqual(summarizeJog(['1']).rotation, { roll: 1, pitch: 0, yaw: 0 });
    assert.deepEqual(summarizeJog(['2']).rotation, { roll: -1, pitch: 0, yaw: 0 });
    assert.deepEqual(summarizeJog(['3']).rotation, { roll: 0, pitch: 1, yaw: 0 });
    assert.deepEqual(summarizeJog(['4']).rotation, { roll: 0, pitch: -1, yaw: 0 });
    assert.deepEqual(summarizeJog(['5']).rotation, { roll: 0, pitch: 0, yaw: 1 });
    assert.deepEqual(summarizeJog(['6']).rotation, { roll: 0, pitch: 0, yaw: -1 });
});

test('opposite keys cancel and diagonals stay unit-scaled', () => {
    assert.deepEqual(summarizeJog(['w', 's']).translation, zero());
    assert.deepEqual(summarizeJog(['w', 'w']).translation, { x: 1, y: 0, z: 0 });
    const diagonal = summarizeJog(['w', 'a']).translation;
    assert.deepEqual(diagonal, { x: 1, y: 1, z: 0 });
});

test('uppercase keys, unknown keys and empty input are handled', () => {
    assert.equal(normalizeJogKey('W'), 'w');
    assert.deepEqual(summarizeJog(['W', 'A']).translation, { x: 1, y: 1, z: 0 });
    assert.equal(summarizeJog([]).active, false);
    assert.equal(summarizeJog(['z', '7']).active, false);
    assert.equal(isJogKey('q'), true);
    assert.equal(isJogKey('7'), false);
    assert.equal(isJogKey('Tab'), false);
});
