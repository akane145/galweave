// extension.test.mjs — 扩展集成测试（源码目录）
//
// mock 与假文档在 tests/helpers/mock-vscode.mjs，与 package.test.mjs 共用。
// 本文件验证源码目录下的行为；打包产物由 package.test.mjs 验证。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ENC, buildReverseTable, encodeWithTable } from '../src/encoding.js';

import {
  EXT_DIR, fakeDocument, fakeEditor, rangesFor, mkUri, loadExtension, requireProviders,
  focusLine, moveCursor, selectRange,
} from './helpers/mock-vscode.mjs';

const SAMPLE = '\u26060001\u2606\u85cd\u2606\u300c\u304a\u306f\u3088\u3046\u300d\n'
  + '\u26050001\u2605\u84dd\u2605\u300c\u65e9\u4e0a\u597d\u300d\n\n'
  + '\u26060002\u2606\u2606\u96e8\u304c\u964d\u308b\u3002\n\n'
  + '\u2606NAME|1\u2606\u674e\u56db\n';

const CIRCLE = '\u25cb00000|000008|003\u25cb [[\u7167]] \u300c\u3080\u306b\u3083\u3080\u306b\u3083\u300d[np]\n'
  + '\u25cf00000|000008|003\u25cf [[\u7167]] \u300c\u5514\u55b5\u5514\u55b5\u300d[np]\n';

const load = (opts) => loadExtension(EXT_DIR, opts);

/* ---------------- 激活与命令注册 ---------------- */

test('activate 注册全部命令、两个状态栏项与四类 provider', async () => {
  const { state } = await load();
  for (const id of [
    'galweave.inspectDocument', 'galweave.showRules', 'galweave.toggleHighlight',
    'galweave.export', 'galweave.copyOrigToTrans', 'galweave.insertTransLine',
    'galweave.clearTrans', 'galweave.gotoCounterpart',
    'galweave.recordBaseline', 'galweave.clearBaseline',
    'galweave.nextLine', 'galweave.prevLine', 'galweave.blockEdit', 'galweave.toggleLock',
  ]) assert.ok(state.commands.has(id), `应注册 ${id}`);
  // 两个状态栏项：段落计数 + 光标所在行的性质
  assert.equal(state.statusItems.length, 2);
  assert.equal(state.statusItems[0].command, 'galweave.inspectDocument');
  // 第二个项的文案/命令要等光标落到原文行上才设（见「行状态提示」用例）
  assert.ok(state.providers.hover && state.providers.folding && state.providers.symbols && state.providers.codeActions);
});

/* ---------------- 逐行导航（Enter / Tab 换行） ---------------- */

// 每段都有译文行，导航落点才有确定性
const FULL = [
  '☆0001☆藍☆「おはよう」', '★0001★蓝★「早上好」', '',
  '☆0002☆藍☆「おやすみ」', '★0002★蓝★「晚安」', '',
].join('\n');

test('下一行：光标从原文行落到下一段的译文行', async () => {
  const { state } = await load();
  const doc = fakeDocument(FULL, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  await state.commands.get('galweave.nextLine')();
  assert.equal(editor.selection.active.line, 4, '第 2 段的译文行');
});

test('下一行：光标在译文行上同样落到下一段的译文行', async () => {
  const { state } = await load();
  const doc = fakeDocument(FULL, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 1);
  await state.commands.get('galweave.nextLine')();
  assert.equal(editor.selection.active.line, 4);
});

test('上一行：Shift+Tab 回到上一段的译文行', async () => {
  const { state } = await load();
  const doc = fakeDocument(FULL, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 4);
  await state.commands.get('galweave.prevLine')();
  assert.equal(editor.selection.active.line, 1);
});

test('上一行：第一段落再往前不动，只提示', async () => {
  const { state } = await load();
  const doc = fakeDocument(FULL, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 1);
  await state.commands.get('galweave.prevLine')();
  assert.equal(editor.selection.active.line, 1);
  assert.ok(state.statusMessages.some(m => /已经是第一段/.test(m)));
});

test('下一行：目标段落没有译文行时自动补一条，落点永远可编辑', async () => {
  const { state } = await load();
  // 第 2 段（雨が降る）没有 ★ 行
  const doc = fakeDocument('☆0001☆藍☆「あ」\n★0001★蓝★「啊」\n\n☆0002☆☆雨が降る。\n', '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 1);
  await state.commands.get('galweave.nextLine')();
  assert.equal(doc._lines()[3], '☆0002☆☆雨が降る。');
  assert.equal(doc._lines()[4], '★0002★★', '应自动补出译文行');
  assert.equal(editor.selection.active.line, 4, '光标落在新补的译文行上');
});

test('下一行：关掉自动补行时停在原文行', async () => {
  const { state } = await load({ settings: { autoInsertTransLine: false } });
  const doc = fakeDocument('☆0001☆藍☆「あ」\n★0001★蓝★「啊」\n\n☆0002☆☆雨が降る。\n', '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 1);
  await state.commands.get('galweave.nextLine')();
  assert.equal(doc._lines().length, 5, '不该插入新行');
  assert.equal(editor.selection.active.line, 3, '停在原文行');
});

test('下一行：已在最后一段时不动，只提示', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 5);
  await state.commands.get('galweave.nextLine')();
  assert.equal(editor.selection.active.line, 5);
  assert.ok(state.statusMessages.some(m => /已经是最后一段/.test(m)));
});

test('落点：译文是「」包裹时光标停在收尾括号之前（复刻锁定括号）', async () => {
  const { state } = await load();
  const doc = fakeDocument(FULL, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  await state.commands.get('galweave.nextLine')();
  const line = doc.lineAt(editor.selection.active.line).text;
  assert.equal(line, '★0002★蓝★「晚安」');
  assert.equal(editor.selection.active.character, line.length - 1, '光标应停在 」 之前');
});

test('落点：没有「」包裹的译文停在行尾', async () => {
  const { state } = await load();
  const doc = fakeDocument([
    '☆0001☆A☆「あ」', '★0001★甲★「啊」', '',
    '☆0002☆B☆「い」', '★0002★乙★早上好', '',
  ].join('\n'), '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  await state.commands.get('galweave.nextLine')();
  assert.equal(editor.selection.active.line, 4);
  assert.equal(editor.selection.active.character, doc.lineAt(4).text.length);
});

/* ---------------- 上下文键与原文锁定 ---------------- */

test('上下文键：识别为脚本、光标行性质、锁定状态都写进 setContext', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  assert.equal(state.contextKeys.get('galweave.isScript'), true);
  assert.equal(state.contextKeys.get('galweave.onOrigLine'), true);
  assert.equal(state.contextKeys.get('galweave.onTransLine'), false);
  assert.equal(state.contextKeys.get('galweave.locked'), true);

  await moveCursor(state, editor, 1);
  assert.equal(state.contextKeys.get('galweave.onOrigLine'), false);
  assert.equal(state.contextKeys.get('galweave.onTransLine'), true);
});

test('上下文键：普通代码文件不置 isScript，锁定也不生效', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument('export function f() {}\n'));
  await focusLine(state, editor, 0);
  assert.equal(state.contextKeys.get('galweave.isScript'), false);
  assert.equal(state.contextKeys.get('galweave.onOrigLine'), false);
});

/* ---------------- 译文行前后缀/括号也锁 ---------------- */

// 0 ☆0001☆藍☆「おはよう」  1 ★0001★蓝★「早上好」  2 空
// 3 ☆0002☆藍☆「おやすみ」  4 ★0002★蓝★「晚安」
// 译文行的可编辑区只有正文：★0001★蓝★ 是前缀，「」是收尾括号
const BK = FULL;

test('锁定：原文行整行拦（输入/退格/删除都拦）', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), true);
  assert.equal(state.contextKeys.get('galweave.blockBackspace'), true);
  assert.equal(state.contextKeys.get('galweave.blockDelete'), true);
});

test('锁定：译文行前缀上拦（前后缀不可编辑）', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  await moveCursor(state, editor, 1, 0); // ★0001★蓝★ 的第 0 列
  assert.equal(state.contextKeys.get('galweave.onTransLine'), true);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), true, '前缀不可编辑');
  assert.equal(state.contextKeys.get('galweave.blockBackspace'), true, '前缀上退格会吃掉前缀');
});

test('锁定：译文正文中间不拦（正常编辑）', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  // ★0001★蓝★「早上好」 → 正文「早上好」在 [8,13)，可编辑区 [9,12]
  await moveCursor(state, editor, 1, 10);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), false);
  assert.equal(state.contextKeys.get('galweave.blockBackspace'), false, '正文内部退格正常');
  assert.equal(state.contextKeys.get('galweave.blockDelete'), false, '正文内部删除正常');
});

test('锁定：正文起点退格被拦（会吃掉「）', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  await moveCursor(state, editor, 1, 9); // 可编辑区起点
  assert.equal(state.contextKeys.get('galweave.editBlocked'), false, '在这里可以输入');
  assert.equal(state.contextKeys.get('galweave.blockBackspace'), true, '但退格会吃掉「');
  assert.equal(state.contextKeys.get('galweave.blockDelete'), false);
});

test('锁定：正文终点删除被拦（会吃掉」）', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  await moveCursor(state, editor, 1, 12); // 可编辑区终点（收尾括号之前）
  assert.equal(state.contextKeys.get('galweave.editBlocked'), false, '在这里可以输入');
  assert.equal(state.contextKeys.get('galweave.blockDelete'), true, '但删除会吃掉」');
  assert.equal(state.contextKeys.get('galweave.blockBackspace'), false);
});

test('锁定：收尾括号之后整段拦', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  await moveCursor(state, editor, 1, 13); // 」之后
  assert.equal(state.contextKeys.get('galweave.editBlocked'), true);
});

test('锁定：没有「」包裹的译文，可编辑区是整个正文', async () => {
  const { state } = await load();
  const doc = fakeDocument('☆0002☆A☆「あ」\n★0002★甲★早上好\n', '/ws/n.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  const len = doc.lineAt(1).text.length; // ★0002★甲★早上好
  await moveCursor(state, editor, 1, 8);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), false, '正文起点可编辑');
  await moveCursor(state, editor, 1, len);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), false, '行尾可编辑');
  assert.equal(state.contextKeys.get('galweave.blockDelete'), true, '行尾删除无内容可删，一并拦掉');
});

test('锁定：空译文行可输入，但退格被拦（不能吃掉前缀）', async () => {
  const { state } = await load();
  const doc = fakeDocument('☆0002☆A☆「あ」\n★0002★★\n', '/ws/e.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  await moveCursor(state, editor, 1, doc.lineAt(1).text.length);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), false, '可以在空译文里输入');
  assert.equal(state.contextKeys.get('galweave.blockBackspace'), true, '但退格会吃掉前缀');
});

test('锁定：选区覆盖到原文行时全拦（否则选中就能绕过）', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  await selectRange(state, editor, { line: 0, character: 0 }, { line: 1, character: 5 });
  assert.equal(state.contextKeys.get('galweave.editBlocked'), true);
  assert.equal(state.contextKeys.get('galweave.blockBackspace'), true);
  assert.equal(state.contextKeys.get('galweave.blockDelete'), true);
});

test('锁定：只选译文正文时放行', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  await selectRange(state, editor, { line: 1, character: 9 }, { line: 1, character: 12 });
  assert.equal(state.contextKeys.get('galweave.editBlocked'), false, '选区在正文内，允许');
});

test('锁定：选区越出正文（含「）时拦住', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  await selectRange(state, editor, { line: 1, character: 8 }, { line: 1, character: 12 });
  assert.equal(state.contextKeys.get('galweave.editBlocked'), true, '选区含「，会破坏结构');
});

test('锁定：解锁后上下文键全部放行', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(BK, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), true);
  await state.commands.get('galweave.toggleLock')();
  assert.equal(state.contextKeys.get('galweave.editBlocked'), false, '解锁后不拦');
  assert.equal(state.contextKeys.get('galweave.blockBackspace'), false);
});

test('原文锁定：blockEdit 吞掉按键并提示，不改动文档', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  await focusLine(state, fakeEditor(doc), 0);
  const before = doc.getText();
  await state.commands.get('galweave.blockEdit')('x');
  assert.equal(doc.getText(), before, '一个字符都不能变');
  assert.ok(state.statusMessages.some(m => /原文已锁定/.test(m)));
});

test('原文锁定：开关命令能临时解锁，上下文键跟着变', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  assert.equal(state.contextKeys.get('galweave.locked'), true);
  assert.match(state.statusItems[1].text, /已锁定/);

  await state.commands.get('galweave.toggleLock')();
  assert.equal(state.contextKeys.get('galweave.locked'), false);
  assert.match(state.statusItems[1].text, /未锁定/);
  assert.ok(state.messages.some(m => /原文锁定已关闭/.test(m)));

  await state.commands.get('galweave.toggleLock')();
  assert.equal(state.contextKeys.get('galweave.locked'), true);
});

test('原文锁定：设置关掉后 locked 直接为假', async () => {
  const { state } = await load({ settings: { lockOriginal: false } });
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  assert.equal(state.contextKeys.get('galweave.locked'), false);
});

test('行状态提示：原文行显示锁定、译文行显示可编辑', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  assert.match(state.statusItems[1].text, /原文行 · 已锁定/);

  await moveCursor(state, editor, 1);
  assert.match(state.statusItems[1].text, /译文行/);

  await moveCursor(state, editor, 2);
  assert.equal(state.statusItems[1].visible, false, '空行上不显示');
});

/* ---------------- 基线自动记录 ---------------- */

test('基线：首次识别到脚本就自动记一次，且不覆盖已有基线', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  await focusLine(state, fakeEditor(doc), 0);
  const keys = [...state.workspaceState.keys()].filter(k => k.startsWith('baseline:'));
  assert.equal(keys.length, 1, '应自动记录基线');
  assert.deepEqual(state.workspaceState.get(keys[0]), ['☆0001☆藍☆「おはよう」', '☆0002☆☆雨が降る。']);

  // 再触发一次不该覆盖
  await focusLine(state, fakeEditor(doc), 0);
  assert.deepEqual(state.workspaceState.get(keys[0]), ['☆0001☆藍☆「おはよう」', '☆0002☆☆雨が降る。']);
});

test('基线：autoBaseline 关掉后不自动记录', async () => {
  const { state } = await load({ settings: { autoBaseline: false } });
  await focusLine(state, fakeEditor(fakeDocument(SAMPLE, '/ws/a.txt')), 0);
  assert.equal([...state.workspaceState.keys()].filter(k => k.startsWith('baseline:')).length, 0);
});

/* ---------------- 着色 ---------------- */

test('着色：三类段落各落到对应的装饰器上', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument(SAMPLE, '/ws/a.txt'));
  await focusLine(state, editor, 0);
  assert.deepEqual(rangesFor(editor, 'dialogue').map(r => r.start.line), [0]);
  assert.deepEqual(rangesFor(editor, 'narration').map(r => r.start.line), [3]);
  assert.deepEqual(rangesFor(editor, 'name').map(r => r.start.line), [5]);
});

test('着色：普通代码文件不着色（不误伤）', async () => {
  const { state } = await load();
  const editor = fakeEditor(fakeDocument('export function f() {\n  return 1;\n}\n'));
  await focusLine(state, editor, 0);
  assert.equal(editor.calls.length, 0);
  assert.equal(state.statusItems[0].visible, false);
});

test('混合格式：同一会话内 ☆/★ 与 ○/● 各用各的规则', async () => {
  const { state } = await load();
  const a = fakeEditor(fakeDocument(SAMPLE, '/ws/a.txt'));
  await focusLine(state, a, 0);
  assert.match(state.statusItems[0].tooltip.value, /标准 ☆\/★/);

  const b = fakeEditor(fakeDocument(CIRCLE, '/ws/b.txt'));
  await focusLine(state, b, 0);
  assert.match(state.statusItems[0].tooltip.value, /○\/●/);
  assert.deepEqual(rangesFor(b, 'dialogue').map(r => r.start.line), [0], '○/● 行应识别为对话');

  await focusLine(state, a, 0);
  assert.match(state.statusItems[0].tooltip.value, /标准 ☆\/★/, '切回 A 仍是 ☆/★ 规则');
});

/* ---------------- hover ---------------- */

test('hover：译文行上显示对应原文', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const h = await state.providers.hover.provideHover(doc, { line: 1, character: 3 });
  assert.ok(h, '译文行应有 hover');
  const text = h.contents.value;
  assert.match(text, /对话/);
  assert.match(text, /藍/);
  assert.match(text, /原文：/);
  assert.match(text, /「おはよう」/, '应显示原文');
});

test('hover：未翻译的段落提示未翻译', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const h = await state.providers.hover.provideHover(doc, { line: 3, character: 2 });
  assert.ok(h);
  assert.match(h.contents.value, /未翻译/);
  assert.match(h.contents.value, /旁白/);
});

test('hover：空行上不返回 hover', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  assert.equal(await state.providers.hover.provideHover(doc, { line: 2, character: 0 }), null);
});

/* ---------------- 折叠与大纲 ---------------- */

test('折叠：每段一个区域，覆盖原文行到译文行', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const ranges = await state.providers.folding.provideFoldingRanges(doc);
  assert.deepEqual(ranges.map(r => [r.start, r.end]), [[0, 1]], '只有第 1 段有译文行可折');
});

test('大纲：按段落列出，说话人出现在标题里', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const syms = await state.providers.symbols.provideDocumentSymbols(doc);
  assert.equal(syms.length, 3);
  assert.match(syms[0].name, /^藍：/, '对话行带说话人');
  assert.equal(syms[0].detail, '', '已翻译不带标记');
  assert.equal(syms[1].detail, '未翻译');
  assert.equal(syms[1].selectionRange.start.line, 3, '点击后落在原文行');
});

/* ---------------- 诊断 ---------------- */

test('诊断：编号不匹配与段内多余行报进问题面板', async () => {
  const { state } = await load();
  const doc = fakeDocument('☆0001☆A☆「あ」\n★0009★甲★「啊」\n无关的一行\n');
  const items = await requireProviders(EXT_DIR).refresh(doc);
  const msgs = (state.diagnostics.get(doc.uri.toString()) || []).map(d => d.message);
  assert.ok(msgs.some(m => /编号/.test(m)), `应报编号不匹配，实际：${msgs.join(' | ')}`);
  assert.ok(msgs.some(m => /既不是原文也不是译文/.test(m)), `应报段内多余行，实际：${msgs.join(' | ')}`);
  assert.ok(items.length >= 2);
});

test('诊断：记录基线后，改动原文会被报出来', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  state.activeTextEditor = editor;
  await state.commands.get('galweave.recordBaseline')();
  assert.ok(state.messages.some(m => /已记录 2 行原文基线/.test(m)), '应报告记录的行数');

  // 改掉一段原文（模拟用户在原生编辑器里手改）
  doc._apply({ start: { line: 3, character: 0 }, end: { line: 3, character: 999 } }, '☆0002☆☆雨がやんだ。');
  await requireProviders(EXT_DIR).refresh(doc);
  const msgs = (state.diagnostics.get(doc.uri.toString()) || []).map(d => d.message);
  assert.ok(msgs.some(m => /基线不一致/.test(m)), `应报原文与基线不一致，实际：${msgs.join(' | ')}`);

  await state.commands.get('galweave.clearBaseline')();
  await requireProviders(EXT_DIR).refresh(doc);
  const after = (state.diagnostics.get(doc.uri.toString()) || []).map(d => d.message);
  assert.ok(!after.some(m => /基线不一致/.test(m)), '清除基线后不再报');
});

test('诊断：可以整体关闭', async () => {
  const { state } = await load({ settings: { 'diagnostics.enable': false } });
  const doc = fakeDocument('☆0001☆A☆「あ」\n★0009★甲★「啊」\n');
  const items = await requireProviders(EXT_DIR).refresh(doc);
  assert.deepEqual(items, []);
});

/* ---------------- 编辑命令（真的改文本） ---------------- */

test('复制原文到译文：只改译文行内容，前缀不动', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 1);
  await state.commands.get('galweave.copyOrigToTrans')();
  assert.equal(doc._lines()[1], '★0001★蓝★「おはよう」', '前缀保留，正文换成原文');
  assert.equal(doc._lines()[0], '☆0001☆藍☆「おはよう」', '原文行一个字符都不能动');
});

test('补上译文行：按本文件规则构造前缀插入', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 3);
  await state.commands.get('galweave.insertTransLine')();
  assert.equal(doc._lines()[3], '☆0002☆☆雨が降る。');
  assert.equal(doc._lines()[4], '★0002★★', '插入的译文行用 ★ 前缀，说话人段为空');
});

test('补上译文行：自定义正则规则下拒绝执行（会写出引擎读不出来的行）', async () => {
  const { state } = await load();
  const doc = fakeDocument('○00001○ [[藍]] 「あ」\n', '/ws/b.txt');
  await fireRefresh(state, fakeEditor(doc));
  await state.commands.get('galweave.insertTransLine')();
  assert.equal(doc._lines().length, 2, '不该插入任何行');
  assert.ok(state.warnings.some(w => /自定义正则规则/.test(w)), '应说明拒绝原因');
});

test('补上译文行：旧约定正则（分段式前缀）仍可用', async () => {
  // 旧约定的自定义正则仍然是 ☆/★ 分段式，buildStarPrefix 能正确构造译文行
  const rulePath = path.join(EXT_DIR, 'rules', '__legacy_test__.json');
  fs.writeFileSync(rulePath, JSON.stringify({
    open: '＠', close: '＃', regex: '^(＠[^＠]*＠[^＠]*＠)([\\s\\S]*)$',
  }));
  try {
    const { state } = await load();
    const doc = fakeDocument('＠0007＠藍＠「あ」\n', '/ws/c.txt');
    await fireRefresh(state, fakeEditor(doc));
    await state.commands.get('galweave.insertTransLine')();
    assert.equal(doc._lines()[1], '＃0007＃藍＃', '旧约定正则应能构造出 ＃ 前缀');
  } finally {
    fs.unlinkSync(rulePath);
  }
});

test('清空本行译文：保留前缀，清掉正文', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  await state.commands.get('galweave.clearTrans')();
  assert.equal(doc._lines()[1], '★0001★蓝★');
  assert.equal(doc._lines()[0], '☆0001☆藍☆「おはよう」');
});

test('跳到对应行：原文行跳到译文行，译文行跳回原文行', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 0);
  await state.commands.get('galweave.gotoCounterpart')();
  assert.equal(editor.selection.active.line, 1);

  await focusLine(state, editor, 1);
  await state.commands.get('galweave.gotoCounterpart')();
  assert.equal(editor.selection.active.line, 0);
});

/* ---------------- 镜像格式（dc4ph） ---------------- */

// 行号：0 #0x16E1 / 1 //原文 / 2 译文 / 3 空 / 4 #0x17ED / 5 //原文 / 6 译文 / 7 空
const MIRROR = [
  '#0x16E1',
  '★◎  001  ◎★//　放課後、買い物を済ませてから帰ってきた。',
  '★◎  001  ◎★　放学后，买完东西就回来了。',
  '',
  '#0x17ED',
  '★◎  002  ◎★//「あいよ」',
  '★◎  002  ◎★「好咧」',
  '',
].join('\n');

test('镜像格式：不靠规则库就能识别，并按段落类型着色', async () => {
  const { state } = await load();
  const doc = fakeDocument(MIRROR, '/ws/m.txt');
  const editor = fakeEditor(doc);
  await fireRefresh(state, editor);
  assert.equal(rangesFor(editor, 'narration').length, 1, '第 1 段是旁白');
  assert.equal(rangesFor(editor, 'dialogue').length, 1, '第 2 段是对话');
  assert.match(state.statusItems[0].tooltip.value, /镜像格式/, '状态栏应写明用的是镜像格式');
});

test('镜像格式：检查命令报出镜像格式与分段计数', async () => {
  const { state } = await load();
  const doc = fakeDocument(MIRROR, '/ws/m.txt');
  await fireRefresh(state, fakeEditor(doc));
  await state.commands.get('galweave.inspectDocument')();
  const text = state.logs.join('\n');
  assert.match(text, /规则：镜像格式/);
  assert.match(text, /标记：镜像格式/);
  assert.match(text, /段落 2\s+人名 0\s+对话 1\s+旁白 1/);
  assert.match(text, /区间来源：mirror/);
});

test('镜像格式：译文行的编号前缀锁着，正文可编辑', async () => {
  const { state } = await load();
  const doc = fakeDocument(MIRROR, '/ws/m.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 2); // 译文行
  assert.equal(state.contextKeys.get('galweave.onTransLine'), true);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), true, '前缀（含编号）不可编辑');

  await moveCursor(state, editor, 2, 12); // 前缀 '★◎  001  ◎★' 长 11
  assert.equal(state.contextKeys.get('galweave.editBlocked'), false, '正文里可以输入');
  assert.equal(state.contextKeys.get('galweave.blockBackspace'), false);
});

test('镜像格式：原文行整行锁着', async () => {
  const { state } = await load();
  const doc = fakeDocument(MIRROR, '/ws/m.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 1);
  assert.equal(state.contextKeys.get('galweave.onOrigLine'), true);
  assert.equal(state.contextKeys.get('galweave.editBlocked'), true);
});

test('镜像格式：Enter 从原文行落到下一段的译文行', async () => {
  const { state } = await load();
  const doc = fakeDocument(MIRROR, '/ws/m.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 1);
  await state.commands.get('galweave.nextLine')();
  assert.equal(editor.selection.active.line, 6, '第 2 段的译文行');
});

test('镜像格式：尾部截断的最后一段能补出格式正确的译文行', async () => {
  const { state } = await load();
  const text = '#0x1000\n★◎  001  ◎★//おはよう\n★◎  001  ◎★おはよう\n\n#0x1010\n★◎  002  ◎★//おやすみ\n';
  const doc = fakeDocument(text, '/ws/tail.txt');
  const editor = fakeEditor(doc);
  await focusLine(state, editor, 5); // 缺译文行的那一段
  await state.commands.get('galweave.insertTransLine')();
  assert.equal(doc._lines()[6], '★◎  002  ◎★おやすみ', '补出的应是去掉 // 的普通行');
  assert.ok(!/☆|★0000/.test(doc._lines()[6]), '不能写出 ☆/★ 那套前缀');
});

test('镜像格式：诊断不把预填原文当成问题', async () => {
  const { state } = await load();
  const doc = fakeDocument(MIRROR, '/ws/m.txt');
  await fireRefresh(state, fakeEditor(doc));
  const items = await requireProviders(EXT_DIR).computeDiagnostics(doc);
  assert.deepEqual(items, [], '预填原文的镜像文件不该刷出诊断');
});

/* ---------------- 编码（Shift-JIS / EUC-JP） ---------------- */
//
// 这些用例都落在**真实文件**上：编码检测读的是磁盘字节，假的路径拿不到东西。
// 文档文本按"VS Code 该显示成什么"给：乱码用例故意给 UTF-8 误解的结果（成片 U+FFFD）。

const SJIS_TABLE = buildReverseTable(ENC.SJIS, (b) => new TextDecoder('shift_jis', { fatal: true }).decode(b));
const EUC_TABLE = buildReverseTable(ENC.EUCJP, (b) => new TextDecoder('euc-jp', { fatal: true }).decode(b));

function tableOf(enc) { return enc === ENC.SJIS ? SJIS_TABLE : EUC_TABLE; }
function encodeTo(enc, text) {
  const { bytes, missing } = encodeWithTable(text, tableOf(enc));
  assert.deepEqual(missing, [], `测试文本应能编成 ${enc}`);
  return Buffer.from(bytes);
}

/** 在临时目录放一个真实文件；调用方负责 cleanup() */
function tempFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'galweave-enc-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return { dir, path: p, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const JP_LINE = '☆0001☆藍☆「おはよう」\n★0001★藍★「早上好」\n';

test('编码：Shift-JIS 文件被当成 UTF-8 显示时提示一次，并可一键设为工作区编码', async () => {
  const bytes = encodeTo(ENC.SJIS, JP_LINE);
  const tmp = tempFile('sjis.txt', bytes);
  try {
    const { state } = await load();
    // VS Code 按 UTF-8 解这些字节 → 成片替换字符，这就是要提示的情形
    const doc = fakeDocument(bytes.toString('utf8'), tmp.path);
    await fireRefresh(state, fakeEditor(doc));

    const warnings = state.warnings.filter(w => /Shift-JIS/.test(w));
    assert.equal(warnings.length, 1, '应提示一次');
    assert.deepEqual(state.warningButtons[0], ['设为工作区默认编码', '打开编码选择器', '忽略此文件']);

    // 同一个文件再刷新：不再打扰
    await fireRefresh(state, fakeEditor(doc));
    assert.equal(state.warnings.filter(w => /Shift-JIS/.test(w)).length, 1, '同一文件只提醒一次');
  } finally { tmp.cleanup(); }
});

test('编码：点了「设为工作区默认编码」会写 VS Code 的 files.encoding', async () => {
  const bytes = encodeTo(ENC.SJIS, JP_LINE);
  const tmp = tempFile('sjis-set.txt', bytes);
  try {
    const { state } = await load({ warnPick: '设为工作区默认编码' });
    await fireRefresh(state, fakeEditor(fakeDocument(bytes.toString('utf8'), tmp.path)));
    assert.deepEqual(state.configUpdates, [
      { section: 'files', key: 'encoding', value: 'shiftjis', target: 2 },
    ], '应写工作区级 files.encoding=shiftjis');
    assert.ok(state.messages.some(m => /files\.encoding/.test(m)), '要有回执');
  } finally { tmp.cleanup(); }
});

test('编码：用户已经把编码调对时不打扰，只在状态栏标出', async () => {
  const bytes = encodeTo(ENC.SJIS, JP_LINE);
  const tmp = tempFile('sjis-ok.txt', bytes);
  try {
    const { state } = await load();
    const doc = fakeDocument(JP_LINE, tmp.path); // VS Code 已按 Shift-JIS 解，显示正常
    const editor = fakeEditor(doc);
    await fireRefresh(state, editor);
    assert.deepEqual(state.warnings, [], '显示正常就不该弹窗');
    assert.match(state.statusItems[0].text, /Shift-JIS/, '状态栏要标出编码');
  } finally { tmp.cleanup(); }
});

test('编码：EUC-JP 文件同样识别（含半角片假名与汉字）', async () => {
  const text = '☆0002☆☆雨が降る。\n★0002★★下雨了。\n';
  const bytes = encodeTo(ENC.EUCJP, text);
  const tmp = tempFile('euc.txt', bytes);
  try {
    const { state } = await load();
    const editor = fakeEditor(fakeDocument(bytes.toString('utf8'), tmp.path));
    await fireRefresh(state, editor);
    assert.ok(state.warnings.some(w => /EUC-JP/.test(w)), '应提示 EUC-JP');
  } finally { tmp.cleanup(); }
});

test('编码：导出按源文件编码写字节（exportEncoding=source；Shift-JIS / EUC-JP 逐字节相同）', async () => {
  for (const enc of [ENC.SJIS, ENC.EUCJP]) {
    const bytes = encodeTo(enc, JP_LINE);
    const tmp = tempFile('src.txt', bytes);
    try {
      const { state } = await load({
        quickPick: 'original', saveDialog: mkUri(path.join(tmp.dir, 'out.txt')),
        settings: { exportEncoding: 'source' },
      });
      const doc = fakeDocument(JP_LINE, tmp.path);
      await fireRefresh(state, fakeEditor(doc));
      await state.commands.get('galweave.export')();

      assert.equal(state.written.length, 1, `${enc}: 应写出一个文件`);
      assert.deepEqual([...state.written[0].bytes], [...bytes], `${enc}: 应与源文件逐字节相同`);
      assert.notDeepEqual([...state.written[0].bytes], [...Buffer.from(JP_LINE, 'utf8')], `${enc}: 不该写成 UTF-8`);
    } finally { tmp.cleanup(); }
  }
});

test('编码：导出默认按 UTF-8 写（与桌面版一致，不跟源文件编码）', async () => {
  const bytes = encodeTo(ENC.SJIS, JP_LINE);
  const tmp = tempFile('src-utf8.txt', bytes);
  try {
    const { state } = await load({ quickPick: 'original', saveDialog: mkUri(path.join(tmp.dir, 'out.txt')) });
    const doc = fakeDocument(JP_LINE, tmp.path);
    await fireRefresh(state, fakeEditor(doc));
    await state.commands.get('galweave.export')();
    assert.deepEqual([...state.written[0].bytes], [...Buffer.from(JP_LINE, 'utf8')]);
  } finally { tmp.cleanup(); }
});

test('编码：译文含 Shift-JIS 表示不了的字符 → 拒绝写盘（不写问号）', async () => {
  const bytes = encodeTo(ENC.SJIS, JP_LINE);
  const tmp = tempFile('refuse.txt', bytes);
  try {
    // 简体字大多不在 JIS X 0208 里：实测一份真实样本的中文译文就有 30 个这样的字
    const cn = JP_LINE.replace('「早上好」', '「这咖啡刚进烤箱」');
    const { state } = await load({
      quickPick: 'original', saveDialog: mkUri(path.join(tmp.dir, 'out.txt')),
      settings: { exportEncoding: 'source' },
    });
    await fireRefresh(state, fakeEditor(fakeDocument(cn, tmp.path)));
    await state.commands.get('galweave.export')();

    assert.equal(state.written.length, 0, '不许写出会变成乱码/问号的文件');
    assert.ok(state.warnings.some(w => /不在 Shift-JIS 里/.test(w)), '要说清原因');
    assert.ok(state.logs.some(l => /编不出来的字符/.test(l)), '输出面板要列出字符');
  } finally { tmp.cleanup(); }
});

test('编码：拒绝之后选「以 UTF-8 导出」则按 UTF-8 落盘', async () => {
  const bytes = encodeTo(ENC.SJIS, JP_LINE);
  const tmp = tempFile('fallback.txt', bytes);
  try {
    const cn = JP_LINE.replace('「早上好」', '「这咖啡刚进烤箱」');
    const { state } = await load({
      quickPick: 'original', saveDialog: mkUri(path.join(tmp.dir, 'out.txt')), warnPick: '以 UTF-8 导出',
      settings: { exportEncoding: 'source' },
    });
    await fireRefresh(state, fakeEditor(fakeDocument(cn, tmp.path)));
    await state.commands.get('galweave.export')();
    assert.equal(state.written.length, 1);
    assert.deepEqual([...state.written[0].bytes], [...Buffer.from(cn, 'utf8')]);
  } finally { tmp.cleanup(); }
});

test('编码：检查命令把判定依据摊开给人看', async () => {
  const bytes = encodeTo(ENC.SJIS, JP_LINE);
  const tmp = tempFile('report.txt', bytes);
  try {
    const { state } = await load();
    const editor = fakeEditor(fakeDocument(JP_LINE, tmp.path));
    await fireRefresh(state, editor);
    await state.commands.get('galweave.checkEncoding')();
    const out = state.logs.join('\n');
    assert.match(out, /编码：Shift-JIS/);
    assert.match(out, /VS Code 设置值：files\.encoding = shiftjis/);
    assert.match(out, /当前显示：正常/);
    assert.match(out, /导出写回：/);
  } finally { tmp.cleanup(); }
});

async function fireRefresh(state, editor) {
  state.activeTextEditor = editor;
  await state.onActiveEditorChange();
}

/* ---------------- CodeAction ---------------- */

test('CodeAction：未翻译的段落在译文行缺失时提供「补上译文行」', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const actions = await state.providers.codeActions.provideCodeActions(doc, { start: { line: 3, character: 0 } });
  const titles = actions.map(a => a.title);
  assert.ok(titles.some(t => /补上译文行/.test(t)), `应有补行动作，实际：${titles.join(' / ')}`);
  assert.ok(!titles.some(t => /清空本行译文/.test(t)), '没有译文时不该提供清空');
});

test('CodeAction：空行上不提供动作', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  const actions = await state.providers.codeActions.provideCodeActions(doc, { start: { line: 2, character: 0 } });
  assert.deepEqual(actions, []);
});

/* ---------------- 导出 ---------------- */

test('导出：安全文件可导出原格式，内容与源文件一致', async () => {
  const { state } = await load({ quickPick: 'original', saveDialog: mkUri('/out/译文.txt') });
  // 注意：样本必须每段都有 ★ 行 —— buildExport 对 NAME 行会无条件补一条 ★ 行，
  // 缺 ★ 行的文件过不了往返自检（这是正确行为，不是 bug）
  const ok = [
    '☆0001☆藍☆「おはよう」', '★0001★蓝★「早上好」', '',
    '☆0002☆☆雨が降る。', '★0002★★下雨了。', '',
  ].join('\n');
  const doc = fakeDocument(ok, '/ws/ok.txt');
  await fireRefresh(state, fakeEditor(doc));
  await state.commands.get('galweave.export')();
  assert.equal(state.written.length, 1);
  assert.equal(state.written[0].text, ok);
});

test('导出：重建不一致时拒绝并说明原因（不许写出损坏文件）', async () => {
  const { state } = await load({ quickPick: 'original', saveDialog: mkUri('/out/x.txt') });
  // 译文行编号与原文行不同 —— buildExport 会按原文行改写编号
  const bad = '☆000000T☆「あ」\n★000001T★「啊」\n\n☆000001T☆「い」\n★000002T★「咦」\n\n☆000002T☆「う」\n★000003T★「呜」\n';
  const doc = fakeDocument(bad, '/ws/bad.txt');
  await fireRefresh(state, fakeEditor(doc));
  await state.commands.get('galweave.export')();
  assert.equal(state.written.length, 0, '不该写出任何文件');
  assert.ok(state.warnings.some(w => /已拒绝/.test(w)), '应明确告知被拒绝');
  assert.ok(state.logs.some(l => /编号与原文行不同/.test(l)), '输出面板应给出成因');
});

test('导出：双语对照不受原格式关卡影响', async () => {
  const { state } = await load({ quickPick: 'bilingual', saveDialog: mkUri('/out/双语.txt') });
  const bad = '☆000000T☆「あ」\n★000001T★「啊」\n\n☆000001T☆「い」\n★000002T★「咦」\n';
  const doc = fakeDocument(bad, '/ws/bad.txt');
  await fireRefresh(state, fakeEditor(doc));
  await state.commands.get('galweave.export')();
  assert.equal(state.written.length, 1, '单向产物不受关卡限制');
  assert.match(state.written[0].text, /「あ」/);
});

/* ---------------- 检查输出 ---------------- */

test('inspect：输出规则、计数、说话人与诊断摘要', async () => {
  const { state } = await load();
  const doc = fakeDocument(SAMPLE, '/ws/a.txt');
  await fireRefresh(state, fakeEditor(doc));
  await state.commands.get('galweave.inspectDocument')();
  const text = state.logs.join('\n');
  assert.match(text, /规则：标准 ☆\/★（自动选择）/);
  assert.match(text, /段落 3\s+人名 1\s+对话 1\s+旁白 1/);
  assert.match(text, /说话人 2 位：藍\s+李四/);
  assert.match(text, /诊断：\d+ 条/);
  assert.match(text, /术语表：.*glossary\.json（不存在）/);
});
