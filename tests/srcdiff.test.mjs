// srcdiff.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/srcdiff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffSourcePair } from '../src/srcdiff.js';

/** 三片拼接必须还原原串（差异区间的基本不变量） */
function assertAssembles(a, b){
  const d = diffSourcePair(a, b);
  assert.equal(d.prefix + d.aMid + d.suffix, a, '当前原句可还原');
  assert.equal(d.prefix + d.bMid + d.suffix, b, '记忆原文可还原');
  return d;
}

test('diffSourcePair: 只差否定词 → 变动区间落在否定部分内', () => {
  const d = assertAssembles('今日は行きます', '今日は行きません');
  // 公共前缀吸收到「ま」，变动区间即「す → せん」—— 比整句对照小得多，足够看清差异
  assert.equal(d.prefix, '今日は行きま');
  assert.equal(d.aMid, 'す');
  assert.equal(d.bMid, 'せん');
  assert.equal(d.suffix, '');
  assert.equal(d.changed, true);
});

test('diffSourcePair: 只差数字 → 数字落在变动区间', () => {
  const d = assertAssembles('残り3人だ', '残り5人だ');
  assert.equal(d.aMid, '3');
  assert.equal(d.bMid, '5');
  assert.equal(d.prefix, '残り');
  assert.equal(d.suffix, '人だ');
});

test('diffSourcePair: 只差称呼（句中替换）', () => {
  const d = assertAssembles('おはよう、アリス', 'おはよう、ボブ');
  assert.equal(d.prefix, 'おはよう、');
  assert.equal(d.aMid, 'アリス');
  assert.equal(d.bMid, 'ボブ');
  assert.equal(d.suffix, '');
});

test('diffSourcePair: 完全相同 → changed=false 且无变动区间', () => {
  const d = diffSourcePair('「おはよう」', '「おはよう」');
  assert.equal(d.changed, false);
  assert.equal(d.aMid, '');
  assert.equal(d.bMid, '');
  assert.equal(d.prefix + d.suffix, '「おはよう」');
});

test('diffSourcePair: 追加/删除（一侧为另一侧子串）→ 空的 mid 如实反映', () => {
  const add = assertAssembles('おはよう', 'おはようございます');
  assert.equal(add.aMid, '');
  assert.equal(add.bMid, 'ございます');
  const del = assertAssembles('おはようございます', 'おはよう');
  assert.equal(del.aMid, 'ございます');
  assert.equal(del.bMid, '');
});

test('diffSourcePair: 空串容错', () => {
  const empty = diffSourcePair('', 'おはよう');
  assert.equal(empty.aMid, '');
  assert.equal(empty.bMid, 'おはよう');
  assert.deepEqual(diffSourcePair('', ''), { prefix: '', suffix: '', aMid: '', bMid: '', changed: false });
  assert.doesNotThrow(() => diffSourcePair(null, undefined));
});

test('diffSourcePair: 代理对（emoji）不被劈开', () => {
  const d = assertAssembles('そうですね😀', 'そうですね😭');
  assert.equal(d.aMid, '😀');
  assert.equal(d.bMid, '😭');
  assert.equal(d.prefix, 'そうですね');
  // 任一 mid 都不能含孤立代理
  for (const mid of [d.aMid, d.bMid]){
    for (let i = 0; i < mid.length; i++){
      const c = mid.charCodeAt(i);
      if (c >= 0xDC00 && c <= 0xDFFF){
        assert.ok(i > 0 && mid.charCodeAt(i - 1) >= 0xD800 && mid.charCodeAt(i - 1) <= 0xDBFF, '代理对必须完整');
      }
    }
  }
});

test('diffSourcePair: 完全不同的句子区间为整串（不假装相似）', () => {
  const d = assertAssembles('こんにちは', 'さようなら');
  assert.equal(d.aMid, 'こんにちは');
  assert.equal(d.bMid, 'さようなら');
  assert.equal(d.prefix, '');
  assert.equal(d.suffix, '');
});

test('diffSourcePair: 标点与特殊字符（< > &）按字面比较', () => {
  const d = assertAssembles('a<b>&c', 'a<b>c');
  assert.equal(d.aMid, '&');
  assert.equal(d.bMid, '');
});
