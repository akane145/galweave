// 核心逻辑单元测试 — node:test + node:assert, 纯逻辑不依赖 DOM
// 运行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parsePrefix, stripBrackets, transValue, makePara, parseFile,
  buildStarPrefix, buildExport, scanTerms, setParseConf, getParseConf, parseConf,
  buildOrigHighlights, mergeRanges, migrateNameTranslations, mergeSavedState
} from '../src/parsers.js';
import { detect } from '../src/recognize.js';
import {
  computeMatches, replaceOnce, replaceAllInParas, countMatches, replaceAllText, jumpToIndex
} from '../src/search.js';
import {
  applyNames, applyTermsToTranslations, recordNameIfNew
} from '../src/glossary.js';
import { projectGlossaryPath, normalizeDirPath } from '../src/glossary.js';
import {
  buildSakuraMessages, buildSakuraUserText, buildSakuraPrompt,
  buildGlossaryText, parseSakuraResponse, SAKURA_SYSTEM, SAKURA_USER_PLAIN,
  extractQuoteContent
} from '../src/mt.js';
import * as model from '../src/model.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function readSample(name){
  return readFileSync(resolve(ROOT, name), 'utf-8');
}

/* ---------------- 解析 ---------------- */

test('parsePrefix: 内联说话人 / TEXT / 空说话人 / NAME / 非标准行', () => {
  assert.deepEqual(parsePrefix('☆0003☆桐吾☆「ありがとう」'), { prefix: '☆0003☆桐吾☆', content: '「ありがとう」', id: '0003', name: '桐吾', named: false });
  assert.deepEqual(parsePrefix('☆TEXT|0☆数日が経ち…'), { prefix: '☆TEXT|0☆', content: '数日が経ち…', id: 'TEXT|0', name: '', named: false });
  assert.deepEqual(parsePrefix('☆0000☆☆変わり続ける未来'), { prefix: '☆0000☆☆', content: '変わり続ける未来', id: '0000', name: '', named: false });
  assert.deepEqual(parsePrefix('☆NAME|4☆ティナ'), { prefix: '☆NAME|4☆', content: 'ティナ', id: 'NAME|4', name: '', named: false });
  assert.deepEqual(parsePrefix('普通的一行'), { prefix: '', content: '普通的一行', id: '', name: '', named: false });
});

test('makePara: 字段与 done 计算', () => {
  const p = makePara('☆0003☆桐吾☆「ありがとう」');
  assert.equal(p.id, '0003');
  assert.equal(p.name, '桐吾');
  assert.equal(p.nameTr, '桐吾');
  assert.equal(p.brackets, true);
  assert.equal(p.done, false);
  assert.equal(p.translation, '');

  const p2 = makePara('☆0003☆桐吾☆「ありがとう」', '「谢谢」');
  assert.equal(p2.translation, '「谢谢」');
  assert.equal(p2.done, true);
  assert.equal(transValue(p2), '谢谢'); // 括号内有效

  const p3 = makePara('☆NAME|4☆ティナ');
  assert.equal(p3.isName, true);
  assert.equal(p3.name, 'ティナ');
  assert.equal(p3.nameTr, 'ティナ');
  assert.equal(p3.done, true, 'NAME 行名字框有内容(原文名)即已翻译');

  const p4 = makePara('☆TEXT|0☆場面転換。');
  assert.equal(p4.id, 'TEXT|0');
  assert.equal(p4.segs.join(','), 'TEXT|0');
  assert.equal(p4.brackets, false);

  const p5 = makePara('☆0002☆☆　放課後…');
  assert.deepEqual(p5.segs, ['0002', '']);
  assert.equal(p5.name, '');
});

test('makePara: ★ 行与 ☆ 行内容相同(占位译文)保留原文,不误伤无损往返', () => {
  // 占位译文在解析/导出阶段原样保留(保证导出无损还原),由 mergeSavedState 在恢复时视为未翻译
  const p = makePara('☆TEXT|1☆「その表現は、それはいろいろと語弊があると思う」', '「その表現は、それはいろいろと語弊があると思う」');
  assert.equal(p.translation, '「その表現は、それはいろいろと語弊があると思う」', '解析阶段保留占位译文');
  // 真实译文不受影响
  const p3 = makePara('☆TEXT|0☆「ここがリア充の聖地、ラブホテルっすか〜！」', '「这里就是现充的圣地，爱情旅馆啊！」');
  assert.equal(p3.translation, '「这里就是现充的圣地，爱情旅馆啊！」');
  assert.equal(p3.done, true);
});

test('parseFile: #NOTTRANS 注释行剥离附着,正文正常提取且导出无损', () => {
  const text = '#NOTTRANS\n☆0000☆☆　今日もパス移動をして、そして家へと帰ってくる。\n★0000★★　今天也是通过路径移动回到了家。\n\n' +
               '#NOTTRANS\n☆0001☆創眞☆「ふぅ……ただいま」\n★0001★创真★「呼……我回来了」\n';
  const { paras, nl, trailingBlank } = parseFile(text);
  assert.equal(paras.length, 2);
  assert.equal(paras[0].id, '0000', '#NOTTRANS 不再被当作原文行');
  assert.equal(paras[0].content.startsWith('　今日も'), true, '正文正确提取');
  assert.deepEqual(paras[0].comments, ['#NOTTRANS'], '注释行附着到段落');
  assert.equal(paras[1].id, '0001');
  // 导出还原 #NOTTRANS 到原文行之前,字节级一致
  assert.equal(buildExport(paras, nl, trailingBlank), text, '导出还原注释行,字节级一致');
  assert.equal(paras.filter(p => !p.id).length, 0, '无编号行应为 0');
});

test('makePara: 【宗一郎】角括号包裹的名字识别,导出还原括号', () => {
  const p = makePara('☆NAME|7☆【宗一郎】', '【宗一郎】');
  assert.equal(p.isName, true);
  assert.equal(p.name, '宗一郎', '名字取括号内');
  assert.equal(p.nameWrap, true);
  assert.equal(p.nameTr, '宗一郎', '译名同样剥括号');
  // 导出自动还原括号
  const out = buildExport([p], '\n', false);
  assert.ok(out.includes('★NAME|7★【宗一郎】'), '导出还原【】');
  // 用户输入不带括号的译名,导出仍自动加括号
  p.nameTr = '宗一郎';
  const out2 = buildExport([p], '\n', false);
  assert.ok(out2.includes('★NAME|7★【宗一郎】'));
  // 无括号的名字行不受影响
  const p2 = makePara('☆NAME|4☆ティナ');
  assert.equal(p2.nameWrap, false);
});

test('makePara: N 后缀编号(000001N)判定为名字行,T 后缀不是', () => {
  const p = makePara('☆000001N☆里奈', '里奈');
  assert.equal(p.isName, true, 'N 后缀编号 → 名字行');
  assert.equal(p.name, '里奈', '正文即说话人');
  assert.equal(p.done, true);
  // 导出格式不变: ★000001N★名字
  const out = buildExport([p], '\n', false);
  assert.ok(out.includes('★000001N★里奈'), 'N 后缀名字行导出格式与原文件一致');

  const p2 = makePara('☆000002T☆「どうやって…」');
  assert.equal(p2.isName, false, 'T 后缀不是名字行');
  const p3 = makePara('☆000000R☆APPEND');
  assert.equal(p3.isName, false, 'R 后缀不是名字行');
  const p4 = makePara('☆0000000A☆十六进制编号');
  assert.equal(p4.isName, false, '十六进制编号(结尾 A)不是名字行');
});

test('stripBrackets / transValue', () => {
  assert.equal(stripBrackets('「内容」'), '内容');
  assert.equal(stripBrackets('「只有开头'), '「只有开头');
  assert.equal(stripBrackets('内容」'), '内容」');
  assert.equal(stripBrackets(''), '');
});

test('parseFile + buildExport: 示例文件全量解析与无损还原', () => {
  // 选取可字节级无损往返的样本(N 后缀名字行 / TEXT+NAME 编号,均以换行结尾)
  const cases = [
    { file: '新建 文本文档 (3).txt', paras: 18, names: 9 },
    { file: '新建 文本文档 (5).txt', paras: 20, names: 2 },
  ];
  for (const c of cases){
    const text = readSample('test text/' + c.file);
    const { paras, nl, trailingBlank } = parseFile(text);
    assert.equal(paras.length, c.paras, c.file + ' 段数');
    assert.equal(paras.filter(p => p.isName).length, c.names, c.file + ' NAME 数');
    assert.equal(paras.filter(p => !p.id).length, 0, c.file + ' 不应有无编号行');

    // 未编辑时导出 = 原文件(证明解析-导出无损)
    const out = buildExport(paras, nl, trailingBlank);
    assert.equal(out, text, c.file + ' 导出应与原文件一致');
  }
});

test('buildStarPrefix: 说话人段用 nameTr;空说话人追加', () => {
  const p = makePara('☆0003☆桐吾☆「…」');
  p.nameTr = '桐吾';
  assert.equal(buildStarPrefix(p), '★0003★桐吾★');
  const p2 = makePara('☆TEXT|0☆…');
  assert.equal(buildStarPrefix(p2), '★TEXT|0★');
  const p3 = makePara('☆0002☆☆…');
  p3.nameTr = '';
  assert.equal(buildStarPrefix(p3), '★0002★★');
  const p4 = makePara('☆0005☆☆…');
  p4.nameTr = '旁白';
  assert.equal(buildStarPrefix(p4), '★0005★旁白★');
});

test('setParseConf: 自定义标记/正则可配置解析与导出', () => {
  // 换成 @ 原文 / # 译文
  setParseConf({ open: '@', close: '#', regex: '' });
  assert.deepEqual(parsePrefix('@0003@桐吾@「こんにちは」'), { prefix: '@0003@桐吾@', content: '「こんにちは」', id: '0003', name: '桐吾', named: false });
  const p = makePara('@0003@桐吾@「こんにちは」', '「你好」');
  assert.equal(p.id, '0003');
  assert.equal(p.name, '桐吾');
  assert.equal(p.brackets, true);
  // 译文行前缀用 close(#)
  const segs = p.segs.slice(); segs[1] = p.nameTr;
  assert.equal(parseConf.close + segs.join(parseConf.close) + parseConf.close + p.translation, '#0003#桐吾#「你好」');
  // 自定义正则
  setParseConf({ open: '@', close: '#', regex: '^([@#][^@#]*[@#])([\\s\\S]*)$' });
  assert.deepEqual(parsePrefix('@TEXT|0@場面転換。'), { prefix: '@TEXT|0@', content: '場面転換。', id: 'TEXT|0', name: '', named: false });
  // 还原默认,避免影响其他用例
  setParseConf({ open: '☆', close: '★', regex: '' });
  assert.deepEqual(parsePrefix('☆0003☆桐吾☆「こんにちは」'), { prefix: '☆0003☆桐吾☆', content: '「こんにちは」', id: '0003', name: '桐吾', named: false });
});

/* ---------------- 搜索 / 替换 ---------------- */

function paras3(){
  return [
    makePara('☆0000☆☆判断基準は面白さ', '判断标准是有趣'),
    makePara('☆0001☆ゆゆ☆「ごめんね」', ''),
    makePara('☆NAME|2☆ティナ'),
  ];
}

test('computeMatches: 范围与大小写', () => {
  const ps = paras3();
  assert.equal(computeMatches(ps, '判断', 'orig', false).length, 1);
  assert.equal(computeMatches(ps, '判断', 'trans', false).length, 1);
  assert.equal(computeMatches(ps, '判断', 'all', false).length, 2);
  const n = computeMatches(ps, 'ティナ', 'name', false);
  assert.equal(n.length, 1);
  assert.equal(n[0].col, 'name');
  // 大小写: 英文词
  const pe = [makePara('☆TEXT|0☆Apple Watch')];
  assert.equal(computeMatches(pe, 'apple', 'orig', false).length, 1);
  assert.equal(computeMatches(pe, 'apple', 'orig', true).length, 0);
});

test('replaceOnce: 只改译文/名字,原文永不修改', () => {
  const ps = paras3();
  const origLine = ps[0].orig;
  const m = computeMatches(ps, '判断', 'trans', false)[0];
  assert.equal(replaceOnce(ps[0], m, '标准'), true);
  assert.equal(ps[0].translation, '标准标准是有趣');
  assert.equal(ps[0].orig, origLine, '原文不得被修改');

  const mOrig = computeMatches(ps, '判断基準', 'orig', false)[0];
  assert.equal(replaceOnce(ps[0], mOrig, 'X'), false, '原文匹配不可替换');
  assert.equal(ps[0].orig, origLine);
});

test('replaceAllInParas + countMatches', () => {
  const ps = [
    makePara('☆TEXT|0☆a', 'xa'),
    makePara('☆TEXT|1☆b', 'xax'),
  ];
  const c = countMatches(ps, 'a', 'trans', false);
  assert.equal(c.total, 2);
  assert.equal(c.nameTotal, 0);
  const r = replaceAllInParas(ps, 'a', 'X', 'trans', false);
  assert.equal(r.total, 2);
  assert.equal(ps[0].translation, 'xX');
  assert.equal(ps[1].translation, 'xXx');
  // 原文不变
  assert.equal(ps[0].orig, '☆TEXT|0☆a');
});

test('replaceAllText 大小写感知', () => {
  assert.equal(replaceAllText('Apple apple', 'apple', 'X', false), 'X X');
  assert.equal(replaceAllText('Apple apple', 'apple', 'X', true), 'Apple X');
  assert.equal(replaceAllText('abc', 'z', 'X', false), 'abc');
});

test('jumpToIndex: 数字末尾 / 完整编号', () => {
  const ps = [
    makePara('☆0003☆A☆x'),
    makePara('☆TEXT|0☆x'),
    makePara('☆NAME|4☆x'),
  ];
  assert.equal(jumpToIndex(ps, '3'), 0);
  assert.equal(jumpToIndex(ps, 'TEXT|0'), 1);
  assert.equal(jumpToIndex(ps, 'name|4'), 2, '忽略大小写');
  assert.equal(jumpToIndex(ps, '999'), -1);
});

/* ---------------- 术语表 ---------------- */

test('scanTerms: 长词条优先、不重叠、多命中', () => {
  const terms = { '幸福': '幸福', '幸福生活': '幸福生活' };
  const hits = scanTerms('追求幸福生活就是幸福', terms);
  // 长词条优先: '幸福生活' 先命中,后面的 '幸福' 单独命中
  assert.deepEqual(hits.map(h => h.src), ['幸福生活', '幸福']);
  assert.equal(hits[0].from, 2);
  assert.equal(hits[0].to, 6);
});

test('buildOrigHighlights: 只高亮本行的搜索匹配,其他行匹配不污染', () => {
  // 两行原文;搜索词在 0 行出现,1 行不出现
  const content0 = '今日は観覧車に乗った。';
  const content1 = '学園に着いた。';
  const matches = [
    { i: 0, col: 'orig', from: 3, to: 6 }, // 観覧車 在第 0 行 [3,6]
  ];
  const u0 = buildOrigHighlights(0, content0, matches, {});
  const u1 = buildOrigHighlights(1, content1, matches, {});
  // 第 0 行: 有 1 个 mark 区间
  assert.deepEqual(u0, [{ from: 3, to: 6, type: 'mark', data: null }]);
  // 第 1 行: 不得有任何高亮(回归: 曾把所有行的匹配画到每一行)
  assert.deepEqual(u1, []);
});

test('buildOrigHighlights: 搜索高亮与术语命中合并,术语不越界', () => {
  const content = '観覧車に乗った。';
  const matches = [{ i: 0, col: 'orig', from: 0, to: 3 }]; // 搜索 観覧車
  const terms = { '観覧車': '摩天轮' };
  const u = buildOrigHighlights(0, content, matches, terms);
  // term 优先: 术语与搜索区间重叠时保留 term(可点击),非重叠部分仍是 mark
  assert.deepEqual(u, [{ from: 0, to: 3, type: 'term', data: '摩天轮' }]);

  // 非术语的搜索匹配仍为 mark
  const u2 = buildOrigHighlights(0, '乗った。', [{ i: 0, col: 'orig', from: 0, to: 2 }], {});
  assert.deepEqual(u2, [{ from: 0, to: 2, type: 'mark', data: null }]);
});

test('applyNames: 只应用未手动改过的名字', () => {
  const names = { 'ティナ': '蒂娜', '大和': '大和' };
  const ps = [
    makePara('☆NAME|4☆ティナ'),
    makePara('☆0001☆大和☆「こんにちは」'),
    makePara('☆NAME|5☆ティナ'), // 手动改过的不动
  ];
  ps[2].nameTr = '缇娜';
  assert.equal(applyNames(ps, names), 2);
  assert.equal(ps[0].nameTr, '蒂娜');
  assert.equal(ps[1].nameTr, '大和');
  assert.equal(ps[2].nameTr, '缇娜', '手动改过的不应被覆盖');
});

// 自动确认: NAME 行名字框有内容(原文名/译名)即算已翻译,无需手动标记。
test('NAME 行: 名字框有内容即已翻译(自动确认)', () => {
  // 1) 未导入译文的 NAME 行: 名字框兜底为原文名 → 直接已翻译(如「大和」同名)
  const p = makePara('☆NAME|4☆大和');
  assert.equal(p.name, '大和');
  assert.equal(p.done, true, '名字框有原文名 → 已翻译');

  // 2) 日文名未翻译也默认已翻译(名字框有内容),清空名字框才回到未翻译
  const p2 = makePara('☆NAME|4☆ティナ');
  assert.equal(p2.done, true, '有名字即已翻译');
  p2.nameTr = '';
  model.recalcDone(p2);
  assert.equal(p2.done, false, '清空名字框 → 未翻译');
  p2.nameTr = '蒂娜';
  model.recalcDone(p2);
  assert.equal(p2.done, true, '输入译名 → 已翻译');

  // 3) 正文行不受影响: 译文为空仍算未翻译
  const p3 = makePara('☆TEXT|0☆こんにちは');
  assert.equal(p3.done, false, '正文行译文为空 → 未翻译');
});

// 回归: NAME 行改译名后 done 保持一致(替换/人名自动应用路径需调用 recalcDone)
test('NAME 行译名变更后 done 同步刷新', () => {
  const p = makePara('☆NAME|4☆ティナ');
  assert.equal(p.done, true, 'NAME 行初始已翻译');

  // 1) 仅名字单次替换 replaceOnce
  const m = computeMatches([p], 'ティナ', 'name', false)[0];
  assert.equal(replaceOnce(p, m, '蒂娜'), true);
  assert.equal(p.done, true, 'replaceOnce 改译名后 done 仍为 true');

  // 2) 仅名字批量替换 replaceAllInParas
  const ps2 = [makePara('☆NAME|4☆ティナ')];
  const r = replaceAllInParas(ps2, 'ティナ', '蒂娜', 'name', false);
  assert.equal(r.nameTotal, 1);
  assert.equal(ps2[0].done, true, 'replaceAllInParas 改译名后 done 仍为 true');

  // 3) 人名自动应用 applyNames(未手动改过)
  const ps3 = [makePara('☆NAME|4☆ティナ')];
  assert.equal(applyNames(ps3, { 'ティナ': '蒂娜' }), 1);
  assert.equal(ps3[0].done, true, 'applyNames 自动应用译名后 done 仍为 true');
});

test('applyTermsToTranslations: 只改译文,原文不动;跳过 NAME 与空行', () => {
  const terms = { '観覧車': '摩天轮', '学園': '学院' };
  const ps = [
    makePara('☆TEXT|1☆観覧車に乗る。', '坐観覧車去。'),
    makePara('☆NAME|4☆ティナ', '蒂娜'),
    makePara('☆TEXT|2☆学園。', ''), // 空译文跳过
  ];
  const total = applyTermsToTranslations(ps, terms);
  assert.equal(total, 1);
  assert.equal(ps[0].translation, '坐摩天轮去。');
  assert.equal(ps[0].orig, '☆TEXT|1☆観覧車に乗る。');
  assert.equal(ps[2].translation, '');
});

test('applyTermsToTranslations: 一次扫描非重叠替换,避免连环替换', () => {
  // 词条 A 的译文恰是词条 B 的原文: 不得二次替换
  const terms = { '観覧車': '摩天轮', '摩天轮': '摩天輪' };
  const ps = [makePara('☆TEXT|0☆x', '乗観覧車')];
  const total = applyTermsToTranslations(ps, terms);
  assert.equal(total, 1);
  assert.equal(ps[0].translation, '乗摩天轮', '替换出的"摩天轮"不应再被替换为"摩天輪"');
});

test('recordNameIfNew: 新名字才记录,原名不记录', () => {
  const names = {};
  assert.equal(recordNameIfNew(names, 'ティナ', '蒂娜'), true);
  assert.equal(names['ティナ'], '蒂娜');
  assert.equal(recordNameIfNew(names, 'ティナ', '蒂娜'), false, '重复不记录');
  assert.equal(recordNameIfNew(names, 'ティナ', 'ティナ'), false, '未翻译不记录');
});

test('normalizeDirPath / projectGlossaryPath: \ 与 / 混用统一为 /,路径规范', () => {
  assert.equal(normalizeDirPath('E:\\game\\scene1'), 'E:/game/scene1');
  assert.equal(normalizeDirPath('E:/game/scene1/'), 'E:/game/scene1');
  assert.equal(normalizeDirPath('  E:\\game\\scene1\\  '), 'E:/game/scene1');
  assert.equal(normalizeDirPath(''), '');
  assert.equal(normalizeDirPath(null), '');
  // 正/反斜杠混用的同一目录 → 同一规范路径
  assert.equal(
    normalizeDirPath('E:\\game/scene1\\'),
    normalizeDirPath('E:/game\\scene1')
  );
  assert.equal(projectGlossaryPath('E:/game/scene1'), 'E:/game/scene1/glossary.json');
  assert.equal(projectGlossaryPath('E:\\game\\scene1'), 'E:/game/scene1/glossary.json');
  assert.equal(projectGlossaryPath(null), null);
  assert.equal(projectGlossaryPath(''), null);
});

/* ---------------- 机器翻译(Sakura) ---------------- */

test('buildGlossaryText: 人名词条合并、去重、跳过无效', () => {
  const names = { 'ティナ': '蒂娜', '大和': '大和' }; // 未翻译(同名)跳过
  const terms = { '観覧車': '摩天轮', '観覧車': '摩天轮' }; // 重复键 JS 自动去重
  const g = buildGlossaryText(names, terms);
  assert.ok(g.includes('ティナ<|sep|>蒂娜'), '人名进入术语表');
  assert.ok(g.includes('観覧車<|sep|>摩天轮'), '词条进入术语表');
  assert.ok(!g.includes('大和'), '未翻译(同名)不进入');
});

test('buildSakuraUserText / Messages: 带/不带术语表', () => {
  // 无术语表 → 简化 prompt
  assert.equal(buildSakuraUserText('こんにちは', ''), SAKURA_USER_PLAIN + 'こんにちは');
  // 带术语表 → v1.0 格式
  const t = buildSakuraUserText('こんにちは', 'ティナ<|sep|>蒂娜');
  assert.ok(t.includes('根据以下术语表'), '含术语表提示词');
  assert.ok(t.endsWith('こんにちは'));
  // messages: system = 官方翻译提示
  const msgs = buildSakuraMessages('こんにちは', '');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, SAKURA_SYSTEM);
  assert.equal(msgs[1].role, 'user');
  // ChatML prompt 包含 <|im_start|>/<|im_end|> 与 assistant 收尾
  const p = buildSakuraPrompt('こんにちは', '');
  assert.ok(p.includes('<|im_start|>system'));
  assert.ok(p.includes('<|im_start|>assistant'));
  assert.ok(p.endsWith('<|im_start|>assistant\n'));
});

test('parseSakuraResponse: OpenAI 格式 / llama.cpp 格式 / 错误', () => {
  assert.equal(
    parseSakuraResponse({ choices: [{ message: { content: '  你好  ' } }] }),
    '你好'
  );
  assert.equal(parseSakuraResponse({ content: '你好' }), '你好');
  assert.throws(() => parseSakuraResponse({ error: 'boom' }), /boom/);
  assert.throws(() => parseSakuraResponse({}), /无法识别/);
});

test('extractQuoteContent: 对话只发「」内,旁白直接返回原文', () => {
  assert.equal(extractQuoteContent('「こんにちは」'), 'こんにちは');
  assert.equal(extractQuoteContent('「ありがとう、\n　みんな！」'), 'ありがとう、\n　みんな！', '含软换行的对话');
  assert.equal(extractQuoteContent('数日が経ち、約束の日曜日となった。'), '数日が経ち、約束の日曜日となった。', '旁白原样');
  assert.equal(extractQuoteContent('「只有开头'), '「只有开头', '不成对不剥');
  assert.equal(extractQuoteContent(''), '');
});

test('migrateNameTranslations: NAME 行误存译文迁移到 nameTr', () => {
  // 历史数据: NAME 行 nameTr 未改,translation 被误存了名字
  const ps = [
    makePara('☆NAME|4☆ティナ', '蒂娜'),           // 误存 translation='蒂娜'
    makePara('☆NAME|5☆大和', ''),                 // 正常未改
    makePara('☆0001☆ゆゆ☆「こんにちは」', '「你好」'), // 普通行不动
  ];
  const n = migrateNameTranslations(ps);
  assert.equal(n, 1, '只迁移误存的 NAME 行');
  assert.equal(ps[0].nameTr, '蒂娜', '误存译文转正到 nameTr');
  assert.equal(ps[0].translation, '', '误存译文被清空');
  assert.equal(ps[1].nameTr, '大和', '未误存的不动');
  assert.equal(ps[1].translation, '');
  assert.equal(ps[2].translation, '「你好」', '普通行完全不动');
});

/* ---------------- 撤销 / 重做 ---------------- */

test('model: undo/redo 增量快照', () => {
  const ps = [makePara('☆TEXT|0☆x', '原译文'), makePara('☆TEXT|1☆y', '')];
  model.setParas(ps);

  model.pushUndo([0]);
  ps[0].translation = '新译文';
  model.recalcDone(ps[0]);
  assert.equal(ps[0].translation, '新译文');

  assert.equal(model.undo(), true);
  assert.equal(ps[0].translation, '原译文');
  assert.equal(model.canUndo(), false);

  assert.equal(model.redo(), true);
  assert.equal(ps[0].translation, '新译文');
  assert.equal(model.canRedo(), false);
});

test('model: 批量操作整步撤销(全部替换场景)', () => {
  const ps = [makePara('☆TEXT|0☆x', 'ab'), makePara('☆TEXT|1☆y', 'ba')];
  model.setParas(ps);
  model.pushUndo([0, 1]); // 全部替换: 记录受影响的所有行
  ps[0].translation = 'Xb';
  ps[1].translation = 'bX';
  assert.equal(model.undo(), true);
  assert.equal(ps[0].translation, 'ab');
  assert.equal(ps[1].translation, 'ba');
  assert.equal(model.redo(), true);
  assert.equal(ps[0].translation, 'Xb');
  assert.equal(ps[1].translation, 'bX');
});

test('model: 连续快照依序撤销', () => {
  const ps = [makePara('☆TEXT|0☆x', '')];
  model.setParas(ps);
  model.pushUndo([0]);
  ps[0].translation = 'a';
  model.pushUndo([0]);
  ps[0].translation = 'ab';
  model.pushUndo([0]);
  ps[0].translation = 'abc';
  assert.equal(model.canUndo(), true);
  model.undo();
  assert.equal(ps[0].translation, 'ab', '撤销到上一快照');
  model.undo();
  assert.equal(ps[0].translation, 'a');
  model.undo();
  assert.equal(ps[0].translation, '');
  assert.equal(model.canUndo(), false);
});

/* ---------------- 恢复进度合并(mergeSavedState) ---------------- */

// 文件自带译文优先,进度只补文件未翻译的行 —— 修复"导入有翻译的文本仍显示空白,删 AppData 才好"
test('mergeSavedState: 文件已带译文 → 保留文件译文,不被陈旧进度覆盖', () => {
  const fresh = [
    makePara('☆TEXT|0☆甲', '「甲译文」'),   // 文件里已有译文(带括号)
    makePara('☆TEXT|1☆乙', ''),             // 文件未翻译 → 用进度补
  ];
  const saved = [
    { orig: '☆TEXT|0☆甲', translation: '旧甲', nameTr: '' }, // 陈旧的缓存译文
    { orig: '☆TEXT|1☆乙', translation: '「乙译文」', nameTr: '' },
  ];
  const out = mergeSavedState(fresh, saved);
  assert.equal(out[0].translation, '「甲译文」', '文件已翻译的行不被缓存覆盖');
  assert.equal(out[1].translation, '「乙译文」', '未翻译的行补上缓存译文');
  assert.equal(out[0].done, true);
  assert.equal(out[1].done, true);
});

// 文件里带"★ == ☆"日文占位时,恢复进度应能补上缓存译文(修复占位行挡路问题)
test('mergeSavedState: 占位译文行(★ 与 ☆ 相同)可被缓存译文补上', () => {
  const fresh = [
    makePara('☆TEXT|0☆「ここがリア充の聖地、ラブホテルっすか〜！」', '「ここがリア充の聖地、ラブホテルっすか〜！」'), // 占位
    makePara('☆TEXT|1☆僕も初めて訪れたけれど、きれいな宿泊ホテルって感じだ。', '僕も初めて訪れたけれど、きれいな宿泊ホテルって感じだ。'), // 占位
  ];
  const saved = [
    { orig: '☆TEXT|0☆「ここがリア充の聖地、ラブホテルっすか〜！」', translation: '「这里就是现充的圣地，爱情旅馆啊！」', nameTr: '' },
    { orig: '☆TEXT|1☆僕も初めて訪れたけれど、きれいな宿泊ホテルって感じだ。', translation: '我也是第一次来这里，只觉得是家漂亮的旅馆。', nameTr: '' },
  ];
  const out = mergeSavedState(fresh, saved);
  assert.equal(out[0].translation, '「这里就是现充的圣地，爱情旅馆啊！」', '占位行被缓存译文补上');
  assert.equal(out[1].translation, '我也是第一次来这里，只觉得是家漂亮的旅馆。');
  assert.equal(out[0].done, true);
  assert.equal(out[1].done, true);
});

// 按原文对齐: 行号错位也能把译文补到正确的行(不按行号硬搬)
test('mergeSavedState: 按 orig 精确对齐,行号错位不串行', () => {
  const fresh = [
    makePara('☆TEXT|0☆A'),
    makePara('☆TEXT|1☆B'),
    makePara('☆TEXT|2☆C'),
  ];
  const saved = [
    { orig: '☆TEXT|2☆C', translation: '「C译」', nameTr: '' }, // 顺序颠倒
    { orig: '☆TEXT|1☆B', translation: '「B译」', nameTr: '' },
  ];
  const out = mergeSavedState(fresh, saved);
  assert.equal(out[0].translation, '');
  assert.equal(out[1].translation, '「B译」');
  assert.equal(out[2].translation, '「C译」');
});

// 名字: 文件 ★ 行已指定译名 → 保留;未指定才用进度里的译名
test('mergeSavedState: 名字合并只补未指定译名的行', () => {
  const fresh = [
    makePara('☆0003☆桐吾☆「ありがとう」', '', '桐吾'),   // 未指定译名
    makePara('☆0004☆沙織☆「こんにちは」', '', '沙织'),   // 已指定译名
  ];
  const saved = [
    { orig: '☆0003☆桐吾☆「ありがとう」', translation: '', nameTr: 'togo' },
    { orig: '☆0004☆沙織☆「こんにちは」', translation: '', nameTr: '旧名' },
  ];
  const out = mergeSavedState(fresh, saved);
  assert.equal(out[0].nameTr, 'togo', '未指定译名 → 用进度里的');
  assert.equal(out[1].nameTr, '沙织', '已指定译名 → 保留文件的');
});

// 进度里不存在原文的行 → 原样保留文件状态
test('mergeSavedState: 进度里没有的原文行原样保留', () => {
  const fresh = [makePara('☆TEXT|0☆A'), makePara('☆TEXT|1☆B', '「B译」')];
  const saved = [{ orig: '☆TEXT|0☆A', translation: '', nameTr: '' }];
  const out = mergeSavedState(fresh, saved);
  assert.equal(out[0].translation, '');
  assert.equal(out[1].translation, '「B译」');
  assert.equal(out[1].done, true);
});

/* ---------------- 解析规则自定义正则 ---------------- */

// 换用 @/& 标记格式: parsePrefix 应能通过自定义正则正确拆分
test('parsePrefix: 自定义 @/& 标记正则生效', () => {
  const prev = getParseConf();
  try {
    setParseConf({ open: '@', close: '&', regex: '' }); // 标准结构按 @/& 生成
    assert.deepEqual(parsePrefix('@0003@桐吾@「ありがとう」'), { prefix: '@0003@桐吾@', content: '「ありがとう」', id: '0003', name: '桐吾', named: false });
    assert.deepEqual(parsePrefix('@NAME|4@ティナ'), { prefix: '@NAME|4@', content: 'ティナ', id: 'NAME|4', name: '', named: false });
  } finally {
    setParseConf(prev);
  }
});

// 显式自定义正则(第1组=前缀,第2组=正文),覆盖内置标记格式
test('parsePrefix: 显式自定义正则覆盖标记格式', () => {
  const prev = getParseConf();
  try {
    // 契约: 第1组=前缀(<编号> → 捕获组只取 0009), 第2组=正文([正文] → 捕获组只取 こんにちは)
    setParseConf({ open: '☆', close: '★', regex: '^<(.+?)>\\[(.+)\\]$' });
    assert.deepEqual(parsePrefix('<0009>[こんにちは]'), { prefix: '0009', content: 'こんにちは', id: '', name: '', named: false });
    // 未匹配的行回退为整行正文
    assert.deepEqual(parsePrefix('普通的一行'), { prefix: '', content: '普通的一行', id: '', name: '', named: false });
  } finally {
    setParseConf(prev);
  }
});

// 自定义正则 + 非标准文件: 解析出的字段(编号/正文/导出)正确
test('parsePrefix: 自定义格式下的完整解析与导出', () => {
  const prev = getParseConf();
  try {
    setParseConf({ open: '☆', close: '★', regex: '^<(.+?)>\\[(.+)\\]$' });
    // 空行分隔两段: 带前缀的原文行 + 无前缀普通行
    const parsed = parseFile('<0001>[abc]\n\n普通行\n');
    assert.equal(parsed.paras.length, 2);
    assert.equal(parsed.paras[0].prefix, '0001');
    assert.equal(parsed.paras[0].content, 'abc');
    assert.equal(parsed.paras[1].content, '普通行');
    const out = buildExport(parsed.paras, parsed.nl, parsed.trailingBlank);
    assert.ok(out.includes('<0001>[abc]'), '原文行保留');
    assert.ok(out.includes('普通行'), '普通行保留');
  } finally {
    setParseConf(prev);
  }
});

/* ---------------- 可复用规则: 注释前缀 / 名字行模式 / 命名捕获组 ---------------- */

// 注释前缀外置: 默认 # ; // % 识别,自定义后可整行跳过(如 // 指令行)
test('parseFile: 注释前缀可配置(#/;/非默认),注释行附着在段落上', () => {
  const prev = getParseConf();
  try {
    // 默认前缀: # 开头的 #NOTTRANS 作为注释剥离
    let parsed = parseFile('#NOTTRANS\n☆0001☆A☆「x」\n★0001★A★「y」\n\n#NOTTRANS\n☆0002☆☆x\n★0002★★y\n');
    assert.equal(parsed.paras.length, 2);
    assert.deepEqual(parsed.paras[0].comments, ['#NOTTRANS']);
    assert.equal(parsed.paras[0].content, '「x」');
    // 自定义前缀: // 行也按注释剥离,不再当原文行
    setParseConf({ commentPrefixes: ['#', ';', '//', '%'] });
    parsed = parseFile('// 注释\n☆0001☆A☆「x」\n★0001★A★「y」\n');
    assert.equal(parsed.paras.length, 1);
    assert.deepEqual(parsed.paras[0].comments, ['// 注释']);
    assert.equal(parsed.paras[0].content, '「x」');
    // 清空前缀: // 行重新成为正文(视为普通行)
    setParseConf({ commentPrefixes: [] });
    parsed = parseFile('// 指令\n☆0001☆A☆「x」\n★0001★A★「y」\n');
    assert.equal(parsed.paras[0].comments || 0, 0);
  } finally {
    setParseConf(prev);
  }
});

// 名字行模式外置: 编号命中配置模式即按名字行处理(正文=名字,自动已翻译)
test('makePara: 名字行编号模式可配置', () => {
  const prev = getParseConf();
  try {
    // 默认: N 后缀(000001N)与 NAME|n 是名字行
    assert.equal(makePara('☆000001N☆里奈', '').isName, true);
    assert.equal(makePara('☆000001☆里奈', '').isName, false);
    // 自定义模式: S 后缀也按名字行
    setParseConf({ nameIdPatterns: ['^[0-9A-Fa-f]+[NS]$'] });
    assert.equal(makePara('☆000001S☆里奈', '').isName, true);
    assert.equal(makePara('☆NAME|1☆里奈', '').isName, false, '模式不含 ^NAME 时 NAME|n 不再当名字行');
    // 空模式 = 所有行都不按名字行
    setParseConf({ nameIdPatterns: [] });
    assert.equal(makePara('☆000001N☆里奈', '').isName, false);
  } finally {
    setParseConf(prev);
  }
});

// 命名捕获组正则: (?<id>…)(?<name>…)?(?<content>…) 直接指定编号/说话人/正文
test('parsePrefix: 命名捕获组正则(id/name/content)', () => {
  const prev = getParseConf();
  try {
    setParseConf({ open: '☆', close: '★', regex: '^<(?<id>\\d+)>(?:\\[(?<name>.*?)\\])?(?<content>[\\s\\S]*)$' });
    const pp = parsePrefix('<0003>[桐吾]「ありがとう」');
    assert.equal(pp.named, true);
    assert.equal(pp.id, '0003');
    assert.equal(pp.name, '桐吾');
    assert.equal(pp.content, '「ありがとう」');
    const p = makePara('<0003>[桐吾]「ありがとう」', '「谢谢」');
    assert.equal(p.id, '0003');
    assert.equal(p.name, '桐吾');
    assert.equal(p.content, '「ありがとう」');
    // 无名字段: id 直取,content 紧随
    const p2 = makePara('<0004>今日はいい天気', '');
    assert.equal(p2.id, '0004');
    assert.equal(p2.name, '');
    assert.equal(p2.content, '今日はいい天気');
  } finally {
    setParseConf(prev);
  }
});

// 识别产出的规则档案可直接喂给编辑器解析器(可复用闭环)
test('parseFile: 识别档案 parseConfig 直接复用解析原格式', () => {
  const prev = getParseConf();
  try {
    const text = '○00000|000008|003○ [[照]] 「むにゃ」[np]\n●00000|000008|003● [[照]] 「唔喵」[np]\n\n○00001|00000E|003○ [[久遠]] 「……すごい」[np]\n●00001|00000E|003● [[久远]] 「……好厉害」[np]\n';
    const profile = detect(text, 't');
    setParseConf(profile.parseConfig);
    const parsed = parseFile(text);
    assert.equal(parsed.paras.length, 2);
    assert.equal(parsed.paras[0].id, '00000|000008|003');
    assert.equal(parsed.paras[0].name, '', '[[名字]] 在正文内,编辑器名字栏本就不提取');
    assert.equal(parsed.paras[0].content, ' [[照]] 「むにゃ」[np]');
    const out = buildExport(parsed.paras, parsed.nl, parsed.trailingBlank);
    assert.equal(out, text, '识别配置 + 解析器 = 原文件无损');
  } finally {
    setParseConf(prev);
  }
});
