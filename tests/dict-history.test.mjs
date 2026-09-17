// dict-history.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/dict-history.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_LIMIT, HISTORY_SOURCES, describeHistorySource, normalizeWord,
  makeEntry, pushHistory, normalizeHistory, removeFromHistory,
} from '../src/dict-history.js';

test('normalizeWord: 去空白，null/undefined 安全', () => {
  assert.equal(normalizeWord('  食べる '), '食べる');
  assert.equal(normalizeWord(''), '');
  assert.equal(normalizeWord(null), '');
  assert.equal(normalizeWord(undefined), '');
});

test('describeHistorySource: 已知来源给中文标注，未知回退「输入」', () => {
  assert.equal(describeHistorySource('selection'), '划词');
  assert.equal(describeHistorySource('input'), '输入');
  assert.equal(describeHistorySource('history'), '历史');
  assert.equal(describeHistorySource('啥'), '输入');
  assert.deepEqual(Object.keys(HISTORY_SOURCES), ['selection', 'input', 'history']);
});

test('makeEntry: 空词返回 null（不入历史）；非法来源回退 input', () => {
  assert.equal(makeEntry('', 1, 'selection'), null);
  assert.equal(makeEntry('   ', 1), null);
  assert.equal(makeEntry(null), null);

  const e = makeEntry('  食べる ', 1000, 'selection');
  assert.equal(e.word, '食べる');
  assert.equal(e.at, 1000);
  assert.equal(e.source, 'selection');

  assert.equal(makeEntry('x', 1, '非法').source, 'input');
  assert.ok(makeEntry('x').at > 0);         // at 非法 → 当前时间
});

test('pushHistory: 新词进最前', () => {
  let h = [];
  h = pushHistory(h, makeEntry('あ', 1, 'input'));
  h = pushHistory(h, makeEntry('い', 2, 'input'));
  assert.deepEqual(h.map(x => x.word), ['い', 'あ']);
});

test('pushHistory: 同词去重并提前，保留最新的 at/source', () => {
  let h = [];
  h = pushHistory(h, makeEntry('あ', 1, 'input'));
  h = pushHistory(h, makeEntry('い', 2, 'input'));
  h = pushHistory(h, makeEntry('あ', 3, 'selection'));
  assert.deepEqual(h.map(x => x.word), ['あ', 'い']);
  assert.equal(h[0].at, 3);
  assert.equal(h[0].source, 'selection');
  assert.equal(h.length, 2);
});

test('pushHistory: 大小写折叠 —— Sakura 与 sakura 视为同一个词', () => {
  let h = pushHistory([], makeEntry('Sakura', 1, 'input'));
  h = pushHistory(h, makeEntry('sakura', 2, 'input'));
  assert.equal(h.length, 1);
  assert.equal(h[0].word, 'sakura');   // 保留最新一次输入的写法
});

test('pushHistory: 超过 limit 丢弃最旧；不改原数组', () => {
  const orig = [];
  let h = orig;
  for (let i = 0; i < 5; i++) h = pushHistory(h, makeEntry('w' + i, i, 'input'), 3);
  assert.deepEqual(h.map(x => x.word), ['w4', 'w3', 'w2']);
  assert.deepEqual(orig, [], '原数组不应被修改');

  // entry 为 null / 非法 limit
  assert.deepEqual(pushHistory([{ word: 'a', at: 1, source: 'input' }], null), [{ word: 'a', at: 1, source: 'input' }]);
  const noLimit = pushHistory([], makeEntry('a', 1, 'input'), 0);
  assert.equal(noLimit.length, 1);
});

test('normalizeHistory: 丢弃坏数据、去重、按时间降序', () => {
  const h = normalizeHistory([
    { word: 'あ', at: 1, source: 'input' },
    null,
    { word: '' },
    { word: '  い  ', at: 5, source: 'selection' },
    { word: 'あ', at: 9 },              // 同词重复 → 保留先出现的（去重不提前）
    { nope: 1 },
  ]);
  assert.deepEqual(h.map(x => x.word), ['い', 'あ']);
  assert.equal(h[0].at, 5);
  assert.equal(h[1].at, 1);
});

test('normalizeHistory: 非数组 / 缺 at 也能安全处理', () => {
  assert.deepEqual(normalizeHistory(null), []);
  assert.deepEqual(normalizeHistory('nope'), []);
  const h = normalizeHistory([{ word: 'x' }]);
  assert.equal(h.length, 1);
  assert.ok(h[0].at > 0);
});

test('removeFromHistory: 按比较键删除（大小写折叠），不改原数组', () => {
  const orig = [makeEntry('Sakura', 1, 'input'), makeEntry('い', 2, 'input')];
  const h = removeFromHistory(orig, 'sakura');
  assert.deepEqual(h.map(x => x.word), ['い']);
  assert.equal(orig.length, 2);
  assert.deepEqual(removeFromHistory(null, 'x'), []);
});

test('HISTORY_LIMIT: 100（ROADMAP P2-5 的规定值）', () => {
  assert.equal(HISTORY_LIMIT, 100);
  let h = [];
  for (let i = 0; i < 150; i++) h = pushHistory(h, makeEntry('w' + i, i, 'input'));
  assert.equal(h.length, 100);
  assert.equal(h[0].word, 'w149');
});
