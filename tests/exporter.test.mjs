// exporter.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/exporter.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORT_FORMATS, normalizeExportFormat, exportFormatLabel, suggestExportName,
  exportEntries, stateLabel, countEntries,
  buildBilingualTxt, buildTargetTxt, buildCsvText, buildExportText,
} from '../src/exporter.js';

/** 普通行；brackets=false 时 transValue === translation */
const LINE = (content, translation, extra = {}) => ({
  isName: false, brackets: false, content, translation, ...extra,
});
/** NAME 行 */
const NAME = (name, nameTr, extra = {}) => ({
  isName: true, name, nameTr: nameTr === undefined ? name : nameTr, content: name, translation: '', ...extra,
});

/* ---------------- 格式表 ---------------- */

test('normalizeExportFormat: 合法值透传，非法/空回退 original（最安全，不改既有行为）', () => {
  for (const f of EXPORT_FORMATS) assert.equal(normalizeExportFormat(f.id), f.id);
  assert.equal(normalizeExportFormat('啥'), 'original');
  assert.equal(normalizeExportFormat(''), 'original');
  assert.equal(normalizeExportFormat(null), 'original');
  assert.equal(normalizeExportFormat(undefined), 'original');
});

test('exportFormatLabel: 四种格式都有中文标签', () => {
  assert.equal(exportFormatLabel('bilingual'), '双语对照 TXT');
  assert.equal(exportFormatLabel('target'), '纯译文 TXT');
  assert.equal(exportFormatLabel('csv'), '对照 CSV（Excel 可开）');
  assert.equal(exportFormatLabel('original'), '原格式（回写引擎文本）');
  assert.equal(exportFormatLabel('非法'), '原格式（回写引擎文本）');
});

test('suggestExportName: 三种新格式加不同后缀，避免覆盖原文件', () => {
  assert.equal(suggestExportName('story_01.ks', 'bilingual'), 'story_01.bilingual.txt');
  assert.equal(suggestExportName('story_01.ks', 'target'), 'story_01.zh.txt');
  assert.equal(suggestExportName('story_01.ks', 'csv'), 'story_01.csv');
  assert.equal(suggestExportName('story_01.ks', 'original'), 'story_01.ks');
  // 无扩展名 / 空 / 隐藏文件名（.开头不当作扩展名分隔）
  assert.equal(suggestExportName('plain', 'csv'), 'plain.csv');
  assert.equal(suggestExportName('', 'csv'), '译文.csv');
  assert.equal(suggestExportName('  ', 'csv'), '译文.csv');
  assert.equal(suggestExportName('.hidden', 'csv'), '.hidden.csv');
});

/* ---------------- 行数据 ---------------- */

test('exportEntries: 普通行取 content/translation，编号缺省用行号', () => {
  const rows = exportEntries([LINE('おはよう', '早上好', { id: 'TEXT|3' }), LINE('はい', '嗯')]);
  assert.equal(rows[0].no, 'TEXT|3');
  assert.equal(rows[0].original, 'おはよう');
  assert.equal(rows[0].translation, '早上好');
  assert.equal(rows[1].no, '2');            // 无 id → 行号
  assert.equal(rows[1].isName, false);
});

test('exportEntries: NAME 行用名字做原文/译文，说话人字段留空', () => {
  const rows = exportEntries([NAME('アリス', '爱丽丝')]);
  assert.equal(rows[0].isName, true);
  assert.equal(rows[0].original, 'アリス');
  assert.equal(rows[0].translation, '爱丽丝');
  assert.equal(rows[0].speaker, '');
});

test('exportEntries: 普通行的说话人优先取译名，未改译名时退回原名', () => {
  assert.equal(exportEntries([LINE('a', 'b', { name: 'アリス', nameTr: '爱丽丝' })])[0].speaker, '爱丽丝');
  assert.equal(exportEntries([LINE('a', 'b', { name: 'アリス', nameTr: 'アリス' })])[0].speaker, 'アリス');
});

test('exportEntries: brackets 行剥掉外层「」——与 parsers.transValue 口径一致', () => {
  const rows = exportEntries([{ isName: false, brackets: true, content: 'おはよう', translation: '「早上好」' }]);
  assert.equal(rows[0].translation, '早上好');
});

test('exportEntries: 空数组 / 含 null 元素不抛错', () => {
  assert.deepEqual(exportEntries(null), []);
  assert.deepEqual(exportEntries([]), []);
  const rows = exportEntries([null]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].translation, '');
});

/* ---------------- 状态 ---------------- */

test('stateLabel: 有校对记录走三态，否则退回已译/未译', () => {
  assert.equal(stateLabel(LINE('a', 'b')), '已译');
  assert.equal(stateLabel(LINE('a', '')), '未译');
  assert.equal(stateLabel(LINE('a', 'b', { pr: { status: 'approved' } })), '已定稿');
  assert.equal(stateLabel(LINE('a', 'b', { pr: { status: 'issue' } })), '有问题');
  assert.equal(stateLabel(LINE('a', 'b', { pr: { status: 'pending' } })), '待校对');
  assert.equal(stateLabel(NAME('アリス', '爱丽丝')), '已译');
  assert.equal(stateLabel(NAME('アリス', '')), '未译');
  assert.equal(stateLabel(null), '未译');
});

test('countEntries: 统计总数 / 已译 / NAME 数 / 未译数', () => {
  const c = countEntries([LINE('a', 'b'), LINE('c', ''), NAME('アリス', '爱丽丝'), NAME('ボブ')]);
  assert.equal(c.total, 4);
  assert.equal(c.translated, 2);    // 1 普通行 + 1 已改译名
  assert.equal(c.names, 2);
  assert.equal(c.pending, 2);
});

/* ---------------- 双语对照 ---------------- */

test('buildBilingualTxt: 表头 + 每条一块，未译显示占位符', () => {
  const txt = buildBilingualTxt(
    [LINE('おはよう', '早上好', { id: 'TEXT|0' }), LINE('はい', '')],
    { filename: 'story.ks', nl: '\n' },
  );
  const lines = txt.split('\n');
  assert.equal(lines[0], '# 双语对照导出 · story.ks');
  assert.equal(lines[1], '# 共 2 条（已译 1 / 未译 1）');
  assert.ok(txt.includes('[0001] TEXT|0'));
  assert.ok(txt.includes('原：おはよう'));
  assert.ok(txt.includes('译：早上好'));
  assert.ok(txt.includes('译：（未译）'));
  assert.ok(txt.endsWith('\n'), '必须以单个换行结束');
  assert.ok(!txt.endsWith('\n\n'), '不应有多余空行');
});

test('buildBilingualTxt: NAME 行输出生效译名，未改时显式标注', () => {
  const txt = buildBilingualTxt([NAME('アリス'), NAME('ボブ', '鲍勃')], { withHeader: false });
  assert.ok(txt.includes('译名：アリス（未改，导出原名）'));
  assert.ok(txt.includes('译名：鲍勃'));
  assert.ok(!txt.includes('译名：鲍勃（未改'));
});

test('countEntries: NAME 行要求 nameTr !== name 才算已译（与 recalcDone 有意不一致）', () => {
  const c = countEntries([NAME('アリス'), NAME('ボブ', '鲍勃')]);
  assert.equal(c.total, 2);
  assert.equal(c.translated, 1);
  assert.equal(c.names, 2);
});

test('buildBilingualTxt: 空输入不抛错，只留表头', () => {
  const txt = buildBilingualTxt([], { filename: 'x.ks' });
  assert.ok(txt.includes('共 0 条'));
  assert.equal(txt.split('\n').length, 3);   // 2 行表头 + 结尾换行
});

/* ---------------- 纯译文 ---------------- */

test('buildTargetTxt: 只输出有译文的行，未译行整行跳过', () => {
  const txt = buildTargetTxt([LINE('a', '甲'), LINE('b', ''), LINE('c', '丙')], { nl: '\n' });
  assert.equal(txt, '甲\n丙\n');
});

test('buildTargetTxt: NAME 行输出译名，未改则输出原名', () => {
  assert.equal(buildTargetTxt([NAME('アリス', '爱丽丝')], { nl: '\n' }), '爱丽丝\n');
  assert.equal(buildTargetTxt([NAME('アリス')], { nl: '\n' }), 'アリス\n');
});

test('buildTargetTxt: 全部未译 → 空串（调用方据此提示，不要导出空文件）', () => {
  assert.equal(buildTargetTxt([LINE('a', ''), LINE('b', '')]), '');
  assert.equal(buildTargetTxt([]), '');
});

/* ---------------- CSV ---------------- */

test('buildCsvText: 带 UTF-8 BOM + 表头（Excel 直接打开不乱码）', () => {
  const txt = buildCsvText([LINE('a', '甲')], { nl: '\r\n' });
  assert.equal(txt.charCodeAt(0), 0xFEFF);
  const lines = txt.slice(1).split('\r\n');
  assert.equal(lines[0], '序号,编号,说话人,原文,译文,状态');
  assert.equal(lines[1], '1,1,,a,甲,已译');
});

test('buildCsvText: 逗号/引号/换行按 RFC4180 转义（含 "" 翻倍）', () => {
  const txt = buildCsvText([LINE('a', '甲,乙'), LINE('b', '说"你好"'), LINE('c', '第一行\n第二行')]);
  const body = txt.slice(1);
  assert.ok(body.includes('"甲,乙"'));
  assert.ok(body.includes('"说""你好"""'));
  assert.ok(body.includes('"第一行\n第二行"'));
});

test('buildCsvText: 空输入只有表头', () => {
  const txt = buildCsvText([]);
  assert.equal(txt, '\uFEFF序号,编号,说话人,原文,译文,状态\r\n');
});

/* ---------------- 分派 ---------------- */

test('buildExportText: original 返回 null（交 parsers.buildExport 处理）', () => {
  const paras = [LINE('a', '甲')];
  assert.equal(buildExportText('original', paras), null);
  assert.equal(buildExportText('非法格式', paras), null);
  assert.ok(buildExportText('bilingual', paras).includes('甲'));
  assert.equal(buildExportText('target', paras, { nl: '\n' }), '甲\n');
  assert.ok(buildExportText('csv', paras).includes('甲'));
});

test('EXPORT_FORMATS: id 唯一，且 original 排第一（默认项）', () => {
  const ids = EXPORT_FORMATS.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], 'original');
});
