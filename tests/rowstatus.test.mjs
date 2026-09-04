// rowstatus.test.mjs — 单行状态判定(纯逻辑)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowStatusInfo, rowStatusClass, ST_TODO, ST_PENDING, ST_ISSUE, ST_APPROVED } from '../src/rowstatus.js';

test('null / 空段落 → 未翻译', () => {
  assert.deepEqual(rowStatusInfo(null), { key: ST_TODO, glyph: '○', label: '未翻译', cls: ST_TODO });
  assert.deepEqual(rowStatusInfo({}), { key: ST_TODO, glyph: '○', label: '未翻译', cls: ST_TODO });
});

test('未翻译(done=false) → ○ 未翻译', () => {
  const r = rowStatusInfo({ done: false, content: 'x' });
  assert.equal(r.cls, ST_TODO);
  assert.equal(r.glyph, '○');
  assert.equal(r.label, '未翻译');
});

test('已译但无校对记录 → 待校对 ◐', () => {
  const r = rowStatusInfo({ done: true, content: 'x', trans: 'y' });
  assert.equal(r.cls, ST_PENDING);
  assert.equal(r.glyph, '◐');
  assert.equal(r.label, '待校对');
});

test('已译 + 校对 issue → 有问题 ▲', () => {
  const r = rowStatusInfo({ done: true, trans: 'y', pr: { status: 'issue' } });
  assert.equal(r.cls, ST_ISSUE);
  assert.equal(r.glyph, '▲');
  assert.equal(r.label, '有问题');
});

test('已译 + 校对 approved → 已定稿 ✓', () => {
  const r = rowStatusInfo({ done: true, trans: 'y', pr: { status: 'approved' } });
  assert.equal(r.cls, ST_APPROVED);
  assert.equal(r.glyph, '✓');
  assert.equal(r.label, '已定稿');
});

test('pr.status 未知值 → 退回待校对(与 filestats 口径一致)', () => {
  const r = rowStatusInfo({ done: true, trans: 'y', pr: { status: 'weird' } });
  assert.equal(r.cls, ST_PENDING);
});

test('rowStatusClass 仅返回 cls 前缀', () => {
  assert.equal(rowStatusClass({ done: false }), 'rs-' + ST_TODO);
  assert.equal(rowStatusClass({ done: true, pr: { status: 'approved' } }), 'rs-' + ST_APPROVED);
});
