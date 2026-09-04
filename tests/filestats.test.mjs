import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countStates, segments, ratio, percent, percentText,
  isComplete, hasData, summaryText,
  APPROVED, PENDING, ISSUE,
} from '../src/filestats.js';

// 造段落：done 控制翻译态，st 给 pr.status（不传则该行无 pr 记录）
let seq = 0;
const P = (done, st) => {
  const p = { orig: 'o' + (++seq), done: !!done };
  if (st) p.pr = { status: st, annotations: [] };
  return p;
};

/* ── countStates ── */

test('countStates：空/非法输入返回全零', () => {
  for (const v of [null, undefined, [], 'x', 42]) {
    const c = countStates(v);
    assert.equal(c.total, 0);
    assert.equal(c.done, 0);
    assert.equal(c.hasProof, false);
  }
});

test('countStates：无校对记录时 hasProof=false，全部计入 pending', () => {
  const c = countStates([P(true), P(true), P(false)]);
  assert.equal(c.total, 3);
  assert.equal(c.done, 2);
  assert.equal(c.undone, 1);
  assert.equal(c.hasProof, false);
  assert.equal(c.pending, 3);
  assert.equal(c.approved, 0);
  assert.equal(c.issue, 0);
});

test('countStates：有校对记录时三态分别计数，翻译维度独立', () => {
  const c = countStates([
    P(true, APPROVED), P(true, APPROVED),
    P(true, ISSUE),
    P(true, PENDING),
    P(false),                // 无 pr → pending
  ]);
  assert.equal(c.total, 5);
  assert.equal(c.hasProof, true);
  assert.equal(c.approved, 2);
  assert.equal(c.issue, 1);
  assert.equal(c.pending, 2);
  assert.equal(c.done, 4);
  assert.equal(c.undone, 1);
});

test('countStates：未知状态归入 pending，总数不缩水', () => {
  const c = countStates([P(true, 'whatever'), P(true, APPROVED)]);
  assert.equal(c.pending, 1);
  assert.equal(c.approved, 1);
  assert.equal(c.total, 2);
  assert.equal(c.hasProof, true);
});

test('countStates：数组含 null 不抛错，计为未译+待校对', () => {
  const c = countStates([null, P(true, APPROVED)]);
  assert.equal(c.total, 2);
  assert.equal(c.undone, 1);
  assert.equal(c.pending, 1);
  assert.equal(c.approved, 1);
});

test('countStates：两个维度各自之和恒等于 total（分段条按比例分配的前提）', () => {
  const c = countStates([P(1, APPROVED), P(1, ISSUE), P(0), P(1, PENDING), P(0, ISSUE)]);
  assert.equal(c.approved + c.pending + c.issue, c.total);
  assert.equal(c.done + c.undone, c.total);
});

/* ── segments ── */

test('segments：无校对记录走两段（已译/未译）', () => {
  const segs = segments(countStates([P(true), P(false), P(false)]));
  assert.deepEqual(segs.map(s => s.key), ['done', 'undone']);
  assert.equal(segs[0].count, 1);
  assert.equal(segs[1].count, 2);
  assert.ok(Math.abs(segs[0].ratio - 1 / 3) < 1e-9);
});

test('segments：有校对记录走三段，顺序为 已定稿→待校对→有问题', () => {
  const segs = segments(countStates([P(1, APPROVED), P(1, PENDING), P(1, ISSUE)]));
  assert.deepEqual(segs.map(s => s.key), [APPROVED, PENDING, ISSUE]);
});

test('segments：跳过 count 为 0 的段（空段会白吃 1px gap）', () => {
  const segs = segments(countStates([P(1, APPROVED), P(1, APPROVED)]));
  assert.equal(segs.length, 1);
  assert.equal(segs[0].key, APPROVED);
  assert.equal(segs[0].ratio, 1);
});

test('segments：全部未译时只有一段 undone', () => {
  const segs = segments(countStates([P(false), P(false)]));
  assert.equal(segs.length, 1);
  assert.equal(segs[0].key, 'undone');
});

test('segments：空数据返回空数组', () => {
  assert.deepEqual(segments(countStates([])), []);
  assert.deepEqual(segments(null), []);
});

test('segments：各段 ratio 之和为 1', () => {
  const segs = segments(countStates([P(1, APPROVED), P(1, ISSUE), P(0), P(1, PENDING)]));
  const sum = segs.reduce((a, s) => a + s.ratio, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

/* ── ratio / percent ── */

test('ratio：无校对时以已译为准', () => {
  assert.equal(ratio(countStates([P(true), P(false)])), 0.5);
});

test('ratio：有校对时以已定稿为准（全译完 ≠ 100%）', () => {
  const c = countStates([P(1, APPROVED), P(1, PENDING), P(1, PENDING), P(1, ISSUE)]);
  assert.equal(c.done, 4);        // 四行全部已译
  assert.equal(ratio(c), 0.25);   // 但只有一行定稿
});

test('ratio：空数据为 0', () => {
  assert.equal(ratio(countStates([])), 0);
  assert.equal(ratio(null), 0);
});

test('percent：向下取整，不到 100 绝不显示 100', () => {
  const list = Array.from({ length: 100 }, (_, i) => P(i < 99));
  assert.equal(percent(countStates(list)), 99);
  const big = Array.from({ length: 1000 }, (_, i) => P(i < 999));
  assert.equal(percent(countStates(big)), 99);   // 99.9% 不四舍五入成 100
});

test('percent：真正全完成才是 100', () => {
  assert.equal(percent(countStates([P(true), P(true)])), 100);
});

test('percentText：格式与空数据行为', () => {
  assert.equal(percentText(countStates([P(true), P(false)])), '50%');
  assert.equal(percentText(countStates([])), '');
  assert.equal(percentText(null), '');
});

/* ── isComplete / hasData ── */

test('isComplete：无校对时全部已译即完成', () => {
  assert.equal(isComplete(countStates([P(true), P(true)])), true);
  assert.equal(isComplete(countStates([P(true), P(false)])), false);
});

test('isComplete：有校对时必须全部定稿', () => {
  assert.equal(isComplete(countStates([P(1, APPROVED), P(1, ISSUE)])), false);
  assert.equal(isComplete(countStates([P(1, APPROVED), P(1, APPROVED)])), true);
});

test('isComplete：空文件不算完成', () => {
  assert.equal(isComplete(countStates([])), false);
  assert.equal(isComplete(null), false);
});

test('hasData：只有 total>0 才为真', () => {
  assert.equal(hasData(countStates([P(false)])), true);
  assert.equal(hasData(countStates([])), false);
  assert.equal(hasData(null), false);
});

/* ── summaryText ── */

test('summaryText：两种维度文案不同且含关键数字', () => {
  const plain = summaryText(countStates([P(true), P(false)]));
  assert.ok(plain.includes('已译 1'), plain);
  assert.ok(plain.includes('未译 1'), plain);

  const proofed = summaryText(countStates([P(1, APPROVED), P(1, ISSUE)]));
  assert.ok(proofed.includes('已定稿 1'), proofed);
  assert.ok(proofed.includes('有问题 1'), proofed);
});

test('summaryText：空数据给出可读兜底', () => {
  assert.equal(summaryText(countStates([])), '暂无内容');
});
