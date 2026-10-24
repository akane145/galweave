// tm.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/tm.test.mjs
// 注：只测纯逻辑（规范化 / 相似度 / 查询 / 收割 / 裁剪 / 审核分级 / 角色变体），
//     不碰 loadTm/saveTm（依赖 Tauri/IDB）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TM_VERSION, TM_SIMILARITY, TM_LIMIT, TM_MIN_SRC_LEN, TM_MAX_VARIANTS, TM_STATUS,
  normalizeSource, similarity, emptyTm, normalizeTm, pruneTm, tmSize,
  addEntry, findExact, findSimilar, collectFromParas, suggestLabel,
  entryId, normalizeStatus, entrySourceLabel, isConfirmed, confirmEntry,
  variantsOf, findConfirmed, suggestLabelWithSource,
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

/* ---------------- 审核分级：草稿 vs 人工确认 ---------------- */

test('normalizeStatus: 只认 confirmed，其余一律当草稿（宁可多看一眼）', () => {
  assert.equal(normalizeStatus('confirmed'), TM_STATUS.CONFIRMED);
  assert.equal(normalizeStatus(TM_STATUS.CONFIRMED), TM_STATUS.CONFIRMED);
  assert.equal(normalizeStatus('draft'), TM_STATUS.DRAFT);
  assert.equal(normalizeStatus('whatever'), TM_STATUS.DRAFT);
  assert.equal(normalizeStatus(undefined), TM_STATUS.DRAFT);
  assert.equal(normalizeStatus(null), TM_STATUS.DRAFT);
});

test('addEntry: 默认入库为草稿（机翻写入没经过复核）', () => {
  const tm = addEntry(emptyTm(), 'おはよう', '早上好', 1);
  assert.equal(tm.entries[0].status, TM_STATUS.DRAFT);
  assert.equal(isConfirmed(tm.entries[0]), false);
});

test('addEntry: 可显式写为已确认（人工输入/人工确认）', () => {
  const tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { status: TM_STATUS.CONFIRMED });
  assert.equal(isConfirmed(tm.entries[0]), true);
  assert.equal(tm.entries[0].status, TM_STATUS.CONFIRMED);
});

test('findConfirmed: 草稿不会被自动套用（核心安全属性）', () => {
  const draft = addEntry(emptyTm(), 'おはよう', '早上好', 1);
  // 精确命中拿得到（供人工挑选），但自动套用查询必须拒绝
  assert.ok(findExact(draft, 'おはよう'));
  assert.equal(findConfirmed(draft, 'おはよう'), null,
    '未复核的机翻不能自动扩散到全篇');
});

test('findConfirmed: 已确认条目可以自动套用', () => {
  const tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { status: TM_STATUS.CONFIRMED });
  assert.equal(findConfirmed(tm, 'おはよう').dst, '早上好');
});

test('confirmEntry: 把草稿转为已确认，之后就能自动套用', () => {
  let tm = addEntry(emptyTm(), 'おはよう', '早上好', 1);
  assert.equal(findConfirmed(tm, 'おはよう'), null);
  tm = confirmEntry(tm, 'おはよう', 2);
  assert.equal(findConfirmed(tm, 'おはよう').dst, '早上好');
  assert.equal(tm.entries[0].at, 2, '确认时间会更新');
});

test('confirmEntry: 定位不到条目时原样返回（不改库）', () => {
  const tm = addEntry(emptyTm(), 'おはよう', '早上好', 1);
  const same = confirmEntry(tm, '無い文', 2);
  assert.equal(same, tm);
});

test('confirmEntry: 只确认指定说话人那条，不牵连其他人的变体', () => {
  let tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { name: 'アリス' });
  tm = addEntry(tm, 'おはよう', '早安啊', 2, { name: 'ボブ' });
  tm = confirmEntry(tm, 'おはよう', 3, 'アリス');
  assert.equal(isConfirmed(findExact(tm, 'おはよう', 'アリス')), true);
  assert.equal(isConfirmed(findExact(tm, 'おはよう', 'ボブ')), false);
  assert.equal(findConfirmed(tm, 'おはよう', 'ボブ'), null, '另一个角色的变体仍是草稿');
});

/* ---------------- 角色多变体 ---------------- */

test('entryId: 同源句不同说话人是不同身份，且不会拼接歧义', () => {
  assert.notEqual(entryId('あ', 'アリス'), entryId('あ', 'ボブ'));
  assert.equal(entryId('あ', 'アリス'), entryId('あ', 'アリス'));
  // 分隔符保证 ("あ","い") 与 ("あい","") 不撞
  assert.notEqual(entryId('あ', 'い'), entryId('あい', ''));
});

test('addEntry: 同句不同说话人共存（不再互相覆盖）', () => {
  let tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { name: 'アリス' });
  tm = addEntry(tm, 'おはよう', '早啊', 2, { name: 'ボブ' });
  assert.equal(tmSize(tm), 2, '两个角色的译法必须都留住');
  assert.equal(findExact(tm, 'おはよう', 'アリス').dst, '早上好');
  assert.equal(findExact(tm, 'おはよう', 'ボブ').dst, '早啊');
});

test('addEntry: 同一说话人重复写入仍覆盖（不会无限堆积）', () => {
  let tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { name: 'アリス' });
  tm = addEntry(tm, 'おはよう', '早安', 2, { name: 'アリス' });
  assert.equal(tmSize(tm), 1);
  assert.equal(findExact(tm, 'おはよう', 'アリス').dst, '早安');
});

test('addEntry: 说话人首尾空白归一化，避免同一角色存成两条', () => {
  let tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { name: ' アリス ' });
  tm = addEntry(tm, 'おはよう', '早安', 2, { name: 'アリス' });
  assert.equal(tmSize(tm), 1);
});

test('findExact: 指定说话人优先命中该角色', () => {
  let tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { name: 'アリス' });
  tm = addEntry(tm, 'おはよう', '早啊', 2, { name: 'ボブ' });
  assert.equal(findExact(tm, 'おはよう', 'アリス').dst, '早上好');
  assert.equal(findExact(tm, 'おはよう', 'ボブ').dst, '早啊');
});

test('findExact: 该角色没有条目时退回"通用"条目（同一句对谁都一样的常见情形）', () => {
  const tm = addEntry(emptyTm(), 'おはよう', '早上好', 1);   // 未标注说话人
  assert.equal(findExact(tm, 'おはよう', 'アリス').dst, '早上好');
  assert.equal(findExact(tm, 'おはよう', '').dst, '早上好');
});

test('findExact: 不指定说话人时不拿别的角色的译法顶上', () => {
  const tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { name: 'アリス' });
  assert.equal(findExact(tm, 'おはよう'), null,
    '不知道说话人就不能假设是爱丽丝的语气');
});

test('findExact: 只有别的角色有译法时返回 null（交由相似命中当建议）', () => {
  const tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { name: 'アリス' });
  assert.equal(findExact(tm, 'おはよう', 'ボブ'), null);
});

test('variantsOf: 列出同句全部变体，按使用时间降序', () => {
  let tm = addEntry(emptyTm(), 'おはよう', '早上好', 1, { name: 'アリス' });
  tm = addEntry(tm, 'おはよう', '早啊', 5, { name: 'ボブ' });
  tm = addEntry(tm, 'おはよう', '早安', 3);
  const vs = variantsOf(tm, 'おはよう');
  assert.equal(vs.length, 3);
  assert.deepEqual(vs.map(v => v.dst), ['早啊', '早安', '早上好']);
  // 规范键也认（带括号/句号）
  assert.equal(variantsOf(tm, '「おはよう。」').length, 3);
  assert.deepEqual(variantsOf(tm, ''), []);
});

test('TM_MAX_VARIANTS: 常量存在且有合理上限（防止一句口头禅撑爆库）', () => {
  assert.ok(Number.isInteger(TM_MAX_VARIANTS) && TM_MAX_VARIANTS >= 2 && TM_MAX_VARIANTS <= 20);
});

test('findSimilar: 已确认条目在分数相同时排前（用户确认过的更值得先看）', () => {
  // 构造真正同分的两条：与查询 `あいう` 的 bigram 交集都是 {あい} → Dice 都是 0.5
  let tm = addEntry(emptyTm(), 'あいえ', '草稿译法', 1, { status: TM_STATUS.DRAFT });
  tm = addEntry(tm, 'あいお', '确认译法', 2, { status: TM_STATUS.CONFIRMED });
  const hits = findSimilar(tm, 'あいう', { limit: 2, threshold: 0 });
  assert.equal(hits.length, 2, '两条都该命中');
  assert.equal(hits[0].score, hits[1].score, '前提：两条分数确实相同');
  assert.equal(isConfirmed(hits[0].entry), true, '同分时已确认的排前');
});

/* ---------------- 来源显示 ---------------- */

test('entrySourceLabel: 区分已确认 / 机翻草稿 / 来源不明（不能一律叫草稿）', () => {
  assert.equal(entrySourceLabel({ status: 'draft', origin: 'mt' }), '机翻草稿');
  assert.equal(entrySourceLabel({ status: 'confirmed' }), '已确认');
  assert.equal(entrySourceLabel({ status: 'confirmed', name: 'アリス' }), '已确认 · アリス');
  assert.equal(entrySourceLabel({ status: 'draft', origin: 'mt', name: 'ボブ' }), '机翻草稿 · ボブ');
  // 从已有译文导入（来源不明）的条目不是机翻产物，不该冒充"草稿"的信息量
  assert.equal(entrySourceLabel({ status: 'draft', origin: '' }), '未确认');
  assert.equal(entrySourceLabel({ status: 'draft' }), '未确认');
  assert.equal(entrySourceLabel(null), '');
});

test('entrySourceLabel: 读的是 origin 字段（entry.src 是原文文本，不是来源）', () => {
  // 这条锁字段语义：src 放原文、origin 放归因，两者混用会让标签胡说
  const entry = { src: 'おはよう', origin: 'mt', status: 'draft' };
  assert.equal(entrySourceLabel(entry), '机翻草稿', '不该因为 src 不是 "mt" 就退化成未确认');
  assert.equal(entrySourceLabel({ src: 'mt', origin: '', status: 'draft' }), '未确认',
    'src 恰好是 "mt"（原文真的是这个词）也不该被当成机翻来源');
});

test('suggestLabelWithSource: 建议条上能看出这条记忆可不可信', () => {
  const e = { dst: '早上好', status: 'draft', origin: 'mt', name: 'アリス' };
  assert.equal(suggestLabelWithSource(e), '机翻草稿 · アリス：早上好');
  assert.equal(suggestLabelWithSource(null), '');
});

/* ---------------- 收割的审核归因 ---------------- */

test('collectFromParas: 机翻译文记为草稿', () => {
  const paras = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'mt' }];
  const { tm, confirmed } = collectFromParas(paras, emptyTm(), 100);
  assert.equal(confirmed, 0);
  assert.equal(isConfirmed(tm.entries[0]), false);
  assert.equal(findConfirmed(tm, 'おはよう'), null, '机翻草稿不得自动套用');
});

test('collectFromParas: 人工译文记为已确认', () => {
  const paras = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'human' }];
  const { tm, confirmed } = collectFromParas(paras, emptyTm(), 100);
  assert.equal(confirmed, 1);
  assert.equal(isConfirmed(tm.entries[0]), true);
  assert.ok(findConfirmed(tm, 'おはよう'), '人工确认过的可以自动套用');
});

test('collectFromParas: 已通过校对的行记为已确认（通过即确认）', () => {
  const paras = [{
    isName: false, brackets: false, content: 'おはよう', translation: '早上好',
    src: 'mt', pr: { status: 'approved' },
  }];
  const { confirmed } = collectFromParas(paras, emptyTm(), 100);
  assert.equal(confirmed, 1);
});

test('collectFromParas: 已确认条目不被同句机翻草稿降级', () => {
  // 第一轮：人工写了并收割（confirmed）
  const human = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'human' }];
  const first = collectFromParas(human, emptyTm(), 100);
  assert.equal(isConfirmed(first.tm.entries[0]), true);
  // 第二轮：同一句被机翻重写了（mt）→ 不该把已确认的定论退回草稿
  const mt = [{ isName: false, brackets: false, content: 'おはよう', translation: '早安', src: 'mt' }];
  const second = collectFromParas(mt, first.tm, 200);
  const e = second.tm.entries.find(x => x.src === 'おはよう');
  assert.equal(e.dst, '早安', '译文更新');
  assert.equal(isConfirmed(e), true, '审核状态保持已确认（人工的确认是定论）');
});

test('collectFromParas: 按说话人分开入库', () => {
  const paras = [
    { isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'human', name: 'アリス' },
    { isName: false, brackets: false, content: 'おはよう', translation: '早啊', src: 'human', name: 'ボブ' },
  ];
  const { tm } = collectFromParas(paras, emptyTm(), 100);
  assert.equal(tmSize(tm), 2);
  assert.equal(findExact(tm, 'おはよう', 'アリス').dst, '早上好');
  assert.equal(findExact(tm, 'おはよう', 'ボブ').dst, '早啊');
});

test('collectFromParas: 幂等性覆盖审核状态（同为草稿且译文未变时不重复计数）', () => {
  const paras = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'mt' }];
  const first = collectFromParas(paras, emptyTm(), 100);
  assert.equal(first.added, 1);
  const second = collectFromParas(paras, first.tm, 200);
  assert.equal(second.added, 0, '同一句反复收割不该反复入库');
});

test('collectFromParas: 机翻草稿转为人工确认后会被重新收割（状态变化要落库）', () => {
  const mt = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'mt' }];
  const first = collectFromParas(mt, emptyTm(), 100);
  assert.equal(isConfirmed(first.tm.entries[0]), false);
  // 用户把该行改写/确认过（src 变为 human）→ 状态变化，需要重新入库
  const human = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'human' }];
  const second = collectFromParas(human, first.tm, 200);
  assert.equal(second.added, 1, '状态从草稿变已确认要落库');
  assert.equal(isConfirmed(second.tm.entries.find(x => x.src === 'おはよう')), true);
});

test('collectFromParas: 记下译文的来源归因（供标签区分机翻与来源不明）', () => {
  const mtRow = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'mt' }];
  const a = collectFromParas(mtRow, emptyTm(), 100);
  assert.equal(a.tm.entries[0].origin, 'mt');
  assert.equal(entrySourceLabel(a.tm.entries[0]), '机翻草稿');

  // 来源为空（从别人成品/旧译文导入）→ 不该显示成"机翻草稿"
  const unknown = [{ isName: false, brackets: false, content: 'やあ', translation: '呀' }];
  const b = collectFromParas(unknown, emptyTm(), 100);
  assert.equal(b.tm.entries[0].origin, '');
  assert.equal(entrySourceLabel(b.tm.entries[0]), '未确认');
});

test('collectFromParas: 译文没变但来源从 mt 变成 human 时仍要落库（状态与标签都变了）', () => {
  const mt = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'mt' }];
  const first = collectFromParas(mt, emptyTm(), 100);
  assert.equal(first.added, 1);
  // 用户看过并认可了这一行（归因改人工），译文一字未动
  const human = [{ isName: false, brackets: false, content: 'おはよう', translation: '早上好', src: 'human' }];
  const second = collectFromParas(human, first.tm, 200);
  assert.equal(second.added, 1, '来源/审核状态变了就要更新，否则标签会一直显示旧状态');
  assert.equal(isConfirmed(second.tm.entries.find(e => e.src === 'おはよう')), true);
});

test('normalizeTm: origin 字段容错（旧数据缺字段 → 空，不炸）', () => {
  const tm = normalizeTm({ entries: [{ src: 'おはよう', dst: '早上好', status: 'draft' }] });
  assert.equal(tm.entries[0].origin, '');
  const tm2 = normalizeTm({ entries: [{ src: 'やあ', dst: '呀', status: 'draft', origin: 42 }] });
  assert.equal(tm2.entries[0].origin, '', '非字符串一律归空');
});

/* ---------------- v1 → v2 迁移 ---------------- */

test('normalizeTm: v1 老数据缺 status → 迁为已确认（不能让老用户已有的记忆突然失效）', () => {
  const migrated = normalizeTm({
    version: 1,
    entries: [{ src: 'おはよう', dst: '早上好', at: 1 }],
  });
  assert.equal(migrated.version, TM_VERSION);
  assert.equal(migrated.entries[0].status, TM_STATUS.CONFIRMED);
  assert.equal(isConfirmed(migrated.entries[0]), true);
  assert.equal(migrated.entries[0].name, '', 'v1 没有说话人字段 → 归为通用条目');
});

test('normalizeTm: 显式 draft 保持草稿（不因缺省规则被升级成已确认）', () => {
  const tm = normalizeTm({ entries: [{ src: 'おはよう', dst: '早上好', status: 'draft' }] });
  assert.equal(isConfirmed(tm.entries[0]), false);
});

test('normalizeTm: 同句不同说话人各自保留（去重按 key+name，不再只按 key）', () => {
  const tm = normalizeTm({
    entries: [
      { src: 'おはよう', dst: '早上好', name: 'アリス', status: 'confirmed' },
      { src: 'おはよう', dst: '早啊', name: 'ボブ', status: 'confirmed' },
    ],
  });
  assert.equal(tmSize(tm), 2, '两个角色的译法都要留住');
});

test('normalizeTm: 同 key 同说话人的重复项仍去重', () => {
  const tm = normalizeTm({
    entries: [
      { src: 'おはよう', dst: '早上好', name: 'アリス' },
      { src: '「おはよう。」', dst: '早安', name: 'アリス' },
    ],
  });
  assert.equal(tmSize(tm), 1);
  assert.equal(tm.entries[0].dst, '早上好', '先出现的胜出（与既有行为一致）');
});

test('normalizeTm: 说话人字段容错（非字符串/缺失都不炸）', () => {
  const tm = normalizeTm({
    entries: [
      { src: 'おはよう', dst: 'A', name: 123 },
      { src: 'やあ', dst: 'B' },
    ],
  });
  assert.equal(tmSize(tm), 2);
  assert.equal(typeof tm.entries[0].name, 'string');
});

test('TM_VERSION: 已升到 2（条目结构加了 status/name）', () => {
  assert.equal(TM_VERSION, 2);
});
