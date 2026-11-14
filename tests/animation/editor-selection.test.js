import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection } from '../../src/animation/core/EditorSelection.js';
import { AnimationStore } from '../../src/animation/core/AnimationStore.js';

test('repeated joint previews preserve track selection without notifying canvases again', () => {
    const selection = new EditorSelection();
    let updates = 0;
    selection.subscribe(() => updates++);
    selection.selectTrack('drive');
    for (let i = 0; i < 50; i++) selection.selectTrack('drive');
    assert.equal(updates, 1);
    selection.selectKeyframe({ trackId: 'drive', keyframeId: 'key' });
    selection.selectTrack('drive');
    assert.equal(selection.keyframes.size, 0);
    assert.equal(updates, 3);
    selection.selectTrack('drive', { toggle: true });
    assert.equal(selection.trackIds.size, 0);
    selection.selectTrack('other', { additive: true });
    selection.selectTrack('drive', { additive: true });
    selection.selectTrack('drive');
    assert.deepEqual([...selection.trackIds], ['drive']);
});

test('keyframesAt collects every keyframe on the same time column', () => {
    const store = new AnimationStore();
    store.activeClip.tracks = [
        { id: 'a', type: 'joint', jointName: 'j1', keyframes: [{ id: 'k1', timeMs: 1000 }, { id: 'k2', timeMs: 2000 }] },
        { id: 'b', type: 'joint', jointName: 'j2', keyframes: [{ id: 'k3', timeMs: 1000 }] },
        { id: 'c', type: 'event', keyframes: [{ id: 'k4', timeMs: 1000.4 }] }
    ];

    assert.deepEqual(store.keyframesAt(1000), [
        { trackId: 'a', keyframeId: 'k1' },
        { trackId: 'b', keyframeId: 'k3' },
        { trackId: 'c', keyframeId: 'k4' }
    ]);
});
