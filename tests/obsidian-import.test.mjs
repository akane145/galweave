// obsidian-import.js 纯逻辑测试 — node:test + node:assert
// 覆盖: frontmatter / 表格 / 列表配对 / 双链 / 合并与冲突 / 宁少收不乱收
// 运行: node --test tests/obsidian-import.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitFrontmatter, parseFrontmatterTerms, parseBodyPairs, parseTable, parseWikilinks,
  parseNote, mergeNotes,
  MAX_TERM_SRC_LEN, SRC_TABLE, SRC_LIST, SRC_LINK,
} from '../src/obsidian-import.js';

/* ---------------- frontmatter ---------------- */

test('splitFrontmatter: 切出 meta 与 body，只认文件开头', () => {
  const r = splitFrontmatter('---\nterms:\n  先輩: 前辈\n---\n正文内容');
  assert.equal(r.hasMeta, true);
  assert.match(r.meta, /先輩: 前辈/);
  assert.equal(r.body, '正文内容');
});

test('splitFrontmatter: 无 frontmatter 时全文作 body', () => {
  const r = splitFrontmatter('# 标题\n\n正文');
  assert.equal(r.hasMeta, false);
  assert.equal(r.body, '# 标题\n\n正文');
  assert.equal(r.meta, '');
});

test('splitFrontmatter: 正文中间的 --- 是分隔线，不算 frontmatter', () => {
  const r = splitFrontmatter('正文\n\n---\n\n更多正文');
  assert.equal(r.hasMeta, false, '只有开头的 --- 块才是 frontmatter');
});

test('splitFrontmatter: BOM 不影响识别', () => {
  const r = splitFrontmatter('\uFEFF---\nterms:\n  先輩: 前辈\n---\n正文');
  assert.equal(r.hasMeta, true);
});

test('parseFrontmatterTerms: terms / names 分组各自归位', () => {
  const r = parseFrontmatterTerms('terms:\n  先輩: 前辈\n  東京: 东京\nnames:\n  アリス: 爱丽丝');
  assert.deepEqual(r.terms, { '先輩': '前辈', '東京': '东京' });
  assert.deepEqual(r.names, { 'アリス': '爱丽丝' });
});

test('parseFrontmatterTerms: characters 是 names 的别名', () => {
  const r = parseFrontmatterTerms('characters:\n  アリス: 爱丽丝');
  assert.deepEqual(r.names, { 'アリス': '爱丽丝' });
});

test('parseFrontmatterTerms: 成对包裹符号被剥掉（引号/「」/『』）', () => {
  const r = parseFrontmatterTerms('terms:\n  "先輩": "前辈"\n  「東京」: 「东京」\n  『王』: 王译');
  assert.equal(r.terms['先輩'], '前辈');
  assert.equal(r.terms['東京'], '东京');
  assert.equal(r.terms['王'], '王译');
});

test('parseFrontmatterTerms: 单行内联映射', () => {
  const r = parseFrontmatterTerms('terms: { 先輩: 前辈, 東京: 东京 }');
  assert.deepEqual(r.terms, { '先輩': '前辈', '東京': '东京' });
});

test('parseFrontmatterTerms: 跳过注释与空行，无分组时忽略条目', () => {
  const r = parseFrontmatterTerms('# 注释\n\n  游离: 条目\nterms:\n  先輩: 前辈');
  assert.deepEqual(r.terms, { '先輩': '前辈' }, '未归入分组的条目应被忽略');
});

test('parseFrontmatterTerms: 源=译 / 空值 / 超长 一律不收', () => {
  const r = parseFrontmatterTerms('terms:\n  同: 同\n  空: \n  长: ' + 'あ'.repeat(100));
  assert.equal(r.terms['同'], undefined, '源=译无意义');
  assert.equal(r.terms['空'], undefined);
  assert.equal(r.terms['长'], undefined, '超长多半是正文');
});

/* ---------------- 表格 ---------------- */

test('parseTable: 取前两列，跳表头与分隔行', () => {
  const md = [
    '| 原文 | 译文 | 备注 |',
    '| --- | --- | --- |',
    '| 先輩 | 前辈 | 常用 |',
    '| 東京 | 东京 | |',
  ].join('\n');
  const r = parseTable(md);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { src: '先輩', dst: '前辈', source: SRC_TABLE });
  assert.equal(r[1].src, '東京');
});

test('parseTable: 英文表头也识别', () => {
  const r = parseTable('| source | target |\n| --- | --- |\n| 先輩 | 前辈 |');
  assert.equal(r.length, 1);
  assert.equal(r[0].src, '先輩');
});

/* ---------------- 列表配对 ---------------- */

test('parseBodyPairs: 支持 :: → ｜ 三种分隔，含列表符号', () => {
  const r = parseBodyPairs(['先輩 :: 前辈', '- 東京 → 东京', '* 王 ｜ 王译', '1. 姫 ⇒ 公主'].join('\n'));
  assert.equal(r.length, 4);
  assert.deepEqual(r.map(x => x.src), ['先輩', '東京', '王', '姫']);
  assert.equal(r[0].source, SRC_LIST);
});

test('parseBodyPairs: 代码块内的内容不解析', () => {
  const md = '```\n先輩 :: 前辈\n```\n東京 :: 东京';
  const r = parseBodyPairs(md);
  assert.equal(r.length, 1);
  assert.equal(r[0].src, '東京');
});

test('parseBodyPairs: 左侧含空格的散文句子不误收（宁少收不乱收）', () => {
  // 日文不用空格分词，"左侧带空格"是可靠的散文信号
  const r = parseBodyPairs('他说 先輩 :: 这个');
  assert.equal(r.length, 0, '带空格的左侧多半是句子，不该当术语');
});

test('parseBodyPairs: 术语本身不含空格（正常配对不受影响）', () => {
  const r = parseBodyPairs('先輩 :: 前辈\n東京大学 → 东京大学');
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(x => x.src), ['先輩', '東京大学']);
});

test('parseBodyPairs: 散文句子不误收（宁少收不乱收）', () => {
  assert.equal(parseBodyPairs('今天天气很好，我去了一趟图书馆。').length, 0);
  assert.equal(parseBodyPairs('先輩と後輩の関係について書いてみる').length, 0);
});

test('parseBodyPairs: 表格行跳过（由 parseTable 负责）', () => {
  assert.equal(parseBodyPairs('| 先輩 | 前辈 |').length, 0);
});

/* ---------------- 双链 ---------------- */

test('parseWikilinks: 收集 [[]] 与 [[目标|别名]]，取别名', () => {
  const r = parseWikilinks('见 [[先輩]] 与 [[東京|东京都]]');
  assert.deepEqual(r.map(x => x.src), ['先輩', '东京都']);
  assert.equal(r[0].dst, '', '双链没有译名，产物是待补空壳');
  assert.equal(r[0].source, SRC_LINK);
});

test('parseWikilinks: 去重', () => {
  const r = parseWikilinks('[[先輩]] 和 [[先輩]] 又一次 [[先輩]]');
  assert.equal(r.length, 1);
});

/* ---------------- parseNote 汇总 ---------------- */

test('parseNote: 三种来源合并，frontmatter 优先', () => {
  const md = [
    '---',
    'terms:',
    '  先輩: 前辈',
    '---',
    '| 東京 | 东京 |',
    '| --- | --- |',
    '大阪 :: 大阪城',
    '见 [[姫]]',
  ].join('\n');
  const r = parseNote(md);
  assert.equal(r.terms['先輩'], '前辈', 'frontmatter 条目');
  assert.equal(r.terms['東京'], '东京', '表格条目');
  assert.equal(r.terms['大阪'], '大阪城', '列表条目');
  assert.deepEqual(r.pending.map(x => x.src), ['姫'], '双链无译名 → 待补');
  assert.equal(r.stats.tables, 1);
  assert.equal(r.stats.lists, 1);
  assert.equal(r.stats.links, 1);
});

test('parseNote: 正文配对不覆盖 frontmatter 的权威映射', () => {
  const md = '---\nterms:\n  先輩: 前辈\n---\n先輩 :: 学长';
  const r = parseNote(md);
  assert.equal(r.terms['先輩'], '前辈', 'frontmatter 是手写的权威映射，优先');
});

test('parseNote: 已有译名的双链不进待补', () => {
  const md = '---\nterms:\n  先輩: 前辈\n---\n见 [[先輩]]';
  const r = parseNote(md);
  assert.equal(r.pending.length, 0);
});

test('parseNote: 空/非法输入安全', () => {
  for (const v of ['', null, undefined]){
    const r = parseNote(v);
    assert.deepEqual(r.terms, {});
    assert.deepEqual(r.names, {});
    assert.deepEqual(r.pending, []);
  }
});

/* ---------------- mergeNotes ---------------- */

test('mergeNotes: 合并多篇，待补去重', () => {
  const a = parseNote('先輩 :: 前辈\n见 [[姫]]');
  const b = parseNote('東京 :: 东京\n见 [[姫]]');
  const r = mergeNotes([a, b]);
  assert.deepEqual(r.terms, { '先輩': '前辈', '東京': '东京' });
  assert.deepEqual(r.pending.map(x => x.src), ['姫'], '同名待补项去重');
});

test('mergeNotes: 冲突先到先得，并如实报告', () => {
  const a = parseNote('先輩 :: 前辈');
  const b = parseNote('先輩 :: 学长');
  const r = mergeNotes([a, b]);
  assert.equal(r.terms['先輩'], '前辈', '第一篇优先');
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0], { src: '先輩', kept: '前辈', ignored: '学长' });
});

test('mergeNotes: 相同值不算冲突', () => {
  const r = mergeNotes([parseNote('先輩 :: 前辈'), parseNote('先輩 :: 前辈')]);
  assert.equal(r.conflicts.length, 0);
});

test('mergeNotes: 已获得译名的条目不再是待补', () => {
  const a = parseNote('见 [[姫]]');         // 只有待补
  const b = parseNote('姫 :: 公主');        // 另一篇给了译名
  const r = mergeNotes([a, b]);
  assert.equal(r.terms['姫'], '公主');
  assert.equal(r.pending.length, 0, '有译名后不该再提示补全');
});

test('mergeNotes: 空/非法输入安全', () => {
  assert.deepEqual(mergeNotes([]).terms, {});
  assert.deepEqual(mergeNotes(null).terms, {});
  assert.deepEqual(mergeNotes([null, undefined]).terms, {});
});

test('MAX_TERM_SRC_LEN: 上限存在且合理（用于挡住散文）', () => {
  assert.ok(MAX_TERM_SRC_LEN > 0 && MAX_TERM_SRC_LEN <= 60);
});
