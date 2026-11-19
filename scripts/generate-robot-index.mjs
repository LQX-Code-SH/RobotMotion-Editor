#!/usr/bin/env node
/**
 * 扫描 robot/<机型>/ 目录下的机型档案与 URDF 变体，生成 robot/index.json。
 * 网页端"机型预览"下拉列表读取该索引切换模型。
 *
 * 变体必须在 profile.assets.variants 中声明：
 *   { path, endEffector, endEffectorTypes?, default? }
 * 字符串变体作为旧格式兼容：末端类型从 endEffectors[*].urdf 或
 * noEndEffectorUrdfs 推导，不再按机型名硬编码。
 *
 * 用法：
 *   node scripts/generate-robot-index.mjs             # 生成
 *   node scripts/generate-robot-index.mjs --check     # 仅校验是否已同步
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROBOT_DIR = join(ROOT, 'robot');
const INDEX_PATH = join(ROBOT_DIR, 'index.json');
const CHECK_ONLY = process.argv.includes('--check');

/** 从 profile 声明中推导旧字符串变体的末端类型（无机型硬编码） */
function endEffectorFromProfile(profile, path) {
    const entries = Object.entries(profile.assets?.endEffectors || {});
    const fileName = path.split('/').pop();

    for (const [type, def] of entries) {
        if (def?.urdf === path) return type;
        if (typeof def?.urdf === 'string' && def.urdf.split('/').pop() === fileName) return type;
    }

    if ((profile.assets?.noEndEffectorUrdfs || []).includes(path)) return 'none';
    return null;
}

/**
 * 解析一个变体条目，返回 { path, endEffector, endEffectorTypes, default } 或 null。
 */
function resolveVariant(profile, variant) {
    const profileTypes = Object.keys(profile.assets?.endEffectors || {});

    if (variant && typeof variant === 'object') {
        const path = variant.path;
        const endEffector = variant.endEffector;
        if (!path || !endEffector) return null;
        return {
            path,
            endEffector,
            endEffectorTypes: Array.isArray(variant.endEffectorTypes)
                ? variant.endEffectorTypes
                : profileTypes,
            default: variant.default === true,
        };
    }

    if (typeof variant !== 'string') return null;
    const endEffector = endEffectorFromProfile(profile, variant);
    if (!endEffector) return null;
    return {
        path: variant,
        endEffector,
        endEffectorTypes: profileTypes,
        default: variant === profile.assets?.urdf,
    };
}

const robots = [];

for (const entry of readdirSync(ROBOT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const model = entry.name;
    const profilePath = join(ROBOT_DIR, model, 'profile.json');
    if (!existsSync(profilePath)) continue;

    const profile = JSON.parse(readFileSync(profilePath, 'utf-8'));
    const variants = profile.assets?.variants?.length
        ? profile.assets.variants
        : (profile.assets?.urdf ? [profile.assets.urdf] : []);

    for (const variant of variants) {
        const resolved = resolveVariant(profile, variant);
        if (!resolved) continue;

        robots.push({
            id: `${model}-${resolved.endEffector}`,
            label: `${model}-${resolved.endEffector}`,
            model,
            displayName: profile.displayName || model,
            endEffector: resolved.endEffector,
            urdf: `robot/${model}/${resolved.path}`,
            default: resolved.default || resolved.path === profile.assets?.urdf,
            endEffectorTypes: resolved.endEffectorTypes,
        });
    }
}

robots.sort((a, b) => (a.model === b.model
    ? a.endEffector.localeCompare(b.endEffector)
    : a.model.localeCompare(b.model)));

const index = {
    version: 1,
    generatedBy: 'scripts/generate-robot-index.mjs',
    robots,
};

const output = JSON.stringify(index, null, 2) + '\n';

if (CHECK_ONLY) {
    const current = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, 'utf-8') : '';
    if (current !== output) {
        console.error('robot/index.json 与 robot/*/profile.json 不一致，请执行 pnpm run robot:index');
        process.exitCode = 1;
    } else {
        console.log(`robot/index.json 检查通过：${robots.length} 个机型变体`);
    }
} else {
    writeFileSync(INDEX_PATH, output);
    console.log(`robot/index.json 已生成：${robots.length} 个机型变体`);
    robots.forEach(r => console.log(`  ${r.default ? '*' : ' '} ${r.id}`));
}
