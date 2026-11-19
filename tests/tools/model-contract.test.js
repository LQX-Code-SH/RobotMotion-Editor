import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODELS_DIR = join(ROOT, 'bridge', 'dex', 'models');
const ROBOT_DIR = join(ROOT, 'robot');
const EXPECTED_MODELS = [
    'walker-c1',
    'walker-s2',
    'walker-tienkung-dex',
    'walker-tienkung-pro',
];

function discoverModelDirs() {
    return readdirSync(MODELS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && entry.name !== 'common')
        .map(entry => {
            const metaPath = join(MODELS_DIR, entry.name, 'model.json');
            if (!existsSync(metaPath)) return null;
            return { dir: entry.name, meta: JSON.parse(readFileSync(metaPath, 'utf-8')) };
        })
        .filter(Boolean);
}

test('四款机型均声明 model.json 且 ID 唯一', () => {
    const found = discoverModelDirs();
    const ids = found.map(item => item.meta.id);

    assert.deepEqual(ids.slice().sort(), EXPECTED_MODELS);
    assert.equal(new Set(ids).size, ids.length, '机型 ID 不能重复');
});

test('每个机型后端目录具备包结构与关节映射', () => {
    for (const { dir, meta } of discoverModelDirs()) {
        const modelDir = join(MODELS_DIR, dir);
        for (const file of ['__init__.py', 'backend.py', 'joint_map.py']) {
            assert.ok(existsSync(join(modelDir, file)), `${dir} 缺少 ${file}`);
        }
        assert.equal(meta.backend, `models.${dir}.backend`);
        assert.equal(meta.jointMap, `models.${dir}.joint_map`);
    }
});

test('机型 ID 与 robot/<id>/profile.json 一致且变体为声明式', () => {
    for (const { meta } of discoverModelDirs()) {
        const profilePath = join(ROBOT_DIR, meta.id, 'profile.json');
        assert.ok(existsSync(profilePath), `${meta.id} 缺少 profile.json`);

        const profile = JSON.parse(readFileSync(profilePath, 'utf-8'));
        assert.equal(profile.model, meta.id);
        assert.ok(Array.isArray(profile.assets?.variants) && profile.assets.variants.length > 0,
            `${meta.id} 缺少 variants`);

        for (const variant of profile.assets.variants) {
            assert.equal(typeof variant, 'object', `${meta.id} 仍在使用字符串变体`);
            assert.ok(variant.path && variant.endEffector, `${meta.id} 变体声明不完整`);
            assert.ok(Array.isArray(variant.endEffectorTypes), `${meta.id} 变体缺少 endEffectorTypes`);
        }
    }
});

test('新机型模板目录已预留', () => {
    assert.ok(existsSync(join(MODELS_DIR, '_template', 'model.json')));
    assert.ok(existsSync(join(MODELS_DIR, '_template', 'backend.py')));
    assert.ok(existsSync(join(MODELS_DIR, '_template', 'joint_map.py')));
    assert.ok(existsSync(join(ROBOT_DIR, '_template', 'profile.json')));
    assert.ok(existsSync(join(ROBOT_DIR, '_template', 'model', '.gitkeep')));
    for (const id of EXPECTED_MODELS) {
        assert.ok(existsSync(join(ROOT, 'tests', 'fixtures', 'models', id, '.gitkeep')),
            `${id} 测试夹具目录缺失`);
    }
});
