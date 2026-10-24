import test from 'node:test';
import assert from 'node:assert/strict';

// 词典重复查询修复的回归测试（根因与修复杂点见 docs 与 mdict.rs 注释）：
// 根因 1：MDX 词表同一 key_text 登记多次 → Rust search 返回重复词头 →
//         fuzzyLookup 逐词 lookup 对同一个词重复查询（Rust 已去重，此处测 JS 兜底）。
// 根因 2：变形还原命中与主查询前缀补全合并时同一词头出现两次 → dedupeResults 去重。

import { registerProvider, clearProviders, lookupAllFuzzy, dedupeResults } from '../src/dict.js';

test('fuzzyLookup: search 返回重复词头时，同一个词只 lookup 一次', async () => {
  clearProviders();
  const looked = [];
  registerProvider({
    id: 'test-mdx',
    name: '测试MDX',
    isConfigured(){ return true; },
    // 模拟 MDX 词表重复登记：同一词头出现 3 次
    async search(){ return ['食べる', '食べる', '食べた', '食べる']; },
    async lookup(w){
      looked.push(w);
      return [{ headword: w, reading: '', senses: [{ gloss: 'x' }], source: '测试MDX' }];
    },
  });
  const res = await lookupAllFuzzy('食べ');
  assert.deepEqual(looked, ['食べる', '食べた'], '同一个词头被 lookup 了多次');
  assert.equal(res.results.length, 2, '重复 lookup 导致结果条目重复');
  clearProviders();
});

test('fuzzyLookup: 空词头与非字符串词头被跳过', async () => {
  clearProviders();
  const looked = [];
  registerProvider({
    id: 'test-mdx-edge',
    name: '测试MDX',
    isConfigured(){ return true; },
    async search(){ return ['', '  ', null, '食べる']; },
    async lookup(w){ looked.push(w); return []; },
  });
  await lookupAllFuzzy('食べ');
  assert.deepEqual(looked, ['食べる']);
  clearProviders();
});

test('dedupeResults: 按 (source, headword, reading) 去重，保留首次出现', () => {
  const a = { headword: '食べる', reading: '', source: '甲', senses: [{ gloss: '1' }] };
  const b = { headword: '食べる', reading: '', source: '甲', senses: [{ gloss: 'dup' }] };
  const c = { headword: '食べる', reading: 'たべる', source: '甲', senses: [{ gloss: '2' }] };
  const d = { headword: '食べる', reading: '', source: '乙', senses: [{ gloss: '3' }] };
  const e = { headword: '食べる', reading: '', source: '甲', senses: [{ gloss: '4' }] };
  assert.deepEqual(dedupeResults([a, b, c, d, e]), [a, c, d]);
});

test('dedupeResults: 变形还原命中与主查询前缀补全合并不再重复', () => {
  const hit = { headword: '食べる', reading: '', source: 'MDX', senses: [{ gloss: '吃' }] };
  const prefixCompletion = { headword: '食べる', reading: '', source: 'MDX', senses: [{ gloss: '吃' }] };
  const other = { headword: '食べた', reading: '', source: 'MDX', senses: [{ gloss: 'x' }] };
  const merged = dedupeResults([hit, prefixCompletion, other]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], hit, '应保留变形还原的首次命中');
});

test('dedupeResults: 空入参与脏数据不崩溃', () => {
  assert.deepEqual(dedupeResults([]), []);
  assert.deepEqual(dedupeResults(null), []);
  assert.deepEqual(dedupeResults([null, { headword: 'x', source: 's' }]), [{ headword: 'x', source: 's' }]);
});
