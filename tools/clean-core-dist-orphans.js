#!/usr/bin/env node
/**
 * 清理 core/dist 里的「孤儿产物」。
 *
 * tsc 只负责写文件，不会删除产物：源文件删了、改名了、挪了目录之后，
 * dist 里对应的 .js / .d.ts / .map / .json 会一直留着，进而被打进发布包
 * （曾经把已删除的 autumn-activities-auto.js、pet-diary-auto.js 带进宝塔源码包）。
 *
 * 判定规则：对 dist 里的每个产物反推它应该来自哪个源文件，源文件不存在即视为孤儿。
 *   dist/<rel>/X.js       <- src/<rel>/X.ts | X.tsx | X.js
 *   dist/<rel>/X.d.ts     <- src/<rel>/X.ts | X.tsx
 *   dist/<rel>/X.js.map   <- 同 X.js
 *   dist/<rel>/X.d.ts.map <- 同 X.d.ts
 *   dist/<rel>/X.json     <- src/<rel>/X.json   (resolveJsonModule 会把被引用的 json 复制到 outDir)
 * 另外 tsconfig.client.json 的 rootDir/outDir 都是 "."，产物落在 core 根目录：
 *   client.js <- client.ts，capture-server.js <- capture-server.ts
 *
 * 用法:
 *   node tools/clean-core-dist-orphans.js [--dry-run] [--quiet]
 *
 * 退出码恒为 0（没有孤儿也是正常情况）；只删除 core/dist 内的文件与随之变空的目录。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CORE_DIR = path.resolve(__dirname, '..', 'core');
const SRC_DIR = path.join(CORE_DIR, 'src');
const DIST_DIR = path.join(CORE_DIR, 'dist');

/** core 根目录下由 tsconfig.client.json 生成、不在 dist 里的产物。 */
const ROOT_OUTPUTS = [
    { output: 'client.js', source: 'client.ts' },
    { output: 'capture-server.js', source: 'capture-server.ts' },
];

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const QUIET = args.has('--quiet');

/** 产物后缀 -> 依次尝试的源文件后缀（按优先级）。 */
const SOURCE_SUFFIXES = [
    ['.d.ts.map', ['.ts', '.tsx']],
    ['.d.ts', ['.ts', '.tsx']],
    ['.js.map', ['.ts', '.tsx', '.js']],
    ['.js', ['.ts', '.tsx', '.js']],
    ['.json', ['.json']],
];

function toSourceCandidates(relative) {
    for (const [outputSuffix, sourceSuffixes] of SOURCE_SUFFIXES) {
        if (!relative.endsWith(outputSuffix)) continue;
        const stem = relative.slice(0, -outputSuffix.length);
        return sourceSuffixes.map(suffix => path.join(SRC_DIR, stem + suffix));
    }
    return null;
}

function walk(dir, prefix = '') {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix ? path.join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relative));
        else if (entry.isFile()) out.push(relative);
    }
    return out;
}

/** 自底向上删掉 dist 里的空目录，避免删除产物后留下空壳。 */
function pruneEmptyDirs(dir) {
    let removed = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = path.join(dir, entry.name);
        removed += pruneEmptyDirs(child);
        if (fs.readdirSync(child).length === 0) {
            fs.rmdirSync(child);
            removed += 1;
        }
    }
    return removed;
}

function main() {
    if (!fs.existsSync(SRC_DIR) || !fs.existsSync(DIST_DIR)) {
        console.error(`[clean-dist] 跳过：找不到 ${SRC_DIR} 或 ${DIST_DIR}`);
        return;
    }

    const orphans = [];
    for (const relative of walk(DIST_DIR)) {
        const candidates = toSourceCandidates(relative);
        if (!candidates) continue;
        if (candidates.some(candidate => fs.existsSync(candidate))) continue;
        orphans.push({ target: path.join(DIST_DIR, relative), relative });
    }

    for (const { output, source } of ROOT_OUTPUTS) {
        const target = path.join(CORE_DIR, output);
        if (!fs.existsSync(target)) continue;
        if (fs.existsSync(path.join(CORE_DIR, source))) continue;
        orphans.push({ target, relative: output });
    }

    if (!QUIET) {
        for (const { relative } of orphans) {
            console.log(`[clean-dist] ${DRY_RUN ? '将删除' : '删除'} core/dist 孤儿产物: ${relative}`);
        }
    }

    if (!DRY_RUN) {
        for (const { target } of orphans) fs.rmSync(target, { force: true });
        const dirs = pruneEmptyDirs(DIST_DIR);
        if (!QUIET && dirs > 0) console.log(`[clean-dist] 顺带清理空目录 ${dirs} 个`);
    }

    if (!QUIET) {
        console.log(orphans.length === 0
            ? '[clean-dist] 无孤儿产物'
            : `[clean-dist] 共 ${orphans.length} 个孤儿产物${DRY_RUN ? '（dry-run，未删除）' : '已清理'}`);
    }
}

main();
