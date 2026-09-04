import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, nextRepeat, composeText } from '../src/toast.js';

test('normalizeMessage：压平所有空白为单空格并去首尾', () => {
  assert.equal(normalizeMessage('  已保存  glossary.json  '), '已保存 glossary.json');
  assert.equal(normalizeMessage('a\nb\tc'), 'a b c');
  assert.equal(normalizeMessage('导入\n失败：\n  格式无法识别'), '导入 失败： 格式无法识别');
});

test('normalizeMessage：空值与非字符串返回空串', () => {
  assert.equal(normalizeMessage(''), '');
  assert.equal(normalizeMessage(null), '');
  assert.equal(normalizeMessage(undefined), '');
  assert.equal(normalizeMessage('   '), '');
});

test('normalizeMessage：超长截断并以省略号收尾，长度不超 max', () => {
  const long = 'あ'.repeat(100);
  const out = normalizeMessage(long, 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('…'));
  // 恰好等于 max 不截断，max+1 才触发
  assert.equal(normalizeMessage('a'.repeat(20), 20), 'a'.repeat(20));
  assert.equal(normalizeMessage('a'.repeat(21), 20).length, 20);
});

test('normalizeMessage：max 非法值时不截断', () => {
  assert.equal(normalizeMessage('a'.repeat(50), 0), 'a'.repeat(50));
  assert.equal(normalizeMessage('a'.repeat(50), -1), 'a'.repeat(50));
  assert.equal(normalizeMessage('a'.repeat(50), NaN), 'a'.repeat(50));
});

test('nextRepeat：连续相同消息递增计数，消息变化重置为 1', () => {
  assert.equal(nextRepeat('已保存', 1, '已保存'), 2);
  assert.equal(nextRepeat('已保存', 2, '已保存'), 3);
  assert.equal(nextRepeat('已保存', 3, '导出完成'), 1);
  assert.equal(nextRepeat('', 1, '首次'), 1);
});

test('nextRepeat：count 为非法值时回退到 2（已经出现过一次才算重复）', () => {
  assert.equal(nextRepeat('已保存', 0, '已保存'), 2);
  assert.equal(nextRepeat('已保存', NaN, '已保存'), 2);
  assert.equal(nextRepeat('已保存', -3, '已保存'), 2);
  assert.equal(nextRepeat('已保存', undefined, '已保存'), 2);
});

test('composeText：次数大于 1 补 ×N 后缀，否则原样', () => {
  assert.equal(composeText('已保存', 1), '已保存');
  assert.equal(composeText('已保存', 2), '已保存 ×2');
  assert.equal(composeText('已保存', 10), '已保存 ×10');
});

test('composeText：count 为非法值时不加后缀', () => {
  assert.equal(composeText('已保存', 0), '已保存');
  assert.equal(composeText('已保存', NaN), '已保存');
  assert.equal(composeText('已保存', undefined), '已保存');
});

test('组合场景：批量操作连发同消息，计数累加而非逐条刷屏', () => {
  const msg = normalizeMessage('已替换 1 处');
  let prev = '';
  let count = 1;
  const seen = [];
  for (let i = 0; i < 5; i++) {
    count = nextRepeat(prev, count, msg);
    prev = msg;
    seen.push(composeText(msg, count));
  }
  assert.deepEqual(seen, [
    '已替换 1 处',
    '已替换 1 处 ×2',
    '已替换 1 处 ×3',
    '已替换 1 处 ×4',
    '已替换 1 处 ×5',
  ]);
});
