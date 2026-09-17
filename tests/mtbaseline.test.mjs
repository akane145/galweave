// mtbaseline.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/mtbaseline.test.mjs
// 注：只测纯逻辑（分类 / 基线读写 / 差异汇总），不碰 loadBaseline/saveBaseline。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MT_BASELINE_VERSION, MAX_EXAMPLES, EDIT_LABELS, EDIT_ORDER, TAIL_MAX, MIN_LEN_DELTA,
  stripPunct, nfkc, tailTrim, commonPrefixLen, classifyEdit,
  emptyBaseline, recordMt, normalizeBaseline, baselineCount, mtEdits, summarizeEdits, keepRateText,
} from '../src/mtbaseline.js';

/** 普通段落 */
const L = (orig, translation, extra = {}) => ({ isName: false, brackets: false, orig, content: orig, translation, nameTr: orig, done: !!translation, ...extra });

/* ---------------- 分类 ---------------- */

test('stripPunct: 去掉中日文与 ASCII 标点、空白', () => {
  assert.equal(stripPunct('早上好，世界。'), '早上好世界');
  assert.equal(stripPunct('はい、そうです！'), 'はいそうです');
  assert.equal(stripPunct('「引号」'), '引号');
  assert.equal(stripPunct('a-b c'), 'abc');
  assert.equal(stripPunct(null), '');
});

test('nfkc: 全角字母数字折叠为半角；无 normalize 时原样返回', () => {
  assert.equal(nfkc('ＡＢＣ１２３'), 'ABC123');
  assert.equal(nfkc('ｱｲｳ'), 'アイウ');           // 半角片假名 → 全角
  assert.equal(nfkc('中文'), '中文');
  assert.equal(nfkc(null), '');
});

test('tailTrim / commonPrefixLen: 去掉末尾 n 字 / 公共前缀长度', () => {
  assert.equal(tailTrim('おはようございます', 2), 'おはようござい');
  assert.equal(tailTrim('ab', 2), '');
  assert.equal(tailTrim('abc', 2), 'a');
  assert.equal(commonPrefixLen('おはようございます', 'おはようございました'), 8);
  assert.equal(commonPrefixLen('甲', '乙'), 0);
  assert.equal(commonPrefixLen(null, '甲'), 0);
});

test('classifyEdit: 相同 / 只差标点 / 全半角 / 只差词尾 / 精简 / 扩写 / 重写', () => {
  assert.equal(classifyEdit('甲', '甲'), 'same');
  assert.equal(classifyEdit('早上好，世界。', '早上好,世界'), 'punct');
  assert.equal(classifyEdit('ＡＢＣ', 'ABC'), 'width');
  assert.equal(classifyEdit('おはようございます', 'おはようございました'), 'tail');
  assert.equal(classifyEdit('这是一个很长很长的句子内容', '很长句子'), 'shortened');
  assert.equal(classifyEdit('短句', '这是一段被明显扩写过的内容'), 'expanded');
  assert.equal(classifyEdit('今天天气不错', '明天可能下雨吧'), 'rewrite');
});

test('classifyEdit: 短句的"尾部不同"不算只差词尾（60% 覆盖度这一条不能省）', () => {
  // 4 字句尾部也只差 2 字，但那是改写
  assert.equal(classifyEdit('今天天气', '今天下雨'), 'rewrite');
});

test('classifyEdit: 短句 ±2 字不算"精简/扩写"（比例在短句上会失控）', () => {
  // 6 字 → 8 字是 +33%，但只差 2 个字，属正常改写
  assert.equal(classifyEdit('今天天气不错', '今天可能下雨'), 'rewrite');
  assert.equal(MIN_LEN_DELTA, 4);
  assert.equal(TAIL_MAX, 3);
});

test('classifyEdit: 判序 —— 只差标点时不会被判成词尾或重写', () => {
  // 「、」+ 结尾差异都会命中 tail，但标点优先
  assert.equal(classifyEdit('是的、长官', '是的，长官'), 'punct');
});

test('classifyEdit: 空值安全', () => {
  assert.equal(classifyEdit(null, undefined), 'same');
  assert.equal(classifyEdit('', '甲'), 'rewrite');
  assert.equal(classifyEdit(null, '甲'), 'rewrite');
});

test('EDIT_LABELS/EDIT_ORDER: 每个类别都有标签且顺序覆盖', () => {
  assert.deepEqual(EDIT_ORDER, ['punct', 'width', 'tail', 'shortened', 'expanded', 'rewrite']);
  for (const k of EDIT_ORDER) assert.ok(EDIT_LABELS[k], '缺标签 ' + k);
  assert.equal(EDIT_LABELS.punct, '标点差异');
});

/* ---------------- 基线读写 ---------------- */

test('recordMt: 稠密数组按位置对齐，只写指定行', () => {
  const paras = [L('a', ''), L('b', ''), L('c', '')];
  const b = recordMt(emptyBaseline(), paras, [{ i: 0, text: '甲' }, { i: 2, text: '丙' }]);
  assert.equal(b.version, MT_BASELINE_VERSION);
  assert.equal(b.total, 3);
  assert.deepEqual(b.rows, [['a', '甲', ''], ['b', '', ''], ['c', '丙', '']]);
});

test('recordMt: 二次写入只覆盖指定行，其它行基线保留', () => {
  const paras = [L('a', ''), L('b', '')];
  const first = recordMt(emptyBaseline(), paras, [{ i: 0, text: '甲' }]);
  const second = recordMt(first, paras, [{ i: 1, text: '乙' }]);
  assert.deepEqual(second.rows, [['a', '甲', ''], ['b', '乙', '']]);
  assert.notEqual(second, first, '不应修改原对象');
});

test('recordMt: 重新导入导致 orig 变化 → 该格作废（不能拿旧文档的机翻当基线）', () => {
  const before = recordMt(emptyBaseline(), [L('a', ''), L('b', '')], [{ i: 0, text: '甲' }, { i: 1, text: '乙' }]);
  const after = recordMt(before, [L('X', ''), L('b', '')], []);
  assert.deepEqual(after.rows, [['X', '', ''], ['b', '乙', '']]);
});

test('recordMt: 越界下标 / 空文本 / 非法 entries 一律跳过', () => {
  const paras = [L('a', ''), L('b', '')];
  const b = recordMt(emptyBaseline(), paras, [
    { i: 9, text: '越界' },
    { i: -1, text: '负数' },
    { i: 0, text: '   ' },
    { i: 1 },
    null,
  ]);
  assert.deepEqual(b.rows, [['a', '', ''], ['b', '', '']]);
  assert.equal(recordMt(emptyBaseline(), null, [{ i: 0, text: 'x' }]).rows.length, 0);
});

test('normalizeBaseline: 版本不符/坏数据返回空基线；长度按 total 对齐', () => {
  assert.equal(normalizeBaseline(null, 3).rows.length, 0);
  assert.equal(normalizeBaseline({ version: 99, rows: [] }, 2).rows.length, 0);

  const b = normalizeBaseline({ version: 1, at: 5, total: 3, rows: [['a', '甲', ''], 'x', [1, 2]] }, 3);
  assert.equal(b.at, 5);
  assert.deepEqual(b.rows, [['a', '甲', ''], ['', '', ''], ['', '', '']]);

  // total 比 rows 大 → 补空行
  const padded = normalizeBaseline({ version: 1, rows: [['a', '甲', '']] }, 3);
  assert.equal(padded.rows.length, 3);
  assert.equal(padded.total, 3);
});

test('baselineCount: 只数有内容的格子', () => {
  const b = recordMt(emptyBaseline(), [L('a', ''), L('b', ''), L('c', '')], [{ i: 0, text: '甲' }, { i: 2, text: '丙' }]);
  assert.equal(baselineCount(b), 2);
  assert.equal(baselineCount(emptyBaseline()), 0);
  assert.equal(baselineCount(null), 0);
});

/* ---------------- 差异汇总 ---------------- */

test('mtEdits: 分出"改过的"与"直接采纳的"，基线为空的行不算', () => {
  const paras0 = [L('a', ''), L('b', ''), L('c', ''), L('d', '')];
  const base = recordMt(emptyBaseline(), paras0, [{ i: 0, text: '甲' }, { i: 1, text: '乙' }, { i: 2, text: '丙' }]);
  // c 行从未有机翻基线（人工直接翻的）
  const b2 = recordMt(base, paras0, [{ i: 3, text: '丁' }]);
  const paras = [L('a', '甲'), L('b', '乙改了'), L('c', '丙'), L('d', '丁')];
  const r = mtEdits(b2, paras);
  assert.deepEqual(r.edits.map(e => e.i), [1]);
  assert.equal(r.edits[0].before, '乙');
  assert.equal(r.edits[0].after, '乙改了');
  assert.equal(r.kept, 3);        // a、c(基线空但正文等于基线? 不 —— c 基线是空)
  assert.equal(r.total, r.edits.length + r.kept);
});

test('mtEdits: 基线为空的行既不进 edits 也不进 kept', () => {
  const paras = [L('a', '人工翻的'), L('b', '')];
  const base = recordMt(emptyBaseline(), paras, [{ i: 1, text: '乙' }]);
  const r = mtEdits(base, [L('a', '人工翻的'), L('b', '乙')]);
  assert.equal(r.edits.length, 0);
  assert.equal(r.kept, 1);
  assert.equal(r.total, 1);
});

test('mtEdits: brackets 行按 transValue 口径比对（不会因外层「」被误判成改过）', () => {
  const paras0 = [{ isName: false, brackets: true, orig: 'a', content: 'a', translation: '', nameTr: 'a' }];
  const base = recordMt(emptyBaseline(), paras0, [{ i: 0, text: '甲' }]);
  const now = [{ isName: false, brackets: true, orig: 'a', content: 'a', translation: '「甲」', nameTr: 'a' }];
  const r = mtEdits(base, now);
  assert.equal(r.edits.length, 0);
  assert.equal(r.kept, 1);
});

test('summarizeEdits: 按类别聚合、按 EDIT_ORDER 排序、例子封顶', () => {
  const mk = (i, before, after) => ({ i, before, after, orig: 'o' + i });
  const edits = [
    mk(0, '甲，乙', '甲,乙'),          // punct
    mk(1, '甲，乙', '甲,乙'),          // punct
    mk(2, 'ＡＢ', 'AB'),               // width
    mk(3, 'おはようございます', 'おはようございました'),   // tail
    mk(4, '今天天气不错', '明天可能下雨吧'),  // rewrite
    mk(5, '甲', '甲'),                 // same → 不计
  ];
  const r = summarizeEdits(edits, 1);
  assert.equal(r.total, 5);
  assert.deepEqual(r.categories.map(c => c.key), ['punct', 'width', 'tail', 'rewrite']);
  assert.equal(r.categories[0].count, 2);
  assert.equal(r.categories[0].examples.length, 1);      // 例子封顶
  assert.equal(MAX_EXAMPLES, 3);
});

test('summarizeEdits: 空输入 / 非数组安全', () => {
  assert.deepEqual(summarizeEdits(null), { total: 0, categories: [] });
  assert.deepEqual(summarizeEdits([]), { total: 0, categories: [] });
  assert.equal(summarizeEdits([{ before: '甲', after: '甲' }]).total, 0);
});

test('keepRateText: 采纳率文案', () => {
  assert.equal(keepRateText({ kept: 3, total: 4 }), '75%');
  assert.equal(keepRateText({ kept: 1, total: 3 }), '33.3%');
  assert.equal(keepRateText({ kept: 0, total: 0 }), '—');
  assert.equal(keepRateText(null), '—');
});
