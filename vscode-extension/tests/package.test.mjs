// package.test.mjs — 打包产物的自包含性验证
//
// 这一步不是形式检查：识别逻辑在扩展目录之外，VSIX 无法包含包外文件，
// 所以打包靠"拷贝 + 改写导入路径"。改写对不对，**只有在 dist 里真的激活一次才能证明**。
// 本文件跑完整打包，然后在 dist 上激活扩展、解析真实样本，并与源码路径的结果比对。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  EXT_DIR, SAMPLE_DIR, fakeDocument, fakeEditor, rangesFor, loadExtension, requireProviders,
  focusLine, selectRange,
} from './helpers/mock-vscode.mjs';

const PACKAGE_SCRIPT = path.join(EXT_DIR, 'scripts', 'package.mjs');

/** 在 JPdict 下找一个真实 .mdx 作基准 */
function findRealMdx() {
  const root = path.resolve(EXT_DIR, '../JPdict');
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase().endsWith('.mdx')) return p;
    }
  }
  return null;
}

// 打包到**临时目录**，不用 dist/ —— 否则跑一次测试就把正式产物（含已生成的 VSIX）清掉。
const DIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'galweave-dist-'));

const r = spawnSync(process.execPath, [PACKAGE_SCRIPT, '--out', DIST_DIR], { cwd: EXT_DIR, encoding: 'utf8' });
assert.equal(r.status, 0, `打包失败：\n${r.stdout}\n${r.stderr}`);

const loadFromDist = (opts) => loadExtension(DIST_DIR, opts);

test('打包：.vscodeignore 不会把运行时需要的文件排除掉', () => {
  // 为什么必须单独测这个：vsce 是**按 .vscodeignore 过滤之后**才出 VSIX 的，
  // 只验 dist/ 目录完整是不够的 —— 曾经这里写着通配的 node_modules 排除规则，
  // dist 看着齐全，VSIX 里却没有 js-mdict，装上去词典功能直接失效。
  const raw = fs.readFileSync(path.join(DIST_DIR, '.vscodeignore'), 'utf8');
  const patterns = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));

  // 按 glob 语义转正则：'**/' 可匹配零个目录（这一条最容易写错，正是漏检的根源）
  const toRe = (p) => {
    const body = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0000')
      .replace(/\*\*/g, '\u0001')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '(?:.*/)?')
      .replace(/\u0001/g, '.*');
    return new RegExp('^' + body + '$');
  };
  const regexes = patterns.map(toRe);
  const isIgnored = (rel) => regexes.some(r => r.test(rel));

  const required = [
    'extension.cjs',
    'package.json',
    'src/lineparse.js',
    'src/dicttext.js',
    'vscode/core.cjs',
    'vscode/dict.cjs',
    'shared/parsers.js',
    'rules/circle-inline-speaker.json',
    'node_modules/js-mdict/package.json',
    'node_modules/levenshtein-edit-distance/package.json',
  ];
  for (const rel of required) {
    assert.ok(fs.existsSync(path.join(DIST_DIR, rel)), `${rel} 应存在于 dist`);
    assert.ok(!isIgnored(rel), `${rel} 被 .vscodeignore 排除了 —— VSIX 里会缺这个文件`);
  }
});

test('打包：产出预期的目录结构', () => {
  for (const rel of [
    'extension.cjs', 'package.json', 'README.md', '.vscodeignore',
    'shared/parsers.js', 'shared/universal-parser.js', 'shared/exporter.js', 'shared/csv.js', 'shared/qa.js',
    'src/lineparse.js', 'src/rules.js', 'src/validate.js', 'src/glossary-file.js', 'src/export-text.js', 'src/nav.js', 'src/dicttext.js',
    'src/encoding.js',
    'vscode/core.cjs', 'vscode/cursor.cjs', 'vscode/decorations.cjs', 'vscode/providers.cjs', 'vscode/commands.cjs', 'vscode/dict.cjs',
    'vscode/encoding.cjs',
    'rules/circle-inline-speaker.json',
    'node_modules/js-mdict/package.json',
  ]) {
    assert.ok(fs.existsSync(path.join(DIST_DIR, rel)), `缺少 ${rel}`);
  }
});

test('打包：src/ 与 vscode/ 的文件一个都不能漏（产物与源码目录一致）', () => {
  // 守的是"新增模块忘了打包"：v0.6.0 加 encoding.js / encoding.cjs 时就漏过，
  // 表现为 dist 里 ERR_MODULE_NOT_FOUND，只有真跑一次才发现。打包脚本已改成扫目录，这里再核一遍产物。
  for (const [dir, re] of [['src', /\.js$/], ['vscode', /\.cjs$/]]) {
    const want = fs.readdirSync(path.join(EXT_DIR, dir)).filter(f => re.test(f)).sort();
    const got = fs.readdirSync(path.join(DIST_DIR, dir)).filter(f => re.test(f)).sort();
    assert.deepEqual(got, want, `${dir}/ 下的文件应与源码一致`);
  }
});

test('打包：dist 里没有任何指向包外的相对导入', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|cjs|mjs)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        const abs = path.resolve(path.dirname(p), spec);
        if (!abs.startsWith(DIST_DIR)) offenders.push(`${path.relative(DIST_DIR, p)} → ${spec}`);
      }
    }
  };
  walk(DIST_DIR);
  assert.deepEqual(offenders, [], `这些导入会指向包外：\n${offenders.join('\n')}`);
});

test('打包：没有导入说明符残留 ../../src/ 形式（只查导入，不查注释）', () => {
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|cjs|mjs)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        if (m[1].includes('../../src/')) bad.push(`${path.relative(DIST_DIR, p)} → ${m[1]}`);
      }
    }
  };
  walk(DIST_DIR);
  assert.deepEqual(bad, [], `这些导入说明符仍指向 ../../src/：\n${bad.join('\n')}`);
});

test('打包产物：扩展能激活并注册全部命令', async () => {
  const { state } = await loadFromDist();
  for (const id of [
    'galweave.inspectDocument', 'galweave.showRules', 'galweave.toggleHighlight',
    'galweave.export', 'galweave.copyOrigToTrans', 'galweave.insertTransLine',
    'galweave.clearTrans', 'galweave.gotoCounterpart',
    'galweave.recordBaseline', 'galweave.clearBaseline',
    'galweave.nextLine', 'galweave.prevLine', 'galweave.blockEdit', 'galweave.toggleLock',
  ]) assert.ok(state.commands.has(id), `打包产物应注册 ${id}`);
  assert.equal(state.statusItems.length, 2, '两个状态栏项都应创建');
  assert.ok(state.providers.hover && state.providers.folding && state.providers.symbols);
});

test('打包产物：逐行导航与原文锁定在 dist 下同样可用', async () => {
  const { state } = await loadFromDist();
  const doc = fakeDocument([
    '☆0001☆藍☆「おはよう」', '★0001★蓝★「早上好」', '',
    '☆0002☆藍☆「おやすみ」', '★0002★蓝★「晚安」', '',
  ].join('\n'), '/ws/nav.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);

  // 上下文键：识别为脚本 + 光标在原文行 + 锁定生效
  assert.equal(state.contextKeys.get('galweave.isScript'), true);
  assert.equal(state.contextKeys.get('galweave.onOrigLine'), true);
  assert.equal(state.contextKeys.get('galweave.locked'), true);

  // Enter / Tab 换行：落到下一段的译文行，且停在收尾括号之前
  await state.commands.get('galweave.nextLine')();
  assert.equal(editor.selection.active.line, 4);
  assert.equal(editor.selection.active.character, doc.lineAt(4).text.length - 1);

  // 原文锁定：blockEdit 不改文档
  const before = doc.getText();
  await state.commands.get('galweave.blockEdit')('x');
  assert.equal(doc.getText(), before);
});

test('打包产物：js-mdict 真的随包分发，dict 下能查到真实词', async (t) => {
  // 这条是"运行时依赖是否真的打进去了"的唯一硬证据：dist 目录里没有 node_modules 的话，
  // import('js-mdict') 会失败，词典功能在装上去之后才会暴露
  const mdx = findRealMdx();
  if (!mdx) { t.skip('JPdict 下没有 .mdx'); return; }

  const { state } = await loadFromDist({ settings: { mdxPaths: [mdx] } });
  const doc = fakeDocument('☆0001☆藍☆「天気」' + String.fromCharCode(10)
    + '★0001★蓝★「天气」' + String.fromCharCode(10), '/ws/dd.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  await selectRange(state, editor, { line: 0, character: 9 }, { line: 0, character: 11 });
  await state.commands.get('galweave.lookupDict')();

  const provider = state.contentProviders.get('galweave-dict');
  assert.ok(provider, 'dist 下应注册词典 provider');
  const text = provider.provideTextDocumentContent();
  assert.match(text, /查询：天気/);
  assert.ok(!/没有精确命中/.test(text), `dist 下应能查到词，实际结果：${text.slice(0, 200)}`);
  t.diagnostic(text.split(String.fromCharCode(10))[0] + ' / ' + text.length + ' 字');
});

test('打包产物：规则库从自己目录下的 rules/ 载入', async () => {
  const { state } = await loadFromDist();
  await state.commands.get('galweave.showRules')();
  const text = state.logs.join('\n');
  assert.match(text, /标准 ☆\/★/);
  assert.match(text, /circle-inline-speaker/, '自带规则应随包分发并被载入');
});

test('打包产物：识别真实样本的结果与源码路径一致', async (t) => {
  const src = path.join(SAMPLE_DIR, '新建 文本文档 (2).txt');
  if (!fs.existsSync(src)) { t.skip(`样本不存在：${src}`); return; }
  const text = fs.readFileSync(src, 'utf8');

  const summaryOf = async (extDir) => {
    const { state } = await loadExtension(extDir);
    const doc = fakeDocument(text, src);
    await focusLine(state, fakeEditor(doc), 0);
    await state.commands.get('galweave.inspectDocument')();
    const out = state.logs.join('\n');
    return out.match(/段落 (\d+)\s+人名 (\d+)\s+对话 (\d+)\s+旁白 (\d+)/)?.slice(1).join(',');
  };

  const fromSource = await summaryOf(EXT_DIR);
  const fromDist = await summaryOf(DIST_DIR);
  assert.ok(fromSource, '源码路径应能识别出段落');
  assert.equal(fromDist, fromSource, '打包产物的识别结果应与源码一致');
});

test('打包产物：○/● 规则在 dist 下同样生效', async () => {
  const { state } = await loadFromDist();
  const doc = fakeDocument('○00000|000008|003○ [[照]] 「むにゃむにゃ」[np]\n●00000|000008|003● [[照]] 「唔喵唔喵」[np]\n', '/ws/b.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  assert.match(state.statusItems[0].tooltip.value, /○\/●/);
  assert.deepEqual(rangesFor(editor, 'dialogue').map(r => r.start.line), [0]);
});

test('打包产物：诊断与编辑命令可用（端到端跑一次闭环）', async () => {
  const { state } = await loadFromDist();
  const text = '☆0002☆☆雨が降る。\n';
  const doc = fakeDocument(text, '/ws/e2e.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);

  // 补译文行 → 应插入 ★0002★★
  await state.commands.get('galweave.insertTransLine')();
  assert.equal(doc._lines()[1], '★0002★★');

  // 诊断能跑通（无结构错误即为空）
  const items = await requireProviders(DIST_DIR).refresh(doc);
  assert.ok(Array.isArray(items));
});

/* ---------------- 镜像格式（dc4ph） ---------------- */

test('打包产物：dc4ph 镜像格式在 dist 下同样识别、着色与锁定', async () => {
  const { state } = await loadFromDist();
  const doc = fakeDocument([
    '#0x16E1',
    '★◎  001  ◎★//　おはよう',
    '★◎  001  ◎★　早上好',
    '',
  ].join('\n'), '/ws/mirror.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  assert.match(state.statusItems[0].tooltip.value, /镜像格式/, 'dist 下也应走镜像格式分流');
  assert.deepEqual(rangesFor(editor, 'narration').map(r => r.start.line), [1], '原文行应着色');

  // 译文行的编号前缀照常锁着（镜像格式没有 ☆/★，前缀是 ★◎  001  ◎★）
  await focusLine(state, editor, 2);
  assert.equal(state.contextKeys.get('galweave.onTransLine'), true);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), true);
});
