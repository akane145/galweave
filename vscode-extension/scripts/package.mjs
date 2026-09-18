#!/usr/bin/env node
// package.mjs — 把扩展打成自包含的可发布目录，再交给 vsce 出 VSIX
//
// 为什么要这一步：识别逻辑在扩展目录之外（`../../src/parsers.js` 等），
// 而 VSIX **无法包含包外文件** —— 直接打包会得到一个运行时加载失败的扩展。
//
// 做法不是上打包器，而是把用得到的那几个纯逻辑文件**拷进来并改写导入路径**：
// 依赖闭包很小（parsers → universal-parser；exporter → parsers/csv；qa → parsers），
// 一共 5 个文件，全部无 DOM、无 Node 内置依赖。
//
// 路径改写规则只有一条：`'../../src/` → `'../shared/`。
// 因为 dist/src/*.js 与 dist/vscode/*.cjs 都在 dist 下一层，
// `../shared/x.js` 对两者都解析到 dist/shared/x.js。
//
// 用法：
//   node scripts/package.mjs            # 只产出 dist/
//   node scripts/package.mjs --out <dir>  # 指定输出目录（测试用）
//   node scripts/package.mjs --vsix     # 再调用 npx @vscode/vsce package

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..');
const REPO_SRC = path.resolve(EXT_DIR, '../src');
// 输出目录可用 --out 覆盖 —— 测试会指到临时目录，
// 免得"跑一次测试就把正式产物 dist/ 清空"。
const outArg = process.argv.indexOf('--out');
const DIST = outArg >= 0 && process.argv[outArg + 1]
  ? path.resolve(process.argv[outArg + 1])
  : path.join(EXT_DIR, 'dist');

/**
 * 需要内联的共享纯逻辑的**入口**。
 * 其余依赖由 collectShared() 自动走依赖图收集 —— 手工维护清单迟早会漏
 * （第一版就漏了 universal-parser.js → recognize.js 这条边，打包产物一激活就 ERR_MODULE_NOT_FOUND）。
 */
const SHARED_ENTRIES = ['parsers.js', 'exporter.js', 'qa.js'];

/**
 * 需要随包分发的运行时依赖（走 npm 依赖闭包，自动收集传递依赖）。
 * js-mdict 用来读 .mdx；它只依赖 commander 与 levenshtein-edit-distance，约 1MB。
 */
const NODE_DEPS_ENTRIES = ['js-mdict'];

/**
 * 走 npm 依赖闭包，收集要一起拷进包里的 node_modules 包。
 * 与共享纯逻辑同理：手工列清单迟早漏传递依赖。
 */
function collectNodeDeps(entries) {
  const rootModules = path.resolve(EXT_DIR, '../node_modules');
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    const dir = path.join(rootModules, name);
    if (!fs.existsSync(dir)) continue;
    seen.add(name);
    let pj = {};
    try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { continue; }
    for (const dep of Object.keys(pj.dependencies || {})) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen].sort();
}

/** 递归拷贝目录（跳过嵌套 node_modules 之外的无关内容） */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * 从入口出发走一遍相对导入，收集闭包内的全部文件。
 * 只跟进能解析到 REPO_SRC 内部的相对导入；`node:` 之类一律忽略。
 */
function collectShared(entries) {
  const seen = new Set();
  const queue = [...entries];
  const relImports = (text) => {
    const out = [];
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) out.push(m[1]);
    return out;
  };
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    const file = path.join(REPO_SRC, name);
    if (!fs.existsSync(file)) throw new Error(`共享模块不存在：${file}`);
    seen.add(name);
    for (const spec of relImports(fs.readFileSync(file, 'utf8'))) {
      const dep = path.basename(spec);
      const depFile = path.resolve(path.dirname(file), spec);
      if (!depFile.startsWith(REPO_SRC)) continue;
      if (!fs.existsSync(depFile)) continue;
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen].sort();
}

/**
 * 扩展自己的纯逻辑模块（src/*.js）与 vscode 层（vscode/*.cjs）。
 * **扫目录，不写清单**：新增一个模块却忘了加进清单，dist 里就会缺文件，
 * 而这只有装上去真跑一次才会炸（v0.6.0 的 encoding.js / encoding.cjs 就是这么漏的）。
 * 与 collectShared() 的"手工清单迟早会漏"是同一条教训。
 */
const listDir = (dir, re) => fs.readdirSync(path.join(EXT_DIR, dir)).filter((f) => re.test(f)).sort();
const OWN_SRC = listDir('src', /\.js$/);
const VSCODE_LAYER = listDir('vscode', /\.cjs$/);

const IMPORT_REWRITE = /(['"])\.\.\/\.\.\/src\//g;

function log(msg) { console.log(msg); }

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

/** 读文件并改写包外导入路径 */
function readRewritten(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.replace(IMPORT_REWRITE, '$1../shared/');
}

/** 校验：改写后不该再有任何指向包外的相对路径 */
function assertNoOutsideRefs(file, text) {
  const bad = [];
  for (const m of text.matchAll(/(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.') && !spec.startsWith('node:')) {
      const abs = path.resolve(path.dirname(file), spec);
      if (!abs.startsWith(DIST)) bad.push(spec);
    }
  }
  if (bad.length) throw new Error(`${path.relative(EXT_DIR, file)} 仍有指向包外的导入：${bad.join(', ')}`);
}

function copyInto(destDir, name, content) {
  const dest = path.join(destDir, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  assertNoOutsideRefs(dest, content);
  return dest;
}

function main() {
  log('打包 Galweave for VS Code\n');
  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  // ① 共享纯逻辑：原样拷入（它们之间的 ./x.js 相对导入保持不变）
  const shared = collectShared(SHARED_ENTRIES);
  for (const f of shared) {
    copyInto(path.join(DIST, 'shared'), f, fs.readFileSync(path.join(REPO_SRC, f), 'utf8'));
  }
  log(`  共享纯逻辑  ${shared.length} 个 → dist/shared/`);
  log(`              ${shared.join(' ')}`);

  let n = 0;

  // ② 扩展自己的纯逻辑：改写 ../../src/ → ../shared/
  n = 0;
  for (const f of OWN_SRC) {
    copyInto(path.join(DIST, 'src'), f, readRewritten(path.join(EXT_DIR, 'src', f)));
    n++;
  }
  log(`  扩展纯逻辑  ${n} 个 → dist/src/`);

  // ③ vscode 层：同样改写（它 import 共享模块用的是 ../../src/）
  n = 0;
  for (const f of VSCODE_LAYER) {
    copyInto(path.join(DIST, 'vscode'), f, readRewritten(path.join(EXT_DIR, 'vscode', f)));
    n++;
  }
  log(`  vscode 层   ${n} 个 → dist/vscode/`);

  // ④ 入口（只 require ./vscode/*.cjs，无需改写）
  copyInto(DIST, 'extension.cjs', readRewritten(path.join(EXT_DIR, 'extension.cjs')));
  log('  入口        extension.cjs');

  // ⑤ 运行时资源：规则库是从 extensionUri/rules 读的
  const rulesSrc = path.join(EXT_DIR, 'rules');
  const rulesDest = path.join(DIST, 'rules');
  fs.mkdirSync(rulesDest, { recursive: true });
  const ruleFiles = fs.readdirSync(rulesSrc).filter(f => f.endsWith('.json'));
  for (const f of ruleFiles) fs.copyFileSync(path.join(rulesSrc, f), path.join(rulesDest, f));
  log(`  规则库      ${ruleFiles.length} 个 → dist/rules/`);

  // ⑥ 运行时依赖（js-mdict 及其传递依赖）
  const rootModules = path.resolve(EXT_DIR, '../node_modules');
  const deps = collectNodeDeps(NODE_DEPS_ENTRIES);
  let depBytes = 0;
  for (const name of deps) {
    const src = path.join(rootModules, name);
    copyDir(src, path.join(DIST, 'node_modules', name));
  }
  log(`  运行时依赖  ${deps.length} 个 → dist/node_modules/   ${deps.join(' ')}`);
  void depBytes;

  // ⑦ 清单与说明
  fs.copyFileSync(path.join(EXT_DIR, 'package.json'), path.join(DIST, 'package.json'));
  fs.copyFileSync(path.join(EXT_DIR, 'README.md'), path.join(DIST, 'README.md'));

  // ⑧ 打包排除项。
  // 注意：**不能**排除 node_modules —— js-mdict 必须随包分发，否则装上去词典直接失效。
  // package.test.mjs 会把这里的规则套到文件清单上核对，漏了会被测出来。
  fs.writeFileSync(path.join(DIST, '.vscodeignore'), [
    '.vscode/**',
    '**/*.map',
    '**/test/**',
    '',
  ].join('\n'));

  log('\ndist/ 已就绪。');

  if (process.argv.includes('--vsix')) {
    log('\n调用 vsce 生成 VSIX…');
    const r = spawnSync('npx', ['--yes', '@vscode/vsce', 'package'], { cwd: DIST, stdio: 'inherit', shell: true });
    if (r.status !== 0) {
      console.error('vsce 失败。可先 `npm i -g @vscode/vsce` 再重试。');
      process.exit(r.status || 1);
    }
  } else {
    log('生成 VSIX：node scripts/package.mjs --vsix（需要 npx 能拉到 @vscode/vsce）');
  }
}

main();
