// tabdock.js 标签注册表测试 — node:test + node:assert
// 运行: node --test tests/tabdock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as tb from '../src/tabdock.js';

function fresh(){
  // 重置模块内部状态: 通过重新导入不可行,这里直接提供隔离——用 tb 提供的 API 无法清空,
  // 因此每个测试用不同路径避免相互影响,并测试相对自洽的序列。
  return null;
}

test('open: 同路径聚焦已有标签,不新建重复', () => {
  const k1 = tb.open('/a/b.txt', 'b.txt');
  const k2 = tb.open('/a/b.txt', 'b.txt');
  assert.equal(k2, k1, '同文件返回同一 key');
  assert.equal(tb.list().length, 1);
  assert.equal(k1, '/a/b.txt', 'key 保留前导斜杠,仅统一分隔符');
  tb.close(k1);
});

test('docKey: 反斜杠路径规范化', () => {
  assert.equal(tb.docKey('C:\\dir\\a.mdx'), 'C:/dir/a.mdx');
  assert.equal(tb.docKey('C:/dir/a.mdx'), 'C:/dir/a.mdx');
});

test('open 不同文件 → 多个标签,顺序保持', () => {
  const a = tb.open('/x/1.txt', '1.txt');
  const b = tb.open('/x/2.txt', '2.txt');
  const c = tb.open('/x/3.txt', '3.txt');
  assert.deepEqual(tb.list().map(t => t.key), [a, b, c]);
  tb.close(a); tb.close(b); tb.close(c);
});

test('setActive / activeKey', () => {
  const a = tb.open('/y/1.txt', '1.txt');
  const b = tb.open('/y/2.txt', '2.txt');
  assert.equal(tb.setActive(a), true);
  assert.equal(tb.activeKey(), a);
  assert.equal(tb.setActive(b), true);
  assert.equal(tb.activeKey(), b);
  assert.equal(tb.setActive('/不存在'), false, '不存在的 key 拒绝');
  tb.close(a); tb.close(b);
});

test('capture / getSnap: 快照存取;自动补建标签', () => {
  const k = tb.capture('/z/f.txt', { paras: [1, 2] });
  assert.ok(tb.has(k));
  assert.deepEqual(tb.getSnap(k), { paras: [1, 2] });
  tb.capture(k, { paras: [9] });
  assert.deepEqual(tb.getSnap(k), { paras: [9] }, '覆盖写入');
  tb.close(k);
});

test('close: 移除标签;活动被关时 activeKey 置 null', () => {
  const a = tb.open('/w/1.txt', '1.txt');
  const b = tb.open('/w/2.txt', '2.txt');
  tb.setActive(a);
  const removed = tb.close(a);
  assert.ok(removed && removed.key === a);
  assert.equal(tb.has(a), false);
  assert.equal(tb.activeKey(), null, '活动标签被关 → active 置空');
  tb.close(b);
});

test('neighborAfterClose: 活动关后返回相邻 key', () => {
  const a = tb.open('/v/1.txt', '1.txt');
  const b = tb.open('/v/2.txt', '2.txt');
  const c = tb.open('/v/3.txt', '3.txt');
  tb.close(b); // 移除中间项,list 剩 [a, c]
  tb.close(a); // 剩 [c]
  const after = tb.list(); // [{key:c,...}]
  const nb = tb.neighborAfterClose(after, 0);
  assert.equal(nb, c);
  assert.equal(tb.neighborAfterClose([], 0), null);
  tb.close(c);
});
