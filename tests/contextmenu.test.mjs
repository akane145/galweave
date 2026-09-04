import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItems, menuPosition } from '../src/contextmenu.js';

const item = (label, extra = {}) => ({ label, ...extra });
const sep = { sep: true };

test('normalizeItems：过滤掉 falsy 与无 label 的项', () => {
  const out = normalizeItems([item('复制原文'), null, undefined, { hint: 'x' }, item('粘贴')]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(i => i.label), ['复制原文', '粘贴']);
});

test('normalizeItems：合并连续分隔线，只保留一个', () => {
  const out = normalizeItems([item('A'), sep, sep, sep, item('B')]);
  assert.deepEqual(out.map(i => (i.sep ? '|' : i.label)), ['A', '|', 'B']);
});

test('normalizeItems：去掉首尾分隔线', () => {
  assert.deepEqual(normalizeItems([sep, item('A')]).map(i => i.label), ['A']);
  assert.deepEqual(normalizeItems([item('A'), sep]).map(i => i.label), ['A']);
  assert.deepEqual(normalizeItems([sep, sep, item('A'), sep, sep]).map(i => i.label), ['A']);
});

test('normalizeItems：全部分隔线或空输入返回空数组（空菜单不打开）', () => {
  assert.deepEqual(normalizeItems([sep, sep]), []);
  assert.deepEqual(normalizeItems([]), []);
  assert.deepEqual(normalizeItems(null), []);
  assert.deepEqual(normalizeItems(undefined), []);
});

test('normalizeItems：非数组输入安全降级', () => {
  assert.deepEqual(normalizeItems('nope'), []);
  assert.deepEqual(normalizeItems(42), []);
});

test('menuPosition：不溢出时原样返回', () => {
  assert.deepEqual(menuPosition(10, 20, 100, 50, 800, 600), { left: 10, top: 20 });
});

test('menuPosition：右侧放不下则贴右边界（留 8px 边距）', () => {
  const p = menuPosition(750, 10, 100, 50, 800, 600);
  assert.equal(p.left, 800 - 100 - 8);
  assert.ok(p.left + 100 <= 800 - 8);
});

test('menuPosition：下方放不下则向上翻转', () => {
  const p = menuPosition(10, 580, 100, 50, 800, 600);
  assert.equal(p.top, 580 - 50);
  assert.ok(p.top + 50 <= 600);
});

test('menuPosition：翻转后仍超出上边界则贴下边界', () => {
  // 菜单高 595 / 视口高 600：y=10 时 10+595=605 > 592 触发翻转，
  // 但翻转到 10-595=-585 越界，只能贴下边界 max(8, 600-595-8)=8
  const p = menuPosition(10, 10, 100, 595, 800, 600);
  assert.equal(p.top, 8);
  assert.ok(p.top >= 8);
});

test('menuPosition：能向上翻转时优先翻转而非贴边', () => {
  // 菜单高 300，点击 y=500，视口 600：500+300=800 溢出 → 翻转到 200 可用
  const p = menuPosition(10, 500, 100, 300, 800, 600);
  assert.equal(p.top, 200);
  assert.ok(p.top + 300 <= 600);
});

test('menuPosition：坐标非法时降级为 0，不会产出 NaN', () => {
  const p = menuPosition(NaN, undefined, 100, 50, 800, 600);
  assert.equal(Number.isNaN(p.left), false);
  assert.equal(Number.isNaN(p.top), false);
  assert.equal(p.left, 8);
});

test('menuPosition：菜单尺寸超过视口时仍保证不小于边距', () => {
  const p = menuPosition(700, 500, 900, 900, 800, 600);
  assert.ok(p.left >= 8, `left 应 >= 8，实际 ${p.left}`);
  assert.ok(p.top >= 8, `top 应 >= 8，实际 ${p.top}`);
});
