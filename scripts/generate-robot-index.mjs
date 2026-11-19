#!/usr/bin/env node
/**
 * 扫描 robot/<机型>/ 目录下的机型档案与 URDF 变体，生成 robot/index.json。
 * 网页端"机型预览"下拉列表读取该索引切换模型。
 *
 * 变体标识规则："机器人型号-末端执行器"，例如 walker-tienkung-dex-inspire
 *
 * 用法：node scripts/generate-robot-index.mjs（或 pnpm run robot:index）
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROBOT_DIR = join(ROOT, 'robot');

/** 从 URDF 文件名推断末端执行器类型，返回 null 表示不是完整机器人模型（如手部独立 URDF） */
function endEffectorOf(model, fileName) {
    const name = fileName.replace(/\.urdf$/i, '').toLowerCase();

    if (model === 'walker-s2') {
        const match = name.match(/^s2_v1_simple_(.+)$/);
        if (match) return match[1];
        return null;
    }

    if (model === 'walker-c1') {
        if (name.includes('with_hands')) return 'hands';
        if (name === 'walker_c1') return 'none';
        return null;
    }

    if (model === 'walker-tienkung-pro') {
        if (name.includes('with_hands')) return 'hands';
        return null;
    }

    if (model === 'walker-tienkung-dex') {
        const match = name.match(/^tienkung_dex_(.+)$/);
        if (match) return match[1] === 'base' ? 'none' : match[1];
        return null;
    }

    return null;
}

const robots = [];

/**
 * 解析一个变体条目，返回 { path, endEffector } 或 null。
 * 新格式：{ path, endEffector }（末端类型由 profile 显式声明）
 * 旧格式：字符串（回退到 endEffectorOf() 的文件名启发式）
 */
function resolveVariant(model, variant) {
    if (variant && typeof variant === 'object') {
        const path = variant.path;
        const endEffector = variant.endEffector;
        if (!path || !endEffector || endEffector === 'none') return null;
        return { path, endEffector };
    }
    if (typeof variant !== 'string') return null;
    const fileName = variant.split('/').pop();
    const endEffector = endEffectorOf(model, fileName);
    return endEffector ? { path: variant, endEffector } : null;
}

for (const entry of readdirSync(ROBOT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const model = entry.name;
    const profilePath = join(ROBOT_DIR, model, 'profile.json');
    if (!existsSync(profilePath)) continue;

    const profile = JSON.parse(readFileSync(profilePath, 'utf-8'));

    const variants = profile.assets?.variants?.length
        ? profile.assets.variants
        : (profile.assets?.urdf ? [profile.assets.urdf] : []);

    // 该机型支持的末端协议类型清单（welcome.hands.type 的合法值集合）。
    // additive 字段：旧版前端忽略它，不影响现有行为。
    const endEffectorTypes = Object.keys(profile.assets?.endEffectors || {});

    for (const variant of variants) {
        const resolved = resolveVariant(model, variant);
        if (!resolved) continue;

        robots.push({
            id: `${model}-${resolved.endEffector}`,
            label: `${model}-${resolved.endEffector}`,
            model,
            displayName: profile.displayName || model,
            endEffector: resolved.endEffector,
            urdf: `robot/${model}/${resolved.path}`,
            default: resolved.path === profile.assets?.urdf,
            endEffectorTypes
        });
    }
}

robots.sort((a, b) => (a.model === b.model ? a.endEffector.localeCompare(b.endEffector) : a.model.localeCompare(b.model)));

const index = {
    version: 1,
    generatedBy: 'scripts/generate-robot-index.mjs',
    robots
};

writeFileSync(join(ROBOT_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`robot/index.json 已生成：${robots.length} 个机型变体`);
robots.forEach(r => console.log(`  ${r.default ? '*' : ' '} ${r.id}`));
