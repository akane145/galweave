// worker 协议与 debounce 单元测试 — node:test + node:assert, 纯逻辑不依赖 DOM
// 运行: node --test tests/worker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { debounce, throttle } from '../src/debounce.js';
import { handleMessage } from '../src/workers/search.worker.js';
import { handleMessage as recogHandle } from '../src/workers/recognize.worker.js';
import { replaceAllInParasDeltas } from '../src/search-remote.js';
import { computeMatches } from '../src/search.js';

/* ---------------- debounce / throttle ---------------- */

test('debounce: 连续调用只执行最后一次,停顿后触发', async () => {
  const calls = [];
  const fn = debounce((x) => calls.push(x), 30);
  fn(1); fn(2); fn(3);
  assert.deepEqual(calls, [], 'wait 内不执行');
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(calls, [3], '只执行最后一次');
});

test('debounce: cancel 取消尚未触发的调用', async () => {
  const calls = [];
  const fn = debounce((x) => calls.push(x), 30);
  fn('a');
  fn.cancel();
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(calls, []);
  assert.equal(fn.pending(), false);
});

test('debounce: flush 立即执行末次调用', () => {
  const calls = [];
  const fn = debounce((x) => calls.push(x), 100);
  fn(1); fn(2);
  assert.equal(fn.pending(), true);
  fn.flush();
  assert.deepEqual(calls, [2]);
  assert.equal(fn.pending(), false);
});

test('throttle: 首次立即触发,后续在 wait 内静默', async () => {
  const calls = [];
  const fn = throttle((x) => calls.push(x), 40);
  fn(1); // 立即
  assert.deepEqual(calls, [1]);
  fn(2); fn(3); // wait 内静默
  assert.deepEqual(calls, [1]);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(calls, [1, 3], 'wait 后补末次');
});

/* ---------------- search worker 消息协议 ---------------- */

test('search worker: sync(full) → computeMatches 命中', () => {
  const full = [
    { content: '食べる', translation: '吃', nameTr: '', isName: false, id: '0' },
    { content: '花火', translation: '', nameTr: '', isName: false, id: '1' },
  ];
  handleMessage({ type: 'sync', delta: { full } });
  const matches = handleMessage({ type: 'computeMatches', q: '花火', scope: 'all', cs: false });
  assert.ok(Array.isArray(matches));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].i, 1);
  assert.equal(matches[0].col, 'orig');
});

test('search worker: delta(增量) → 更新影子后再查询', () => {
  const full = [{ content: 'a', translation: '', nameTr: '', isName: false, id: '0' }];
  handleMessage({ type: 'sync', delta: { full } });
  handleMessage({ type: 'sync', delta: { changes: [{ i: 0, translation: 'aX' }] } });
  const matches = handleMessage({ type: 'computeMatches', q: 'aX', scope: 'trans', cs: false });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].col, 'trans');
});

test('search worker: countMatches 与 replaceAllInParas 返回 deltas', () => {
  const full = [
    { content: '魔法少女', translation: '魔法少女翻完了', nameTr: '', isName: false, id: '0' },
    { content: 'x', translation: '魔法', nameTr: '', isName: false, id: '1' },
  ];
  handleMessage({ type: 'sync', delta: { full } });
  const c = handleMessage({ type: 'countMatches', q: '魔法', scope: 'trans', cs: false });
  assert.ok(c.total >= 1, 'countMatches 返回非零 total');

  const r = handleMessage({ type: 'replaceAllInParas', q: '魔法', rep: '魔法!', scope: 'trans', cs: false });
  assert.ok(r.deltas && r.deltas.length >= 1, '返回 deltas 数组');
  assert.ok(typeof r.total === 'number');
  // deltas 不应原地改 model(核对: 再 computeMatches 一次,翻完项已被替换)
  const again = handleMessage({ type: 'computeMatches', q: '魔法!', scope: 'trans', cs: false });
  assert.ok(again.length >= 1, '替换后新值可命中');
});

test('search worker: jumpToIndex 按数字/编号定位', () => {
  const full = [
    { content: 'a', translation: '', nameTr: '', isName: false, id: 'TEXT|0' },
    { content: 'b', translation: '', nameTr: '', isName: false, id: 'TEXT|11' },
  ];
  handleMessage({ type: 'sync', delta: { full } });
  assert.equal(handleMessage({ type: 'jumpToIndex', v: '11' }), 1);
  assert.equal(handleMessage({ type: 'jumpToIndex', v: 'TEXT|11' }), 1);
  assert.equal(handleMessage({ type: 'jumpToIndex', v: '不存在' }), -1);
});

/* ---------------- recognize worker 消息协议 ---------------- */

test('recognize worker: detect 接受 ☆/★ 文本返回 profile', () => {
  const text = '☆0000☆☆判断基準は面白さ\n★0000☆☆判断标准是有趣\n\n';
  const p = recogHandle({ type: 'detect', text, file: 'x.txt' });
  assert.ok(p && typeof p === 'object');
  assert.ok(p.marks || (p.structure && p.structure.lineKinds), 'profile 含结构信息');
});

test('recognize worker: analyzeWithParsers 对自洽文本返回结构化结果', () => {
  const text = '☆0000☆☆判断基準は面笑さ\n★0000☆☆判断标准是有趣\n\n';
  const r = recogHandle({ type: 'analyzeWithParsers', text, config: { open: '☆', close: '★', regex: '' }, label: 't' });
  assert.ok(typeof r === 'object' && r !== null);
  assert.ok('paras' in r && 'withId' in r && 'named' in r);
  assert.ok('roundTrip' in r);
});

/* ---------------- search-remote 与 search.js 行为一致 ---------------- */

test('replaceAllInParasDeltas: 全替换等价于原地替换的 translation,且不破坏原数组', async () => {
  const parasA = [{ content: 'a', translation: '魔法少女', nameTr: '', isName: false, id: '0' }];
  const parasB = [{ content: 'a', translation: '魔法少女', nameTr: '', isName: false, id: '0' }];
  const r = replaceAllInParasDeltas(parasA, '魔', 'm', 'trans', false);
  const s = await import('../src/search.js');
  s.replaceAllInParas(parasB, '魔', 'm', 'trans', false);
  assert.equal(r.deltas[0].translation, parasB[0].translation);
  assert.equal(parasA[0].translation, '魔法少女', '非破坏: 原地未被修改');
});