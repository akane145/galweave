// width.js 纯逻辑测试 — node:test + node:assert
// 覆盖: 字符宽度分类 / 全角等效宽度 / 阈值四态 / 折行锚点
// 运行: node --test tests/width.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  charWidth, visualWidth, formatWidth,
  widthLevel, formatWidthTitle, normalizeWidthLimit,
  suggestBreak,
  WIDTH_LIMIT_MIN, WIDTH_LIMIT_MAX, WIDTH_LIMIT_DEFAULT,
} from '../src/width.js';

/* ---------------- 字符宽度 ---------------- */

test('charWidth: 全角 = 1（汉字 / 假名 / 全角标点）', () => {
  for (const ch of ['漢', 'あ', 'ア', '，', '。', '「', '」', '？', '！', '：', 'ー']){
    assert.equal(charWidth(ch), 1, ch + ' 应为全角');
  }
});

test('charWidth: 半角 = 0.5（ASCII / 半角片假名）', () => {
  for (const ch of ['A', 'z', '0', ',', '.', '?', '~', ' ']){
    assert.equal(charWidth(ch), 0.5, ch + ' 应为半角');
  }
  // 半角片假名是翻译时"省空间"的常用手段，必须算半个
  assert.equal(charWidth('ｱ'), 0.5);
  assert.equal(charWidth('ﾞ'), 0.5);
});

test('charWidth: 零宽字符不占字位（组合符号 / 变体选择符 / 控制符）', () => {
  assert.equal(charWidth('\u0301'), 0);   // 组合尖音符
  assert.equal(charWidth('\u200B'), 0);   // 零宽空格
  assert.equal(charWidth('\uFE0F'), 0);   // 变体选择符
  assert.equal(charWidth('\t'), 0);       // 控制字符
  assert.equal(charWidth(''), 0);
  assert.equal(charWidth(null), 0);
});

test('visualWidth: 混排累计（全角 1 / 半角 0.5）', () => {
  assert.equal(visualWidth(''), 0);
  assert.equal(visualWidth('AB'), 1);          // 两个半角 = 1 个全角位
  assert.equal(visualWidth('あい'), 2);
  assert.equal(visualWidth('あA'), 1.5);
  assert.equal(visualWidth('こんにちは'), 5);
  assert.equal(visualWidth('「あ」'), 3);
});

test('visualWidth: 增补平面字符按码点计数，不被拆成两半', () => {
  // 代理对：for..of 按码点迭代，不应算成 2 个半角
  assert.equal(visualWidth('𠮷'), 1);        // CJK 扩展 B
  assert.equal(visualWidth('😀'), 1);        // 绘文字
});

test('visualWidth: 非字符串输入安全', () => {
  assert.equal(visualWidth(null), 0);
  assert.equal(visualWidth(undefined), 0);
  assert.equal(visualWidth(123), 1.5);       // 数字转字符串后是 3 个半角
});

test('formatWidth: 整数不留小数点，小数保留一位', () => {
  assert.equal(formatWidth(28), '28');
  assert.equal(formatWidth(28.5), '28.5');
  assert.equal(formatWidth(0), '0');
  assert.equal(formatWidth(NaN), '0');
});

/* ---------------- 阈值 ---------------- */

test('widthLevel: 四段阈值与 bytes.usageLevel 同构（70 / 90 / 100%）', () => {
  assert.equal(widthLevel(20, 30), 'ok');
  assert.equal(widthLevel(21, 30), 'mid');    // 70%
  assert.equal(widthLevel(27, 30), 'near');   // 90%
  assert.equal(widthLevel(30, 30), 'near');   // 正好等于不算超
  assert.equal(widthLevel(31, 30), 'over');
});

test('widthLevel: 未配置上限（0 / 负数 / 非法）一律不报警', () => {
  assert.equal(widthLevel(100, 0), 'ok');
  assert.equal(widthLevel(100, -5), 'ok');
  assert.equal(widthLevel(100, NaN), 'ok');
  assert.equal(widthLevel(100, null), 'ok');
});

test('normalizeWidthLimit: 钳到范围取整，非正数语义为"未配置"', () => {
  assert.equal(normalizeWidthLimit(30), 30);
  assert.equal(normalizeWidthLimit('28'), 28);
  assert.equal(normalizeWidthLimit(28.6), 29);
  assert.equal(normalizeWidthLimit(0), 0);
  assert.equal(normalizeWidthLimit(-1), 0);
  assert.equal(normalizeWidthLimit(NaN), 0);
  assert.equal(normalizeWidthLimit(null), 0);
  assert.equal(normalizeWidthLimit(5), WIDTH_LIMIT_MIN);       // 低于下限 → 钳到下限
  assert.equal(normalizeWidthLimit(9999), WIDTH_LIMIT_MAX);    // 高于上限 → 钳到上限
  assert.equal(WIDTH_LIMIT_DEFAULT, 30);
});

test('formatWidthTitle: 超出时给出差量', () => {
  assert.equal(formatWidthTitle(28, 30), '28 / 30 全角字位');
  assert.equal(formatWidthTitle(33, 30), '33 / 30 全角字位 · 超出 3 个字位');
  assert.equal(formatWidthTitle(30.5, 30), '30.5 / 30 全角字位 · 超出 0.5 个字位');
});

/* ---------------- 折行锚点 ---------------- */

test('suggestBreak: 未超宽返回 null', () => {
  assert.equal(suggestBreak('短句', 30), null);
  assert.equal(suggestBreak('', 30), null);
  assert.equal(suggestBreak('随便什么', 0), null);   // 未配置上限
});

test('suggestBreak: 超宽时在标点之后断开（语义完整优先）', () => {
  const s = 'これは長い文章です、そして続きます';
  const r = suggestBreak(s, 10);
  assert.ok(r, '应给出折行建议');
  assert.equal(r.before + r.after, s, '前后两段拼回原串');
  assert.ok(r.before.endsWith('、'), '断点应落在标点之后，实际: ' + r.before);
});

test('suggestBreak: 标点太靠前时退回按宽度切，不把前半行留得过短', () => {
  // 第 2 个字就是逗号，离上限 10 太远（< 60%）→ 不该采用该标点断点
  const s = 'あ、これはとても長い文章になります';
  const r = suggestBreak(s, 10);
  assert.ok(r);
  assert.ok(visualWidth(r.before) <= 10, '前段不应超过上限');
  assert.ok(visualWidth(r.before) >= 6, '前段不应短得没必要，实际 ' + visualWidth(r.before));
});

test('suggestBreak: 断点前的宽度不超过上限', () => {
  const s = 'あ'.repeat(50);
  const r = suggestBreak(s, 10);
  assert.ok(r);
  assert.ok(visualWidth(r.before) <= 10);
  assert.equal(r.before.length, 10, '纯全角时应正好切 10 个');
});

test('suggestBreak: 半角字符按 0.5 计，能塞进更多', () => {
  const s = 'a'.repeat(40);
  const r = suggestBreak(s, 10);
  assert.ok(r);
  assert.equal(r.before.length, 20, '10 个字位 = 20 个半角字符');
});

test('suggestBreak: 开括号不该留在行尾', () => {
  const s = 'あ'.repeat(9) + '（' + 'い'.repeat(5);
  const r = suggestBreak(s, 10);
  assert.ok(r);
  assert.ok(!r.before.endsWith('（'), '行尾不该是开括号，实际: ' + r.before);
});

test('suggestBreak: at 与实际切分一致（供调用方定位光标/插入点）', () => {
  const s = 'これは長い文章です、そして続きます';
  const r = suggestBreak(s, 10);
  assert.equal(s.slice(0, r.at), r.before);
  assert.equal(s.slice(r.at), r.after);
});
