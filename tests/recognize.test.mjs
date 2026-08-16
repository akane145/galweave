// 文本格式识别单元测试 — node:test + node:assert, 纯逻辑不依赖 DOM
// 运行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detect, canonicalize, restore, splitText, detectMarks, parseMarkedLine,
  parseBracketSpeaker, detectIdShape, renderReport,
} from '../src/recognize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function readSample(name){
  return readFileSync(resolve(ROOT, 'test text', name), 'utf-8');
}

/* ---------------- 基础工具 ---------------- */

test('splitText: 换行风格 / 末尾换行 / 前导空行', () => {
  assert.deepEqual(splitText('a\r\nb\r\n'), { lines: ['a', 'b'], nl: '\r\n', trailing: 1, leadingBlank: 0 });
  assert.deepEqual(splitText('a\n\n'), { lines: ['a'], nl: '\n', trailing: 2, leadingBlank: 0 });
  assert.deepEqual(splitText('\r\n\r\na'), { lines: ['a'], nl: '\r\n', trailing: 0, leadingBlank: 2 });
});

/* ---------------- 标记字符检测 ---------------- */

test('detectMarks: ☆/★ 与 ○/● 成对识别', () => {
  const star = ['☆0001☆A☆x', '★0001★A★y', '', '☆0002☆☆x', '★0002★★y'];
  const m = detectMarks(star);
  assert.equal(m.open, '☆');
  assert.equal(m.close, '★');
  assert.equal(m.pairs, 2);

  const circle = ['○0000000002○x', '●0000000002●y', '', '○0000000003○x', '●0000000003●y'];
  const c = detectMarks(circle);
  assert.equal(c.open, '○');
  assert.equal(c.close, '●');
});

test('detectMarks: # 注释行不干扰', () => {
  const m = detectMarks(['#NOTTRANS', '☆0001☆A☆「x」', '★0001★A★「y」']);
  assert.equal(m.open, '☆');
  assert.equal(m.close, '★');
});

/* ---------------- 行结构 ---------------- */

test('parseMarkedLine: 内联说话人 / 仅编号 / 无标记', () => {
  assert.deepEqual(parseMarkedLine('☆0003☆桐吾☆「x」', '☆').segments, ['0003', '桐吾', '「x」']);
  assert.equal(parseMarkedLine('☆0003☆桐吾☆「x」', '☆').id, '0003');
  assert.equal(parseMarkedLine('☆0003☆桐吾☆「x」', '☆').name, '桐吾');
  assert.equal(parseMarkedLine('☆000001☆x', '☆').id, '000001');
  assert.equal(parseMarkedLine('☆000001☆x', '☆').name, '');
  assert.equal(parseMarkedLine('普通的一行', '☆'), null);
});

test('parseBracketSpeaker: [[名字]] 与【名字】说话人提取', () => {
  assert.deepEqual(parseBracketSpeaker(' [[照]] 「むにゃ」[np]'), { name: '照', content: '「むにゃ」[np]', bracketSpeaker: true, bracketStyle: '[[]]' });
  assert.deepEqual(parseBracketSpeaker('【宗一郎】「こんにちは」'), { name: '宗一郎', content: '「こんにちは」', bracketSpeaker: true, bracketStyle: '【】' });
  assert.deepEqual(parseBracketSpeaker(' どうして…'), { name: '', content: ' どうして…' });
});

test('detectIdShape: 编号形状分类', () => {
  assert.equal(detectIdShape(['000001', '000002']), 'numeric');
  assert.equal(detectIdShape(['0000000A', '0000000B']), 'hex');
  assert.equal(detectIdShape(['00000|000008|003']), 'hex-pipe');
  assert.equal(detectIdShape(['TEXT|0', 'NAME|7']), 'text-name');
  assert.equal(detectIdShape(['000001N', '000000R']), 'suffix-nrt');
  assert.equal(detectIdShape([]), 'none');
});

/* ---------------- 全文件识别 ---------------- */

test('detect: 第二种(○/● + [[名字]] + 标签)', () => {
  const p = detect(readSample('第二种.txt'), '第二种.txt');
  assert.equal(p.marks.open, '○');
  assert.equal(p.marks.close, '●');
  assert.equal(p.structure.nameSource, 'bracket');
  assert.equal(p.structure.idShape, 'hex-pipe');
  assert.equal(p.editable.nameField, false);
  assert.ok(p.structure.tags['[np]'] >= 20, '[np] 标签被识别');
  assert.equal(p.issues.length, 0);
});

test('detect: (11) 系统性编号偏移被识别放行,不再误报', () => {
  const p = detect(readSample('新建 文本文档 (11).txt'), '(11).txt');
  assert.equal(p.idOffset.offset, 1, '译文编号 = 原文 +1 被检测');
  assert.equal(p.idOffset.systematic, true, '偏移是系统性的');
  assert.equal(p.idOffset.matched, 33, '全部编号对一致');
  assert.equal(p.issues.some(i => i.type === 'id-mismatch'), false, '系统性偏移不视为问题');
  assert.ok(p.marks.confidence >= 0.9, '按偏移对齐后置信度恢复高值');
});

test('detect: 第一种 #NOTTRANS 作为行控制行保留', () => {
  const p = detect(readSample('第一种.txt'), '第一种.txt');
  const withControls = p.rows.filter(r => r.controls && r.controls.length).length;
  assert.equal(withControls, 11, '#NOTTRANS 附着在每对正文行上保留');
  assert.equal(p.issues.some(i => i.type === 'other-line'), false, '控制行不算无法归类');
});

test('detect: N 后缀名字行(000001N)与 NAME|n 均计入名字行', () => {
  const p3 = detect(readSample('新建 文本文档 (3).txt'), '(3).txt');
  assert.equal(p3.rowTypes.nameRows, 9, 'N 后缀名字行计入 nameRows');
  assert.equal(p3.rowTypes.nameSuffixN, 9);
  assert.equal(p3.structure.lineKinds.nameEntry, 9, '分类: 名字行');
  assert.equal(p3.rows.filter(r => r.nameEntry).length, 9);

  const p5 = detect(readSample('新建 文本文档 (5).txt'), '(5).txt');
  assert.equal(p5.rowTypes.nameRows, 2, 'NAME|n 行也计入 nameRows');
  assert.equal(p5.rowTypes.nameSuffixN, 0);
});

test('detect: 【宗一郎】角括号名字提取,对话行【名】说话人也识别', () => {
  const p5 = detect(readSample('新建 文本文档 (5).txt'), '(5).txt');
  const nmRow = p5.rows.find(r => r.id === 'NAME|7');
  assert.equal(nmRow.name, '宗一郎', '名字取括号内');
  assert.equal(nmRow.source, '【宗一郎】', '正文保留原样供还原');
  assert.equal(nmRow.lineKind, 'name-entry');
  // 对话行 【名】 说话人
  const td = '☆000001☆【宗一郎】「こんにちは」\n★000001★【宗一郎】「你好」\n';
  const pd = detect(td, 'd');
  assert.equal(pd.rows[0].name, '宗一郎');
  assert.equal(pd.rows[0].bracketStyle, '【】');
  assert.equal(pd.rows[0].source, '「こんにちは」');
  assert.equal(restore(pd, canonicalize(pd)), td, '对话行【名】还原无损');
});

test('detect: 无标记文本 → marks 为空且报无法归类', () => {
  const p = detect('这是纯文本，没有标记。\n第二行。\n', 'plain.txt');
  assert.equal(p.marks.pairs, 0);
  assert.ok(p.issues.some(i => i.type === 'other-line'));
});

test('renderReport: 报告包含关键信息', () => {
  const p = detect(readSample('第二种.txt'), '第二种.txt');
  const r = renderReport(p);
  assert.ok(r.includes('○'), '报告含原文标记');
  assert.ok(r.includes('bracket'), '报告含说话人来源');
});

/* ---------------- 规范化 / 还原 ---------------- */

test('canonicalize/restore: 13 个示例文件字节级无损还原', () => {
  const dir = resolve(ROOT, 'test text');
  const names = readdirSync(dir).filter(n => n.endsWith('.txt'));
  assert.equal(names.length, 13);
  for (const name of names){
    const text = readFileSync(resolve(dir, name), 'utf-8');
    const p = detect(text, name);
    const canon = canonicalize(p);
    const restored = restore(p, canon);
    assert.equal(restored, text, name + ' 还原应字节级一致');
  }
});

test('canonicalize: [[名字]] 入名字槽;对话行正文只留「…」,括号外标签剥离但还原贴回', () => {
  const text = '○00000|000008|003○ [[照]] 「むにゃ」[np]\n●00000|000008|003● [[照]] 「唔喵」[np]\n';
  const p = detect(text, 't');
  const canon = canonicalize(p);
  assert.ok(canon.includes('☆00000|000008|003☆照☆「むにゃ」'), '原文行: 名字入槽');
  assert.ok(!canon.includes('[np]'), '「」外标签不进正文');
  assert.ok(canon.includes('★00000|000008|003★照★「唔喵」'), '译文行: 名字入槽');
  // 旁白行(无「」)保留标签
  const p2 = detect('○00010|000047|002○ どうして…[np]\n●00010|000047|002● 为什么…[np]\n', 't2');
  const canon2 = canonicalize(p2);
  assert.ok(canon2.includes('どうして…[np]'), '旁白行标签保留');
  // 还原贴回标签,字节级一致
  assert.equal(restore(p, canon), text);
});

test('canonicalize: 保留前导空行(文件开头空行)', () => {
  const text = '\r\n☆0001☆A☆「x」\r\n★0001★A★「y」\r\n\r\n';
  const p = detect(text, 't');
  const canon = canonicalize(p);
  assert.ok(canon.startsWith('\r\n'), '前导空行保留');
  assert.equal(restore(p, canon), text, '还原一致');
});

test('canonicalize/restore: 编号错位文件(11) 还原保留各自的编号', () => {
  const text = readSample('新建 文本文档 (11).txt');
  const p = detect(text, '(11).txt');
  const canon = canonicalize(p);
  assert.ok(canon.includes('★000001T★'), '规范化保留译文行自己的编号');
  assert.equal(restore(p, canon), text);
});

/* ---------------- 编辑器模拟 ---------------- */

test('simulateEditor: 识别配置让 ○/● 文件全部获得编号', async () => {
  const { analyzeWithParsers } = await import('../src/recognize.js');
  const { parseFile, setParseConf, buildExport } = await import('../src/parsers.js');
  const parsers = { parseFile, setParseConf, buildExport };
  const text = readSample('新建 文本文档 (9).txt');
  const p = detect(text, '(9).txt');
  // 默认配置(☆/★)下该文件全部无编号 —— 复现"识别规则有问题"
  const before = analyzeWithParsers(parsers, text, { open: '☆', close: '★', regex: '' }, '默认');
  assert.equal(before.withId, 0);
  // 识别配置(○/●)下全部有编号且无损
  const after = analyzeWithParsers(parsers, text, p.parseConfig, '识别');
  assert.equal(after.withId, 27);
  assert.equal(after.roundTrip, true);
});

test('simulateEditor: [[名字]] 规范化后名字栏可用', async () => {
  const { analyzeWithParsers } = await import('../src/recognize.js');
  const { parseFile, setParseConf, buildExport } = await import('../src/parsers.js');
  const parsers = { parseFile, setParseConf, buildExport };
  const text = readSample('第二种.txt');
  const p = detect(text, '第二种.txt');
  const before = analyzeWithParsers(parsers, text, p.parseConfig, '原文件');
  assert.equal(before.named, 0, '原文件名字在 [[ ]] 内,编辑器名字栏为空');
  const canon = canonicalize(p);
  const after = analyzeWithParsers(parsers, canon, { open: '☆', close: '★', regex: '' }, '规范化');
  assert.equal(after.named, 19, '规范化后 19 行名字栏可用');
  assert.equal(after.roundTrip, true);
});
