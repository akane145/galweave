// tm.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/tm.test.mjs
// 注：只测纯逻辑（规范化 / 相似度 / 查询 / 收割 / 裁剪），不碰 loadTm/saveTm（依赖 Tauri/IDB）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TM_VERSION, TM_SIMILARITY, TM_LIMIT, TM_MIN_SRC_LEN,
  normalizeSource, similarity, emptyTm, normalizeTm, pruneTm, tmSize,
  addEntry, findExact, findSimilar, collectFromParas, suggestLabel,
} from '../src/tm.js';

/* ---------------- 规范化 ---------------- */

test('normalizeSource: 压缩空白 + 剥引号 + 去尾标点', () => {
  assert.equal(normalizeSource('  こんにちは  '), 'こんにちは');
  assert.equal(normalizeSource('「おはよう」'), 'おはよう');
  assert.equal(normalizeSource('『やあ』'), 'やあ');
  assert.equal(normalizeSource('「「二重」」'), '二重');
  assert.equal(normalizeSource('元気ですか？'), '元気ですか');
  assert.equal(normalizeSource('そうか。'), 'そうか');
  assert.equal(normalizeSource('まさか…'), 'まさか');
  assert.equal(normalizeSource('あ\u3000い'), 'あ い');   // 全角空格也压缩
});

test('normalizeSource: 有意不折叠全半角与内部标点（避免把不同句子并成一条）', () => {
  assert.notEqual(normalizeSource('Sakura'), normalizeSource('ｓａｋｕｒａ'));
  assert.notEqual(normalizeSource('はい、そうです'), normalizeSource('はい そうです'));
});

test('normalizeSource: 空/非字符串安全', () => {
  assert.equal(normalizeSource(''), '');
  assert.equal(normalizeSource(null), '');
  assert.equal(normalizeSource(undefined), '');
  assert.equal(normalizeSource('「」'), '');
});

/* ---------------- 相似度 ---------------- */

test('similarity: 相等为 1（规范化后相等也算），空串为 0', () => {
  assert.equal(similarity('おはよう', 'おはよう'), 1);
  assert.equal(similarity('「おはよう」', 'おはよう。'), 1);   // 规范化后相等
  assert.equal(similarity('', 'あ'), 0);
  assert.equal(similarity(null, undefined), 0);
});

test('similarity: 高度相似但不相同 —— 落在 (0,1) 且高于阈值', () => {
  const s = similarity('おはよう、いい天気ですね', 'おはよう、いい天気だね');
  assert.ok(s > 0.5 && s < 1, `期望 (0,1)，实得 ${s}`);
});

test('similarity: 无关句子显著低于默认阈值', () => {
  assert.ok(similarity('おはよう', '図書館に行きます') < TM_SIMILARITY);
});

test('similarity: 单字句退化路径不抛错', () => {
  assert.equal(similarity('あ', 'あ'), 1);
  assert.equal(similarity('あ', 'い'), 0);
  assert.ok(similarity('あ', 'あい') >= 0);
});

/* ---------------- 入库 / 查询 ---------------- */

test('addEntry: 新键入库；同键覆盖并提前', () => {
  let tm = emptyTm();
  tm = addEntry(tm, 'おはよう', '早上好', 1);
  tm = addEntry(tm, 'こんばんは', '晚上好', 2);
  assert.equal(tmSize(tm), 2);
  assert.equal(tm.entries[0].dst, '晚上好');   // 最新在前

  tm = addEntry(tm, '「おはよう」', '早安', 3);   // 规范化后同键 → 覆盖
  assert.equal(tmSize(tm), 2);
  assert.equal(findExact(tm, 'おはよう').dst, '早安');
  assert.equal(tm.entries[0].key, 'おはよう');
});

test('addEntry: 空源/空译/过短源一律拒收', () => {
  let tm = emptyTm();
  tm = addEntry(tm, '', '译文', 1);
  tm = addEntry(tm, 'おはよう', '', 1);
  tm = addEntry(tm, 'あ', '啊', 1);            // 短于 TM_MIN_SRC_LEN
  assert.equal(tmSize(tm), 0);
  assert.equal(TM_MIN_SRC_LEN, 2);
});

test('findExact: 按规范键命中，未命中返回 null', () => {
  const tm = addEntry(emptyTm(), '今日はいい天気ですね', '今天天气真好', 1);
  assert.equal(findExact(tm, '今日はいい天気ですね').dst, '今天天气真好');
  assert.equal(findExact(tm, '「今日はいい天気ですね。」').dst, '今天天气真好');
  assert.equal(findExact(tm, '違う文'), null);
  assert.equal(findExact(null, 'x'), null);
  assert.equal(findExact(tm, ''), null);
});

test('findSimilar: 排除精确命中，按分数降序，阈值与条数可调', () => {
  let tm = emptyTm();
  tm = addEntry(tm, 'おはよう、いい天気ですね', '早上好，天气真好', 1);
  tm = addEntry(tm, 'こんにちは、いい天気ですね', '你好，天气真好', 2);
  tm = addEntry(tm, 'まったく関係ない文章です', '完全无关的句子', 3);

  const hits = findSimilar(tm, 'おはよう、いい天気だね', { limit: 5 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].entry.key, 'おはよう、いい天気ですね');
  assert.ok(hits[0].score >= TM_SIMILARITY);

  // 精确命中默认被排除
  assert.equal(findSimilar(tm, 'おはよう、いい天気ですね').some(h => h.entry.key === 'おはよう、いい天気ですね'), false);
  // excludeExact:false 时把它算进来（score = 1 排最前）
  const withExact = findSimilar(tm, 'おはよう、いい天気ですね', { excludeExact: false });
  assert.equal(withExact[0].score, 1);

  // 阈值拉满 → 只剩精确那条（且被排除）
  assert.equal(findSimilar(tm, 'おはよう、いい天気だね', { threshold: 1 }).length, 0);
  // limit 生效
  assert.ok(findSimilar(tm, 'おはよう、いい天気ですね', { threshold: 0, excludeExact: false, limit: 1 }).length === 1);
});

/* ---------------- 收割 ---------------- */

test('collectFromParas: 收非 NAME、有译文的行；剥掉外层「」', () => {
  const paras = [
    { isName: false, brackets: false, content: 'おはよう', translation: '早上好' },
    { isName: true, name: 'アリス', nameTr: '爱丽丝', content: 'アリス', translation: '' },
    { isName: false, brackets: true, content: 'やあ', translation: '「呀」' },
    { isName: false, brackets: false, content: '未訳', translation: '' },
    { isName: false, brackets: false, content: 'あ', translation: '啊' },   // 源过短
  ];
  const { tm, added } = collectFromParas(paras, emptyTm(), 100);
  assert.equal(added, 2);
  assert.equal(tmSize(tm), 2);
  assert.equal(findExact(tm, 'おはよう').dst, '早上好');
  assert.equal(findExact(tm, 'やあ').dst, '呀');       // 括号已剥
});

test('collectFromParas: 镜像格式预填的原文占位不入库（避免「原文→原文」脏记忆）', () => {
  const paras = [
    // 未翻译的镜像行: 译文栏预填原文
    { isName: false, brackets: false, content: 'おはよう', translation: 'おはよう', mirror: {} },
    { isName: false, brackets: false, content: 'やあ', translation: '呀' },
  ];
  const { tm, added } = collectFromParas(paras, emptyTm(), 100);
  assert.equal(added, 1, '占位行被跳过');
  assert.equal(findExact(tm, 'おはよう'), null);
  assert.equal(findExact(tm, 'やあ').dst, '呀');
});

test('collectFromParas: 重复收割同一句且译文未变 → added 为 0（幂等）', () => {
  const paras = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好' }];
  const first = collectFromParas(paras, emptyTm(), 100);
  assert.equal(first.added, 1);
  const second = collectFromParas(paras, first.tm, 200);
  assert.equal(second.added, 0);
  assert.equal(tmSize(second.tm), 1);

  // 译文改了 → 重新计入并覆盖
  const changed = collectFromParas([{ isName: false, brackets: false, content: 'おはよう', translation: '早安' }], first.tm, 300);
  assert.equal(changed.added, 1);
  assert.equal(findExact(changed.tm, 'おはよう').dst, '早安');
});

/* ---------------- 裁剪 / 读回兜底 ---------------- */

test('normalizeTm: 丢弃坏数据、按 key 去重、版本号固定', () => {
  const tm = normalizeTm({
    version: 99,
    entries: [
      { src: 'おはよう', dst: '早上好', at: 1 },
      null,
      { src: '', dst: 'x' },
      { src: 'やあ', dst: '' },
      { src: '「おはよう。」', dst: '早安', at: 5 },   // 与第一条同键 → 后者被丢弃
      { src: 'こんばんは', dst: '晚上好', at: 3 },
    ],
  });
  assert.equal(tm.version, TM_VERSION);
  assert.equal(tmSize(tm), 2);
  assert.deepEqual(tm.entries.map(e => e.key).sort(), ['おはよう', 'こんばんは'].sort());
});

test('normalizeTm: 非对象 / 非数组安全', () => {
  assert.equal(tmSize(normalizeTm(null)), 0);
  assert.equal(tmSize(normalizeTm('x')), 0);
  assert.equal(tmSize(normalizeTm({ entries: 'x' })), 0);
});

test('pruneTm: 超限按 at 降序裁剪，不超限不改顺序', () => {
  const entries = [
    { key: 'a', src: 'あ', dst: 'A', at: 1 },
    { key: 'b', src: 'い', dst: 'B', at: 3 },
    { key: 'c', src: 'う', dst: 'C', at: 2 },
  ];
  const pruned = pruneTm({ version: 1, entries }, 2);
  assert.deepEqual(pruned.entries.map(e => e.key), ['b', 'c']);

  const kept = pruneTm({ version: 1, entries }, 10);
  assert.deepEqual(kept.entries.map(e => e.key), ['a', 'b', 'c']);
  assert.equal(TM_LIMIT, 20000);
});

test('suggestLabel: 压缩空白并截断', () => {
  assert.equal(suggestLabel('早上好'), '早上好');
  assert.equal(suggestLabel('  早\n上好  '), '早 上好');
  assert.equal(suggestLabel('一二三四五六', 3), '一二三…');
  assert.equal(suggestLabel(null), '');
});
