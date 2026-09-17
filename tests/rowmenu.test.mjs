import test from 'node:test';
import assert from 'node:assert/strict';
import { rowMenuItems, parseRowId, shouldTakeOver } from '../src/rowmenu.js';

const FULL = {
  index: 3,
  isName: false,
  hasTranslation: true,
  proofMode: true,
  canUndo: true,
  mtReady: true,
  tmHit: '早上好',
};

const byAction = (items, action) => items.find(x => x.action === action);

/* ── rowMenuItems ── */

test('rowMenuItems：全能力上下文下所有项都可用', () => {
  const items = rowMenuItems(FULL);
  const actionable = items.filter(x => !x.sep);
  assert.equal(actionable.length, 10);
  for (const it of actionable) {
    assert.equal(it.disabled, false, it.label + ' 不该被禁用');
  }
});

test('rowMenuItems：翻译记忆——有命中时标签带建议、无命中时禁用', () => {
  const hit = byAction(rowMenuItems(FULL), 'applyTm');
  assert.equal(hit.disabled, false);
  assert.equal(hit.label, '套用记忆：早上好');

  const miss = byAction(rowMenuItems({ ...FULL, tmHit: '' }), 'applyTm');
  assert.equal(miss.disabled, true);
  assert.equal(miss.label, '套用翻译记忆');

  // 缺字段（旧调用方）不应崩
  const { tmHit, ...noField } = FULL;
  assert.equal(byAction(rowMenuItems(noField), 'applyTm').disabled, true);
});

test('rowMenuItems：NAME 条目禁用复制原文到译文与机翻', () => {
  const items = rowMenuItems({ ...FULL, isName: true });
  assert.equal(byAction(items, 'copyOrigToTrans').disabled, true);
  assert.equal(byAction(items, 'mtRow').disabled, true);
  // 复制到剪贴板与撤销不受影响
  assert.equal(byAction(items, 'copyOrig').disabled, false);
  assert.equal(byAction(items, 'undo').disabled, false);
});

test('rowMenuItems：无译文时禁用清空', () => {
  const items = rowMenuItems({ ...FULL, hasTranslation: false });
  assert.equal(byAction(items, 'clearRow').disabled, true);
});

test('rowMenuItems：非校对模式禁用校对三项', () => {
  const items = rowMenuItems({ ...FULL, proofMode: false });
  assert.equal(byAction(items, 'proofApprove').disabled, true);
  assert.equal(byAction(items, 'proofIssue').disabled, true);
  assert.equal(byAction(items, 'proofNotes').disabled, true);
});

test('rowMenuItems：机翻未就绪时禁用机翻', () => {
  const items = rowMenuItems({ ...FULL, mtReady: false });
  assert.equal(byAction(items, 'mtRow').disabled, true);
});

test('rowMenuItems：不可撤销时禁用撤销', () => {
  const items = rowMenuItems({ ...FULL, canUndo: false });
  assert.equal(byAction(items, 'undo').disabled, true);
});

test('rowMenuItems：空上下文不抛错且仍返回完整结构', () => {
  const items = rowMenuItems();
  assert.ok(items.length > 0);
  // 全部依赖 ctx 的项应为禁用
  assert.equal(byAction(items, 'mtRow').disabled, true);
  assert.equal(byAction(items, 'clearRow').disabled, true);
  assert.equal(byAction(items, 'undo').disabled, true);
});

test('rowMenuItems：分隔线不首不尾且不连续', () => {
  const items = rowMenuItems(FULL);
  assert.equal(items[0].sep, undefined);
  assert.equal(items[items.length - 1].sep, undefined);
  for (let i = 1; i < items.length; i++) {
    assert.ok(!(items[i].sep && items[i - 1].sep), '不应出现连续分隔线');
  }
});

test('rowMenuItems：每个动作项都带 action 且唯一', () => {
  const items = rowMenuItems(FULL).filter(x => !x.sep);
  const actions = items.map(x => x.action);
  assert.ok(actions.every(Boolean), '每项都要有 action');
  assert.equal(new Set(actions).size, actions.length, 'action 必须唯一');
});

/* ── parseRowId ── */

test('parseRowId：解析合法行 id', () => {
  assert.equal(parseRowId('para-0'), 0);
  assert.equal(parseRowId('para-12'), 12);
  assert.equal(parseRowId('para-9999'), 9999);
});

test('parseRowId：非法输入返回 -1', () => {
  assert.equal(parseRowId('para-'), -1);
  assert.equal(parseRowId('para-abc'), -1);
  assert.equal(parseRowId('row-3'), -1);
  assert.equal(parseRowId('para-3x'), -1);
  assert.equal(parseRowId(''), -1);
  assert.equal(parseRowId(null), -1);
  assert.equal(parseRowId(undefined), -1);
  assert.equal(parseRowId(3), -1);
});

test('parseRowId：不接受负号', () => {
  assert.equal(parseRowId('para--1'), -1);
});

/* ── shouldTakeOver ── */

test('shouldTakeOver：表单元素上让位给原生菜单', () => {
  assert.equal(shouldTakeOver({ isFormField: true, rowIndex: 3 }), false);
});

test('shouldTakeOver：行内非表单区域接管', () => {
  assert.equal(shouldTakeOver({ isFormField: false, rowIndex: 0 }), true);
  assert.equal(shouldTakeOver({ isFormField: false, rowIndex: 42 }), true);
});

test('shouldTakeOver：不在任何行内则不接管', () => {
  assert.equal(shouldTakeOver({ isFormField: false, rowIndex: -1 }), false);
});

test('shouldTakeOver：空输入不抛错', () => {
  assert.equal(shouldTakeOver(), false);
  assert.equal(shouldTakeOver({}), false);
});
