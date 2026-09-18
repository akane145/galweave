// dict.test.mjs — 词条清洗、取词候选、真实 MDX 查询
//
// 词典是新功能，必须拿**真实 .mdx** 验证：js-mdict 的调用方式、词条 HTML 的清洗结果、
// 以及"光标处取词"在真日语文本上的表现，都不是构造用例能说明的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  htmlToText, decodeEntities, wordRunAt, candidatesAt, followTarget, isPureLink,
} from '../src/dicttext.js';
import { EXT_DIR, fakeDocument, fakeEditor, loadExtension, focusLine, selectRange } from './helpers/mock-vscode.mjs';

/* ---------------- 词条清洗 ---------------- */

test('decodeEntities：命名实体与数字实体都能还原', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
  assert.equal(decodeEntities('&unknown;'), '&unknown;', '不认识的实体原样保留');
});

test('htmlToText：块级标签转换行、行内标签剥掉', () => {
  const html = '<div>第一行</div><div>第二行</div><span>同<b>行</b></span>';
  assert.equal(htmlToText(html), '第一行\n第二行\n同行');
});

test('htmlToText：script / style / 注释整块丢弃', () => {
  const html = '<style>.a{color:red}</style><script>alert(1)</script><!-- 注释 -->正文';
  assert.equal(htmlToText(html), '正文');
});

test('htmlToText：br 与列表项', () => {
  assert.equal(htmlToText('a<br>b<br/>c'), 'a\nb\nc');
  assert.equal(htmlToText('<ul><li>甲</li><li>乙</li></ul>'), '・甲\n・乙');
});

test('htmlToText：压缩多余空行与行内空白', () => {
  assert.equal(htmlToText('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb');
  assert.equal(htmlToText('a   \t  b'), 'a b');
});

test('htmlToText：空输入不抛错', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
});

/* ---------------- 光标处取词 ---------------- */

test('wordRunAt：取包含光标的日语连续串（括号会切断）', () => {
  const s = '☆0001☆藍☆「ありがとう」';
  const run = wordRunAt(s, s.indexOf('が'));
  assert.equal(s.slice(run.from, run.to), 'ありがとう');
});

test('wordRunAt：光标在词尾间隙也能取到', () => {
  const s = '「ありがとう」';
  const run = wordRunAt(s, s.indexOf('」')); // 紧跟在词后面
  assert.equal(s.slice(run.from, run.to), 'ありがとう');
});

test('wordRunAt：光标不在日语串上返回 null', () => {
  assert.equal(wordRunAt('☆0001☆', 2), null);
  assert.equal(wordRunAt('abc', 1), null);
});

test('candidatesAt：长的在前，且都包含光标位置', () => {
  const s = 'ありがとうございました';
  const cands = candidatesAt(s, 3);
  assert.ok(cands.length > 1, '应给出多个候选');
  assert.equal(cands[0], s, '最先试整串');
  assert.deepEqual(cands, [...cands].sort((a, b) => b.length - a.length), '长的在前');
  for (const c of cands) assert.ok(s.includes(c), `候选「${c}」应来自原串`);
});

test('candidatesAt：短串直接给出自身', () => {
  assert.deepEqual(candidatesAt('天気', 0), ['天気']);
  assert.deepEqual(candidatesAt('あ', 0), ['あ'], '单字也给（上限内）');
});

test('candidatesAt：非日语位置返回空', () => {
  assert.deepEqual(candidatesAt('☆0001☆', 2), []);
});

/* ---------------- 真实 MDX ---------------- */

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

const REAL_MDX = findRealMdx();

/** 按文件名片段找一部真实词典（如 'XSJRH'），找不到返回 null */
function findByWord(frag) {
  const root = path.resolve(EXT_DIR, '../JPdict');
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase().endsWith('.mdx') && e.name.toUpperCase().includes(frag.toUpperCase())) return p;
    }
  }
  return null;
}

test('真实 MDX：能打开并查到词', async (t) => {
  if (!REAL_MDX) { t.skip('JPdict 下没有 .mdx'); return; }
  let mod;
  try { mod = await import('js-mdict'); } catch (e) { t.skip(`js-mdict 不可用：${e.message}`); return; }

  const dict = new mod.MDX(REAL_MDX);
  const r = dict.lookup('天気');
  assert.ok(r, '应能查到「天気」');
  assert.ok(r.definition && r.definition.length > 0, '词条正文非空');

  const text = htmlToText(r.definition);
  assert.ok(text.length > 0, '清洗后不应为空');
  assert.ok(!/<[a-z/]/i.test(text), `清洗后不该残留标签：${text.slice(0, 120)}`);
  t.diagnostic(`${path.basename(REAL_MDX)} 「天気」 → ${text.length} 字`);
});

test('真实 MDX：查不到的返回空，不抛错', async (t) => {
  if (!REAL_MDX) { t.skip('JPdict 下没有 .mdx'); return; }
  let mod;
  try { mod = await import('js-mdict'); } catch (e) { t.skip('js-mdict 不可用'); return; }
  const dict = new mod.MDX(REAL_MDX);
  const r = dict.lookup('ｚｚｚｚｚ不存在的词ｚｚｚｚｚ');
  assert.ok(!r || !r.definition, '应有空结果');
  const list = dict.prefix('天気');
  assert.ok(Array.isArray(list), '前缀联想应返回数组');
});

/* ---------------- 经扩展查询（端到端） ---------------- */

test('查词典命令：选中文本 → 结果写进虚拟文档', async (t) => {
  if (!REAL_MDX) { t.skip('JPdict 下没有 .mdx'); return; }
  const { state } = await loadExtension(EXT_DIR, { settings: { mdxPaths: [REAL_MDX] } });

  // 在译文行里放一段日语，选中「天気」
  const doc = fakeDocument('☆0001☆藍☆「天気」\n★0001★蓝★「天气」\n', '/ws/d.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  // ☆0001☆藍☆「天気」 → 「天気」在 [8,12)，其中 天気 是 [9,11)
  await selectRange(state, editor, { line: 0, character: 9 }, { line: 0, character: 11 });

  await state.commands.get('galweave.lookupDict')();

  assert.ok(state.shownDocs.length > 0, '应打开（或刷新）结果文档');
  const provider = state.contentProviders.get('galweave-dict');
  assert.ok(provider, '应注册虚拟文档 provider');
  const text = provider.provideTextDocumentContent();
  assert.match(text, /查询：天気/);
  assert.match(text, /选中文本/);
  assert.match(text, /【/, '应有词条分节');
  assert.ok(!/<[a-z/]/i.test(text), '结果里不该有 HTML 标签');
  t.diagnostic(text.split('\n').slice(0, 4).join(' | '));
});

test('查词典命令：光标在词上（无选区）也能查', async () => {
  if (!REAL_MDX) return;
  const { state } = await loadExtension(EXT_DIR, { settings: { mdxPaths: [REAL_MDX] } });
  const doc = fakeDocument('☆0001☆藍☆「天気がいい」\n★0001★蓝★「天气很好」\n', '/ws/d2.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  await editor.document.lineAt?.(0); // 保持接口一致
  editor.selection = {
    active: { line: 0, character: 9 }, anchor: { line: 0, character: 9 },
    start: { line: 0, character: 9 }, end: { line: 0, character: 9 }, isEmpty: true,
  };
  await state.commands.get('galweave.lookupDict')();
  const provider = state.contentProviders.get('galweave-dict');
  assert.match(provider.provideTextDocumentContent(), /光标所在行/);
});

/* ---------------- @@@LINK 重定向 ---------------- */

test('followTarget：识别重定向，普通词条返回 null', () => {
  assert.equal(followTarget('@@@LINK=てんき【天気】\u0000'), 'てんき【天気】');
  assert.equal(followTarget('@@@LINK=43031\n\u0000'), '43031');
  assert.equal(followTarget('  @@@LINK=abc'), 'abc', '允许前置空白');
  assert.equal(followTarget('<h3>天気</h3>'), null, '正常词条不是重定向');
  assert.equal(followTarget(''), null);
  assert.equal(followTarget(null), null);
  assert.equal(followTarget('@@@LINK='), null, '空目标不算');
});

test('isPureLink：只有链接行才算纯重定向（带正文的不算）', () => {
  assert.equal(isPureLink('@@@LINK=abc\u0000'), true);
  assert.equal(isPureLink('@@@LINK=abc\n'), true);
  assert.equal(isPureLink('@@@LINK=abc\u0000<h3>正文</h3>'), false, '后面还有正文');
  assert.equal(isPureLink('<h3>正文</h3>'), false);
});

test('真实词典：日汉辞典的重定向被跟随（回归：曾直接显示 @@@LINK=…）', async (t) => {
  // XSJRH 这类辞典大量词条只是指向另一条的重定向。不跟随的话用户看到的是
  // 一串「@@@LINK=てんき【天気】」而不是释义 —— 这是拿真实词典试才发现的。
  const mdx = findByWord('XSJRH');
  if (!mdx) { t.skip('JPdict 下没有 XSJRH.mdx'); return; }
  let mod;
  try { mod = await import('js-mdict'); } catch (e) { t.skip('js-mdict 不可用'); return; }

  const d = new mod.MDX(mdx);
  const raw = d.lookup('天気');
  assert.ok(followTarget(raw.definition), '这部辞典的「天気」应当就是重定向（前提变了要更新用例）');

  const target = followTarget(raw.definition);
  const followed = d.lookup(target);
  assert.ok(followed && followed.definition, `应能查到目标词条 ${target}`);
  assert.equal(followTarget(followed.definition), null, '目标本身不该还是重定向');
  assert.ok(String(followed.definition).length > 500,
    `跟随后的词条应当有实质内容，实际 ${String(followed.definition).length} 字`);
  t.diagnostic(`天気 → ${target} → ${String(followed.definition).length} 字`);
});

test('查词典命令：走扩展路径拿到的是释义而不是 @@@LINK（端到端）', async (t) => {
  const mdx = findByWord('XSJRH');
  if (!mdx) { t.skip('JPdict 下没有 XSJRH.mdx'); return; }

  const { state } = await loadExtension(EXT_DIR, { settings: { mdxPaths: [mdx] } });
  const doc = fakeDocument('☆0001☆藍☆「天気」\n★0001★蓝★「天气」\n', '/ws/link.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  await selectRange(state, editor, { line: 0, character: 9 }, { line: 0, character: 11 });
  await state.commands.get('galweave.lookupDict')();

  const provider = state.contentProviders.get('galweave-dict');
  const text = provider.provideTextDocumentContent();
  assert.ok(!/@@@LINK=/.test(text), `结果里不该出现 @@@LINK，实际：${text.slice(0, 200)}`);
  assert.match(text, /【XSJRH\.mdx】/, '应有词条分节');
  assert.match(text, /天気/, '结果里应出现词头');
  // 清洗后的正文会比原始 HTML 短很多（ruby/标记被剥掉），所以阈值按渲染结果定
  assert.ok(text.length > 200, `结果应有实质内容，实际 ${text.length} 字`);
  t.diagnostic(`结果 ${text.length} 字，首行：${text.split('\n')[0]}`);
});

/* ---------------- 路径解析：目录 / 坏路径 ---------------- */

test('路径：指向目录时递归扫出里面的 .mdx（回归：曾抛 EISDIR）', async (t) => {
  // 指向词典文件夹是很自然的用法。之前只当文件处理，`new MDX(目录)` 会抛
  // `EISDIR: illegal operation on a directory` —— 用户看到的是一句看不懂的错。
  const src = findByWord('manga-onomatopoeia');
  if (!src) { t.skip('JPdict 下没有可用的 .mdx'); return; }

  // 临时目录 + 副本：顺带验证"递归"（套一层子目录），也避免为一条用例载入 13 部词典
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galweave-dir-'));
  try {
    fs.copyFileSync(src, path.join(tmp, '一级.mdx'));
    const sub = path.join(tmp, '子目录');
    fs.mkdirSync(sub);
    fs.copyFileSync(src, path.join(sub, '二级.mdx'));

    const { state } = await loadExtension(EXT_DIR, { settings: { mdxPaths: [tmp] } });
    const editor = fakeEditor(fakeDocument('☆0001☆藍☆「あ」\n'));
    await focusLine(state, editor, 0);
    await state.commands.get('galweave.lookupDict')();

    assert.equal(state.warnings.filter(w => /EISDIR/.test(w)).length, 0, '不该出现 EISDIR');
    const text = state.contentProviders.get('galweave-dict').provideTextDocumentContent();
    const loaded = (text.match(/词典：(.*)/) || [])[1] || '';
    assert.match(loaded, /一级\.mdx/, `应扫到顶层文件，实际：${loaded}`);
    assert.match(loaded, /二级\.mdx/, `应递归扫到子目录，实际：${loaded}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('路径：目录里没有 .mdx 时给出可读提示', async (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'galweave-empty-'));
  try {
    const { state } = await loadExtension(EXT_DIR, { settings: { mdxPaths: [empty] } });
    const editor = fakeEditor(fakeDocument('☆0001☆藍☆「天気」\n'));
    await focusLine(state, editor, 0);
    await state.commands.get('galweave.lookupDict')();
    assert.ok(state.warnings.some(w => /没有找到 .mdx|没有精确命中|没找到/.test(w)),
      `应给提示，实际：${state.warnings.join(' | ')}`);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('路径：不存在的路径给出可读提示，不抛异常', async () => {
  const { state } = await loadExtension(EXT_DIR, { settings: { mdxPaths: ['D:/不存在的目录/x.mdx'] } });
  const editor = fakeEditor(fakeDocument('☆0001☆藍☆「天気」\n'));
  await focusLine(state, editor, 0);
  await state.commands.get('galweave.lookupDict')();
  assert.ok(state.warnings.some(w => /路径不存在/.test(w)), `实际：${state.warnings.join(' | ')}`);
});

test('路径：非 .mdx 文件被拒绝并说明', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'galweave-notmdx-'));
  const f = path.join(tmp, 'notadict.txt');
  fs.writeFileSync(f, 'hello');
  try {
    const { state } = await loadExtension(EXT_DIR, { settings: { mdxPaths: [f] } });
    const editor = fakeEditor(fakeDocument('☆0001☆藍☆「天気」\n'));
    await focusLine(state, editor, 0);
    await state.commands.get('galweave.lookupDict')();
    assert.ok(state.warnings.some(w => /不是 .mdx/.test(w)), `实际：${state.warnings.join(' | ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('查词典命令：没配词典且工作区找不到时给出提示', async () => {
  const { state } = await loadExtension(EXT_DIR, { settings: { mdxPaths: [] } });
  const editor = fakeEditor(fakeDocument('☆0001☆藍☆「天気」\n'));
  await focusLine(state, editor, 0);
  await state.commands.get('galweave.lookupDict')();
  assert.ok(state.warnings.some(w => /没找到 .mdx/.test(w)), `实际：${state.warnings.join(' | ')}`);
});
