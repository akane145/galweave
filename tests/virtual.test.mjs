// 虚拟滚动高度模型单元测试 — node:test + node:assert, 纯逻辑不依赖 DOM
// 运行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRowHeightModel } from '../src/virtuallist.js';

/* ---------------- 基础: 估算 / 前缀和 / 定位 ---------------- */

test('空模型: total 0, 范围空, 定位安全', () => {
  const m = createRowHeightModel(0);
  assert.equal(m.count, 0);
  assert.equal(m.total(), 0);
  assert.equal(m.offsetOf(0), 0);
  assert.equal(m.offsetOf(100), 0);
  assert.equal(m.indexAt(0), 0);
  assert.equal(m.indexAt(999), 0);
  assert.deepEqual(m.visibleRange(0, 500, 10), { start: 0, end: 0 });
});

test('全部估算: total / offsetOf / indexAt 按估算高度计算', () => {
  const m = createRowHeightModel(10, { estimate: 100 });
  assert.equal(m.total(), 1000);
  assert.equal(m.offsetOf(0), 0);
  assert.equal(m.offsetOf(3), 300);
  assert.equal(m.offsetOf(10), 1000, '越界夹取到 total');
  assert.equal(m.indexAt(0), 0);
  assert.equal(m.indexAt(99), 0);
  assert.equal(m.indexAt(100), 1);
  assert.equal(m.indexAt(350), 3);
  assert.equal(m.indexAt(1000), 10, 'offset >= total 返回 n');
  assert.equal(m.indexAt(5000), 10);
});

test('setMeasured 替换估算: total 与 offsetOf 相应变化', () => {
  const m = createRowHeightModel(5, { estimate: 100 });
  m.setMeasured(2, 300);
  assert.equal(m.total(), 100 * 4 + 300);
  assert.equal(m.offsetOf(2), 200, '实测行自身顶部不受影响');
  assert.equal(m.offsetOf(3), 500);
  assert.equal(m.heightOf(2), 300);
  assert.equal(m.measuredCount(), 1);
  assert.equal(m.avgMeasured(), 300);
});

test('setEstimate 只影响未实测行', () => {
  const m = createRowHeightModel(4, { estimate: 100 });
  m.setMeasured(1, 250);
  m.setEstimate(50);
  assert.equal(m.heightOf(0), 50);
  assert.equal(m.heightOf(1), 250);
  assert.equal(m.total(), 50 + 250 + 50 + 50);
});

test('clearMeasured 回退估算; reset 清空一切', () => {
  const m = createRowHeightModel(4, { estimate: 100 });
  m.setMeasured(1, 250);
  m.setHidden(2, true);
  m.clearMeasured();
  assert.equal(m.total(), 100 * 3, '隐藏行仍为 0');
  m.setHidden(2, false);
  assert.equal(m.total(), 400);
  m.setMeasured(0, 80);
  m.reset(2);
  assert.equal(m.count, 2);
  assert.equal(m.measuredCount(), 0);
  assert.equal(m.isHidden(2), false);
  assert.equal(m.total(), 200, 'reset 后沿用当前估算值');
});

/* ---------------- 隐藏行(校对过滤) ---------------- */

test('隐藏行高度记 0 且被 indexAt 跳过', () => {
  const m = createRowHeightModel(5, { estimate: 100 });
  m.setHidden(1, true);
  m.setHidden(2, true);
  assert.equal(m.total(), 300);
  assert.equal(m.offsetOf(1), 100);
  assert.equal(m.offsetOf(3), 100, '隐藏行不占高度');
  // offset=100 同时是行1(隐藏)/行2(隐藏)/行3 的顶部 → 取第一个可见行 3
  assert.equal(m.indexAt(100), 3);
  assert.equal(m.indexAt(150), 3);
  m.setHidden(1, false);
  assert.equal(m.total(), 400);
  assert.equal(m.indexAt(150), 1);
});

test('visibleRange 不含隐藏行,但下标范围连续覆盖', () => {
  const m = createRowHeightModel(6, { estimate: 100 });
  m.setHidden(2, true);
  // 视口 0-250: 行0、行1 完整,行3(200-300)跨界 → 范围 [0,4),行2隐藏由挂载方跳过
  const r = m.visibleRange(0, 250, 0);
  assert.equal(r.start, 0);
  assert.equal(r.end, 4);
  // 视口 150-250: 行1(100-200)起,行3 跨界 → [1,4)
  const r2 = m.visibleRange(150, 100, 0);
  assert.equal(r2.start, 1);
  assert.equal(r2.end, 4);
});

/* ---------------- 可见范围与缓冲 ---------------- */

test('visibleRange: 基本窗口与底部跨界行', () => {
  const m = createRowHeightModel(10, { estimate: 100 });
  assert.deepEqual(m.visibleRange(0, 200, 0), { start: 0, end: 2 });
  // 250..450: 行2(200-300)/行3/行4(400-500 跨界)
  const r = m.visibleRange(250, 200, 0);
  assert.equal(r.start, 2);
  assert.equal(r.end, 5);
  // 底边正好压在行边界(500 = 行5顶)时行5不算
  const r2 = m.visibleRange(300, 200, 0);
  assert.equal(r2.start, 3);
  assert.equal(r2.end, 5);
});

test('visibleRange: 缓冲按可见行数扩展', () => {
  const m = createRowHeightModel(10, { estimate: 100 });
  assert.deepEqual(m.visibleRange(0, 100, 2), { start: 0, end: 3 });
  const r = m.visibleRange(400, 100, 2);
  assert.equal(r.start, 2);
  assert.equal(r.end, 7, '向后扩 2 个可见行 = 行5、行6');
  // 缓冲越过隐藏行时继续向后找可见行
  m.setHidden(2, true);
  const r2 = m.visibleRange(300, 100, 2);
  assert.equal(r2.start, 1, '向前扩 2 个可见行 = 行3、行1(隐藏的行2 跳过)');
  assert.equal(r2.end, 7, '向后扩 2 个可见行 = 行5、行6');
});

test('visibleRange: 滚动越过末尾/负值安全', () => {
  const m = createRowHeightModel(5, { estimate: 100 });
  const r = m.visibleRange(-50, 200, 0);
  assert.equal(r.start, 0);
  const r2 = m.visibleRange(10000, 200, 3);
  assert.ok(r2.end <= 5);
  assert.ok(r2.start <= r2.end);
});

/* ---------------- 一致性性质 ---------------- */

test('性质: offsetOf(i)+heightOf(i) == offsetOf(i+1); indexAt(offsetOf(i)) 回到 i', () => {
  const m = createRowHeightModel(200, { estimate: 73 });
  // 撒一些实测与隐藏
  for (let i = 3; i < 200; i += 7) m.setMeasured(i, 40 + (i % 90));
  for (let i = 5; i < 200; i += 11) m.setHidden(i, true);
  for (let i = 0; i < 200; i++){
    assert.equal(m.offsetOf(i) + m.heightOf(i), m.offsetOf(i + 1));
  }
  for (let i = 0; i < 200; i++){
    if (m.isHidden(i)) continue;
    const at = m.indexAt(m.offsetOf(i));
    // 顶部正好压在前一隐藏行尾部时允许取到下一个可见行,但不得回退到 i 之前
    assert.ok(at === i || (at > i && m.isHidden(i) === false && m.offsetOf(at) === m.offsetOf(i)),
      `indexAt(offsetOf(${i})) = ${at}`);
  }
  // 任意偏移定位到的行都覆盖该偏移(或为越界哨兵)
  for (let off = 0; off < m.total(); off += 37){
    const i = m.indexAt(off);
    if (i < m.count){
      assert.ok(!m.isHidden(i));
      assert.ok(m.offsetOf(i) <= off && off < m.offsetOf(i) + m.heightOf(i));
    }
  }
});
