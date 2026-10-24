// clean-dist.mjs — 构建前清空输出目录
//
// 为什么需要这个脚本：vite.config.js 刻意设了 `emptyOutDir: false`（原因见那里的注释：
// WorkBuddy 环境给 node 的 rmSync 套了 safe-delete shim，删除计数超过阈值会要求交互确认，
// 在 tauri 的非交互子进程里直接抛错），并按注释把清空交给"构建前的 shell `rm -rf dist`"。
// 但那条 shell 从来没有真正存在过 —— 于是每次构建都把上一版带哈希的资源留在 dist 里，
// **越积越多并被原样打进安装包**（实测一次：dist/assets 下积了 72 个文件，其中 17 个是
// 历次构建的 index-*.js，安装包因此虚增约 600KB）。
//
// 为什么不用 `rm -rf`：npm 在 Windows 上通过 cmd.exe 跑脚本，没有 rm。
// 为什么失败也继续：清空只是优化（避免打入陈旧资源），不该因为删不掉就**阻断打包**。
// 但必须**明确告警**，否则又会退化成"悄悄积累"——那正是这个脚本要修的问题。

import { rmSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const targets = process.argv.slice(2).filter(a => !a.startsWith('-'));
const dirs = targets.length ? targets : ['dist'];

/** 数一下目录里的文件，用于告警时说清"还剩多少" */
function countFiles(dir){
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })){
      n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
    }
  } catch (e) { /* 读不到就当 0 */ }
  return n;
}

let failed = [];
for (const rel of dirs){
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;
  try {
    rmSync(abs, { recursive: true, force: true });
    if (existsSync(abs)) failed.push({ rel, left: countFiles(abs) });
  } catch (e){
    failed.push({ rel, left: countFiles(abs), err: e.message });
  }
}

if (failed.length){
  // 不 exit(1)：打包应当继续；但把后果写清楚，用户才知道安装包里可能有陈旧文件
  console.warn('[clean-dist] ⚠ 未能清空以下输出目录，本次构建可能把陈旧资源一并打包：');
  for (const f of failed){
    console.warn('  - ' + f.rel + '（仍有 ' + f.left + ' 个文件）' + (f.err ? '：' + f.err : ''));
  }
  console.warn('  处理方式：手动删除该目录后重新构建。');
} else {
  console.log('[clean-dist] 已清空：' + dirs.join('、'));
}
