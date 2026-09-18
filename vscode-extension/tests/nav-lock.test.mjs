// nav-lock.test.mjs — 译文行前后缀/括号锁定的纯逻辑
//
// 与 nav.test.mjs 分开：那边测"跳到哪一行"，这边测"哪些位置/操作该被拦"。
// 这两组是 Enter/Tab 换行与原文锁定的判定核心，边界错一格就会放过对结构的破坏。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLines } from '../src/lineparse.js';
import {
  transEditRange, lockedZoneAt, blockStateAt, blockStateForSelection, selectionTouchesLocked,
} from '../src/nav.js';

const P = (text) => parseLines(text);

// 行索引：0 ☆0001  1 ★0001（「」包裹）  2 空
//         3 ☆0002  4 ★0002（无括号）   5 空
//         6 ☆0003  7 ★0003（空译文）
const TXT = [
  '☆0001☆藍☆「おはよう」', '★0001★蓝★「早上好」', '',
  '☆0002☆藍☆「おやすみ」', '★0002★蓝★晚安', '',
  '☆0003☆藍☆「さようなら」', '★0003★★', '',
].join('\n');

/* ---------------- 可编辑区 ---------------- */

test('transEditRange：带「」的译文，可编辑区向内各收一格', () => {
  const p = P(TXT);
  const line = p.lines[1].text;
  const r = transEditRange(p.paras[0], line);
  assert.equal(line.slice(r.from - 1, r.from), '「', '起点正好在「之后');
  assert.equal(line.slice(r.to, r.to + 1), '」', '终点正好在」之前');
  assert.equal(line.slice(r.from, r.to), '早上好');
});

test('transEditRange：不带「」的译文，可编辑区是整个正文', () => {
  const p = P(TXT);
  const line = p.lines[4].text;
  const r = transEditRange(p.paras[1], line);
  assert.equal(line.slice(r.from, r.to), '晚安');
});

test('transEditRange：空译文行的可编辑区是零宽（行尾）', () => {
  const p = P(TXT);
  const line = p.lines[7].text;
  const r = transEditRange(p.paras[2], line);
  assert.equal(r.from, line.length);
  assert.equal(r.to, line.length);
});

test('transEditRange：没有译文行的段落返回 null', () => {
  // 注意：本函数假定传入的是**译文行**的文本 —— translationRange 是译文行上的坐标。
  // 没有译文行时它自然拿不到区间，也就无从限制。
  const p = P('☆0001☆藍☆「おはよう」\n');
  assert.equal(p.paras[0].lineIndices.trans, null, '这一段没有译文行');
  assert.equal(transEditRange(p.paras[0], p.lines[0].text), null);
});

/* ---------------- 区域判定 ---------------- */

test('lockedZoneAt：原文行整行、译文行分前缀/正文/后缀', () => {
  const p = P(TXT);
  const transLine = p.lines[1].text; // ★0001★蓝★「早上好」

  assert.equal(lockedZoneAt(p, 0, 3, p.lines[0].text), 'orig');
  assert.equal(lockedZoneAt(p, 1, 0, transLine), 'trans-prefix', '★ 开头');
  assert.equal(lockedZoneAt(p, 1, 7, transLine), 'trans-prefix', '前缀末列');
  assert.equal(lockedZoneAt(p, 1, 9, transLine), null, '正文起点可编辑');
  assert.equal(lockedZoneAt(p, 1, 11, transLine), null, '正文可编辑');
  assert.equal(lockedZoneAt(p, 1, 13, transLine), 'trans-suffix', '」之后');
  assert.equal(lockedZoneAt(p, 3, 2, p.lines[3].text), 'orig');
});

test('lockedZoneAt：空行不设限', () => {
  const p = P(TXT);
  assert.equal(lockedZoneAt(p, 2, 0, ''), null);
});

/* ---------------- 按操作判定 ---------------- */

test('blockStateAt：输入/退格/删除按边界分别判定', () => {
  const p = P(TXT);
  const line = p.lines[1].text; // 正文 [9,12]

  assert.deepEqual(blockStateAt(p, 1, 5, line),
    { editBlocked: true, blockBackspace: true, blockDelete: true }, '前缀上三种全拦');
  assert.deepEqual(blockStateAt(p, 1, 10, line),
    { editBlocked: false, blockBackspace: false, blockDelete: false }, '正文内部全放行');
  assert.deepEqual(blockStateAt(p, 1, 9, line),
    { editBlocked: false, blockBackspace: true, blockDelete: false }, '正文起点：可输入但退格会吃掉「');
  assert.deepEqual(blockStateAt(p, 1, 12, line),
    { editBlocked: false, blockBackspace: false, blockDelete: true }, '正文终点：可输入但删除会吃掉」');
});

test('blockStateAt：原文行三种全拦', () => {
  const p = P(TXT);
  const st = blockStateAt(p, 0, 0, p.lines[0].text);
  assert.equal(st.editBlocked, true);
  assert.equal(st.blockBackspace, true);
  assert.equal(st.blockDelete, true);
});

test('blockStateAt：空注释行与空行不设限', () => {
  const p = P('#NOTTRANS\n☆0001☆A☆「あ」\n★0001★甲★「啊」\n\n');
  assert.equal(blockStateAt(p, 0, 2, '#NOTTRANS').editBlocked, false);
  assert.equal(blockStateAt(p, 3, 0, '').editBlocked, false);
});

test('blockStateAt：空译文行可输入但退格被拦（不能吃掉前缀）', () => {
  const p = P(TXT);
  const line = p.lines[7].text; // ★0003★★
  const st = blockStateAt(p, 7, line.length, line);
  assert.equal(st.editBlocked, false, '可以在空译文里输入');
  assert.equal(st.blockBackspace, true, '但退格会吃掉 ★');
});

/* ---------------- 选区 ---------------- */

test('selectionTouchesLocked：只在正文内的选区放行', () => {
  const p = P(TXT);
  const lineOf = (i) => p.lines[i].text;
  assert.equal(selectionTouchesLocked(p, { startLine: 1, startChar: 9, endLine: 1, endChar: 12 }, lineOf),
    false, '正文内');
  assert.equal(selectionTouchesLocked(p, { startLine: 1, startChar: 8, endLine: 1, endChar: 12 }, lineOf),
    true, '含「');
  assert.equal(selectionTouchesLocked(p, { startLine: 1, startChar: 9, endLine: 1, endChar: 13 }, lineOf),
    true, '含」');
  assert.equal(selectionTouchesLocked(p, { startLine: 0, startChar: 0, endLine: 1, endChar: 5 }, lineOf),
    true, '跨到原文行');
});

test('selectionTouchesLocked：反向选区也能判定', () => {
  const p = P(TXT);
  const lineOf = (i) => p.lines[i].text;
  assert.equal(selectionTouchesLocked(p, { startLine: 1, startChar: 5, endLine: 0, endChar: 0 }, lineOf), true);
});

test('selectionTouchesLocked：只覆盖空行时放行', () => {
  const p = P(TXT);
  const lineOf = (i) => p.lines[i].text;
  assert.equal(selectionTouchesLocked(p, { startLine: 2, startChar: 0, endLine: 2, endChar: 0 }, lineOf), false);
});

test('blockStateForSelection：碰到锁定区就三种全拦', () => {
  const p = P(TXT);
  const lineOf = (i) => p.lines[i].text;
  assert.deepEqual(
    blockStateForSelection(p, { startLine: 1, startChar: 9, endLine: 1, endChar: 12 }, lineOf),
    { editBlocked: false, blockBackspace: false, blockDelete: false },
  );
  assert.deepEqual(
    blockStateForSelection(p, { startLine: 0, startChar: 0, endLine: 1, endChar: 12 }, lineOf),
    { editBlocked: true, blockBackspace: true, blockDelete: true },
  );
});
