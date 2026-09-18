// lineparse.test.mjs — 行保真解析器单测
//
// 两部分：
//   1) 构造用例，锁定识别规则（人名/对话/旁白 + 行角色 + 列区间）
//   2) 交叉验证：对 test text/ 下全部真实样本，比对 parseLines 与 parseFile
//      的段落数与 done 口径 —— 防止新解析器与桌面版引擎分叉

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseLines, paraAtLine, isBracketed, hasQuote, isMirrorDoc, mirrorPlainLineOf, ROLE, KIND,
} from '../src/lineparse.js';
import { parseFile, setParseConf, getParseConf } from '../../src/parsers.js';
import { isMirrorFormatText } from '../../src/universal-parser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.resolve(HERE, '../../test text');

/* ---------------- 1. 识别规则 ---------------- */

test('旁白：无说话人段、正文不带「」', () => {
  const p = parseLines('☆000001☆俺はキッチンに立ち、コーヒーを淹れる。').paras[0];
  assert.equal(p.kind, KIND.NARRATION);
  assert.equal(p.id, '000001');
  assert.equal(p.name, '');
  assert.equal(p.speakerRange, null); // 只有 1 段 → 无说话人段
  assert.equal(p.content, '俺はキッチンに立ち、コーヒーを淹れる。');
});

test('对话：带说话人、正文首尾包裹「」', () => {
  const p = parseLines('☆000007☆藍☆「おはよう、早起きだな草薙は」').paras[0];
  assert.equal(p.kind, KIND.DIALOGUE);
  assert.equal(p.id, '000007');
  assert.equal(p.name, '藍');
  assert.equal(p.brackets, true);
  assert.equal(p.content, '「おはよう、早起きだな草薙は」');
});

test('旁白：空说话人段 + 正文不带「」', () => {
  const line = '☆0000☆☆　今日もパス移動をして、そして家へと帰ってくる。';
  const p = parseLines(line).paras[0];
  assert.equal(p.kind, KIND.NARRATION);
  assert.equal(p.name, '');
  // 空说话人段是零宽区间（不是 null）—— 装饰器可据此定位空名字槽
  assert.equal(p.speakerRange.from, p.speakerRange.to, '空说话人段应为零宽区间');
  assert.equal(line.slice(p.speakerRange.from, p.speakerRange.to), '');
  assert.deepEqual(p.idRange, { from: 1, to: 5 });
  assert.equal(line.slice(p.idRange.from, p.idRange.to), '0000');
});

test('对话：空说话人段但正文带「」（心声型，新规则与旧引擎的差异点）', () => {
  const line = '☆0002☆☆「……そうか」';
  const p = parseLines(line).paras[0];
  assert.equal(p.kind, KIND.DIALOGUE, '带「」即对话，与有没有说话人无关');
  assert.equal(p.name, '');
  assert.equal(p.speakerRange.from, p.speakerRange.to, '空说话人段应为零宽区间');
  assert.equal(line.slice(p.contentRange.from, p.contentRange.to), '「……そうか」');
});

test('人名：NAME 条目，正文即人名', () => {
  const p = parseLines('☆NAME|11☆李四').paras[0];
  assert.equal(p.kind, KIND.NAME);
  assert.equal(p.isName, true);
  assert.equal(p.name, '李四');
  assert.equal(p.id, 'NAME|11');
});

test('人名：【】包裹时取括号内名字并记录 nameWrap', () => {
  const p = parseLines('☆NAME|11☆【李四】').paras[0];
  assert.equal(p.kind, KIND.NAME);
  assert.equal(p.name, '李四');
  assert.equal(p.nameWrap, true);
  assert.equal(p.content, '【李四】');
});

test('人名：N 后缀编号也判为人名行', () => {
  const p = parseLines('☆000001N☆里奈').paras[0];
  assert.equal(p.kind, KIND.NAME);
  assert.equal(p.isName, true);
});

test('锁定括号判定只认整段首尾包裹', () => {
  assert.equal(isBracketed('「ありがとう」'), true);
  assert.equal(isBracketed('「ありがとう」と言った'), false, '首尾不完整 → 不是锁定括号');
  assert.equal(isBracketed('彼は「ありがとう」'), false);
  assert.equal(isBracketed('「」'), true);
  assert.equal(isBracketed('「'), false);
});

test('对话/旁白分类用含「」判断，与锁定括号是两个判断', () => {
  assert.equal(hasQuote('「ありがとう」'), true);
  assert.equal(hasQuote('「ありがとう」と言った'), true, '含「」即算对话');
  assert.equal(hasQuote('彼は「ありがとう」'), true);
  assert.equal(hasQuote('「'), true);
  assert.equal(hasQuote('俺はキッチンに立ち、コーヒーを淹れる。'), false);
  assert.equal(hasQuote(''), false);
});

test('回归：以「开头但无收尾的对话行，不能被误判成旁白', () => {
  // 真实样本 test text/新建 文本文档 (2).txt 里的第 000010 行
  const line = '☆000010☆直哉☆「そうか？　喜んでもらえて幸いだ。冷めないうちに食べてくれ。';
  const p = parseLines(line).paras[0];
  assert.equal(p.kind, KIND.DIALOGUE);
  assert.equal(p.name, '直哉');
  assert.equal(p.brackets, false, '首尾不完整 → 不是锁定括号，但仍是对话');
});

/* ---------------- 2. 行角色与行号保真 ---------------- */

const SAMPLE = [
  '#NOTTRANS',                                  // 0 comment
  '☆0000☆☆　今日もパス移動をして、家へ帰る。',   // 1 orig
  '★0000★★　今天也是通过路径移动回到了家。',      // 2 trans
  '',                                            // 3 blank
  '☆0001☆創眞☆「ふぅ……ただいま」',              // 4 orig
  '★0001★创真★「呼……我回来了」',                // 5 trans
  '',                                            // 6 blank
].join('\n');

test('行角色：注释/原文/译文/空行各自归类', () => {
  const { lines } = parseLines(SAMPLE);
  assert.equal(lines[0].role, ROLE.COMMENT);
  assert.equal(lines[1].role, ROLE.ORIG);
  assert.equal(lines[2].role, ROLE.TRANS);
  assert.equal(lines[3].role, ROLE.BLANK);
  assert.equal(lines[4].role, ROLE.ORIG);
  assert.equal(lines[5].role, ROLE.TRANS);
});

test('行号保真：段落记的是原文件行号，不是段内序号', () => {
  const { paras } = parseLines(SAMPLE);
  assert.equal(paras.length, 2);
  assert.deepEqual(paras[0].lineIndices.orig, 1);
  assert.deepEqual(paras[0].lineIndices.trans, 2);
  assert.deepEqual(paras[1].lineIndices.orig, 4);
  assert.deepEqual(paras[1].lineIndices.trans, 5);
});

test('注释行归属于其后的段落', () => {
  const { paras } = parseLines(SAMPLE);
  assert.deepEqual(paras[0].lineIndices.comments, [0], '行号在 lineIndices.comments');
  assert.deepEqual(paras[0].comments, ['#NOTTRANS'], 'comments 是字符串数组（buildExport 直接展开它）');
  assert.deepEqual(paras[1].comments, []);
});

test('注释行内容与 buildExport 兼容：展开后是字符串而非对象', () => {
  // buildExport 里是 lines.push(...p.comments)，放对象会把 [object Object] 写进导出文件
  const { paras } = parseLines('#NOTTRANS\n☆0001☆A☆「あ」\n★0001★甲★「啊」\n');
  assert.equal(typeof paras[0].comments[0], 'string');
  const lines = [];
  lines.push(...paras[0].comments);
  assert.deepEqual(lines, ['#NOTTRANS']);
});

test('paraAtLine：行号 → 段落', () => {
  const parsed = parseLines(SAMPLE);
  assert.equal(paraAtLine(parsed, 1).id, '0000');
  assert.equal(paraAtLine(parsed, 2).id, '0000');
  assert.equal(paraAtLine(parsed, 4).id, '0001');
  assert.equal(paraAtLine(parsed, 3), null, '空行不属于任何段落');
  assert.equal(paraAtLine(parsed, 999), null, '越界返回 null');
});

test('段内第三行及以后标记为 other，不被丢弃', () => {
  const text = ['☆0001☆A☆「あ」', '★0001★甲★「啊」', '☆0002☆B☆「い」'].join('\n');
  const { lines, paras } = parseLines(text);
  assert.equal(lines[2].role, ROLE.OTHER);
  assert.deepEqual(paras[0].lineIndices.extra, [2], '多余行记录在 extra，内容不丢');
});

test('纯注释块不产生段落', () => {
  const { paras, lines } = parseLines('#NOTTRANS\n\n☆0001☆A☆「あ」');
  assert.equal(paras.length, 1);
  assert.equal(lines[0].role, ROLE.COMMENT);
  assert.equal(lines[0].paraIndex, null);
});

/* ---------------- 3. 列区间 ---------------- */

test('列区间：编号段、说话人段、正文段位置精确', () => {
  const line = '☆000007☆藍☆「おはよう」';
  const p = parseLines(line).paras[0];
  assert.deepEqual(p.idRange, { from: 1, to: 7 });
  assert.equal(line.slice(p.idRange.from, p.idRange.to), '000007');
  assert.deepEqual(p.speakerRange, { from: 8, to: 9 });
  assert.equal(line.slice(p.speakerRange.from, p.speakerRange.to), '藍');
  assert.equal(line.slice(p.contentRange.from, p.contentRange.to), '「おはよう」');
});

test('列区间：无说话人段时正文紧跟前缀', () => {
  const line = '☆000001☆俺はキッチンに立ち';
  const p = parseLines(line).paras[0];
  assert.equal(p.prefixEnd, 8);
  assert.deepEqual(p.contentRange, { from: 8, to: line.length });
  assert.equal(line.slice(p.contentRange.from, p.contentRange.to), '俺はキッチンに立ち');
});

test('列区间：译文行坐标独立于原文行', () => {
  const text = '☆0001☆創眞☆「ふぅ」\n★0001★创真★「呼」';
  const p = parseLines(text).paras[0];
  assert.equal(text.split('\n')[1].slice(p.translationRange.from, p.translationRange.to), '「呼」');
  assert.equal(p.translation, '「呼」');
  assert.equal(p.nameTr, '创真');
});

/* ---------------- 4. 已翻译口径与统计 ---------------- */

test('done：无译文行的段落算未翻译', () => {
  const p = parseLines('☆0001☆A☆「あ」').paras[0];
  assert.equal(p.done, false);
  assert.equal(p.translation, '');
});

test('done：人名行有默认名即算已翻译（与 makePara 口径一致）', () => {
  const p = parseLines('☆NAME|11☆李四').paras[0];
  assert.equal(p.nameTr, '李四');
  assert.equal(p.done, true);
});

test('summary：三类段落与未翻译计数', () => {
  const text = [
    '☆NAME|1☆李四',
    '',
    '☆0001☆李四☆「あ」',
    '★0001★李四★「啊」',
    '',
    '☆0002☆☆雨が降る。',
    '',
  ].join('\n');
  const { summary } = parseLines(text);
  assert.equal(summary.total, 3);
  assert.equal(summary.name, 1);
  assert.equal(summary.dialogue, 1);
  assert.equal(summary.narration, 1);
  assert.equal(summary.done, 2, '人名行 + 已译对话');
  assert.equal(summary.untranslated, 1);
});

/* ---------------- 5. 换行与文件结尾 ---------------- */

test('CRLF 文件：换行风格与列区间都不受 \\r 影响', () => {
  const text = '☆0001☆藍☆「あ」\r\n★0001★蓝★「啊」\r\n\r\n';
  const { nl, trailingBlank, paras } = parseLines(text);
  assert.equal(nl, '\r\n');
  assert.equal(trailingBlank, true);
  assert.equal(paras[0].content, '「あ」', '正文不残留 \\r');
  assert.equal(paras[0].kind, KIND.DIALOGUE);
});

test('空文本不抛错', () => {
  const parsed = parseLines('');
  assert.deepEqual(parsed.paras, []);
  assert.equal(parsed.summary.total, 0);
});

/* ---------------- 7. 配置驱动的识别（手动前缀/后缀 + 自定义正则） ----------------
 * src/parsers.js 的配置是模块级可变状态，所以这里必须在 finally 里还原，
 * 否则会污染同进程内的其他用例与真实样本交叉验证。
 */

test('换一套标记字符（○/●）后识别生效', () => {
  const restore = getParseConf();
  try {
    setParseConf({ open: '○', close: '●', regex: '' });
    const line = '○00000|000008|003○ [[照]] 「むにゃむにゃ…………」[np]';
    const p = parseLines(line).paras[0];
    assert.equal(p.id, '00000|000008|003');
    assert.equal(p.kind, KIND.DIALOGUE, '含「」即对话');
    assert.equal(p.content, ' [[照]] 「むにゃむにゃ…………」[np]');
  } finally {
    setParseConf(restore);
  }
});

test('自定义正则的命名捕获组能取出正文包裹的说话人（[[名字]] 格式）', () => {
  const restore = getParseConf();
  try {
    setParseConf({
      open: '○', close: '●',
      regex: '^○(?<id>[^○]*)○\\s*(?:\\[\\[(?<name>[^\\]]*)\\]\\]\\s*)?(?<content>[\\s\\S]*)$',
    });
    const line = '○00000|000008|003○ [[照]] 「むにゃむにゃ…………」[np]';
    const p = parseLines(line).paras[0];
    assert.equal(p.id, '00000|000008|003');
    assert.equal(p.name, '照', '说话人来自正文 [[ ]] 而非前缀段');
    assert.equal(p.kind, KIND.DIALOGUE, '含「」即对话');
    assert.equal(p.content, '「むにゃむにゃ…………」[np]');
    assert.equal(p.rangeSource, 'regex-named');
    // 命名捕获组用 d 标志读出的精确区间 —— 标记扫描推不出这些位置
    assert.equal(line.slice(p.idRange.from, p.idRange.to), '00000|000008|003');
    assert.equal(line.slice(p.speakerRange.from, p.speakerRange.to), '照');
    assert.equal(line.slice(p.contentRange.from, p.contentRange.to), '「むにゃむにゃ…………」[np]');
    assert.deepEqual(p.segs, ['00000|000008|003', '照'], 'segs 与 segsOf 口径一致');
  } finally {
    setParseConf(restore);
  }
});

test('自定义正则的旧约定（2 捕获组）段区间按前缀起点偏移', () => {
  const restore = getParseConf();
  try {
    // 旧约定：group1 = 前缀、group2 = 正文。
    // 注意三段前缀（☆编号☆说话人☆）需要三段标记的模式，否则说话人会落进正文组。
    setParseConf({ open: '○', close: '●', regex: '^(○[^○]*○[^○]*○)([\\s\\S]*)$' });
    const line = '○0007○藍○「おはよう」';
    const p = parseLines(line).paras[0];
    assert.equal(p.rangeSource, 'regex-legacy');
    assert.equal(p.id, '0007');
    assert.equal(p.name, '藍');
    assert.equal(line.slice(p.idRange.from, p.idRange.to), '0007');
    assert.equal(line.slice(p.speakerRange.from, p.speakerRange.to), '藍');
    assert.equal(line.slice(p.contentRange.from, p.contentRange.to), '「おはよう」');
  } finally {
    setParseConf(restore);
  }
});

test('配置还原后，默认 ☆/★ 识别仍然正确', () => {
  assert.equal(getParseConf().open, '☆');
  assert.equal(getParseConf().close, '★');
  assert.equal(parseLines('☆0001☆藍☆「あ」').paras[0].kind, KIND.DIALOGUE);
});

/* ---------------- 8. 与桌面版引擎的交叉验证 ---------------- */

test('交叉验证：真实样本的段落数与 done 口径与 parseFile 一致', (t) => {
  if (!fs.existsSync(SAMPLE_DIR)) {
    t.skip(`样本目录不存在：${SAMPLE_DIR}`);
    return;
  }
  const files = fs.readdirSync(SAMPLE_DIR)
    .filter(f => f.endsWith('.txt'))
    .filter(f => !isMirrorFormatText(fs.readFileSync(path.join(SAMPLE_DIR, f), 'utf8')));

  assert.ok(files.length > 0, '应至少有一个非镜像格式样本');

  for (const f of files) {
    const text = fs.readFileSync(path.join(SAMPLE_DIR, f), 'utf8');
    const mine = parseLines(text);
    const theirs = parseFile(text);

    assert.equal(
      mine.paras.length, theirs.paras.length,
      `${f}: 段落数不一致（parseLines=${mine.paras.length}, parseFile=${theirs.paras.length}）`,
    );
    assert.equal(
      mine.nl, theirs.nl,
      `${f}: 换行风格不一致`,
    );
    assert.equal(
      mine.trailingBlank, theirs.trailingBlank,
      `${f}: trailingBlank 不一致`,
    );

    for (let i = 0; i < theirs.paras.length; i++) {
      const a = mine.paras[i], b = theirs.paras[i];
      assert.equal(a.orig, b.orig, `${f} 段${i}: 原文行不一致`);
      assert.equal(a.id, b.id, `${f} 段${i}: 编号不一致`);
      assert.equal(a.name, b.name, `${f} 段${i}: 说话人/人名不一致`);
      assert.equal(a.kind === KIND.NAME, b.isName, `${f} 段${i}: 人名行判定不一致`);
      assert.equal(a.translation, b.translation, `${f} 段${i}: 译文不一致`);
      assert.equal(a.nameTr, b.nameTr, `${f} 段${i}: 译名不一致`);
      assert.equal(a.brackets, b.brackets, `${f} 段${i}: 锁定括号判定不一致`);
      assert.equal(a.done, b.done, `${f} 段${i}: done 口径不一致`);
    }
  }
});

test('交叉验证：样本里三类段落都识别到了', (t) => {
  if (!fs.existsSync(SAMPLE_DIR)) {
    t.skip(`样本目录不存在：${SAMPLE_DIR}`);
    return;
  }
  const files = fs.readdirSync(SAMPLE_DIR).filter(f => f.endsWith('.txt'));
  let name = 0, dialogue = 0, narration = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(SAMPLE_DIR, f), 'utf8');
    if (isMirrorFormatText(text)) continue;
    const { summary } = parseLines(text);
    name += summary.name;
    dialogue += summary.dialogue;
    narration += summary.narration;
  }
  assert.ok(dialogue > 0, `应识别到对话，实际 ${dialogue}`);
  assert.ok(narration > 0, `应识别到旁白，实际 ${narration}`);
  assert.ok(name > 0, `应识别到人名条目，实际 ${name}`);
});

/* ---------------- 9. 镜像格式（dc4ph 文本导出） ---------------- */

const MIRROR_DIR = path.join(SAMPLE_DIR, 'dc4ph');

const MIRROR_TEXT = [
  '#0x16E1',
  '★◎  001  ◎★//　放課後、俺と有里咲は買い物を済ませてから帰ってきた。',
  '★◎  001  ◎★　放課後、俺と有里咲は買い物を済ませてから帰ってきた。',
  '',
  '#0x17ED',
  '★◎  005  ◎★//「あいよ、お待たせ。」',
  '★◎  005  ◎★「好咧，让你久等了。」',
  '',
].join('\n');

test('镜像格式：// 行是原文行、普通行是译文行、#0x 是注释行', () => {
  const parsed = parseLines(MIRROR_TEXT);
  assert.equal(parsed.isMirror, true, '应判为镜像格式');
  assert.equal(parsed.paras.length, 2);
  const [a, b] = parsed.paras;

  assert.equal(parsed.lines[0].role, ROLE.COMMENT);
  assert.equal(parsed.lines[1].role, ROLE.ORIG);
  assert.equal(parsed.lines[2].role, ROLE.TRANS);
  assert.equal(parsed.lines[3].role, ROLE.BLANK);
  assert.equal(parsed.lines.filter(l => l.role === ROLE.OTHER).length, 0, '镜像文件没有"段内多余行"');

  assert.equal(a.kind, KIND.NARRATION);
  assert.equal(b.kind, KIND.DIALOGUE);
  assert.equal(a.id, '001');
  assert.equal(a.content, '　放課後、俺と有里咲は買い物を済ませてから帰ってきた。');
  assert.equal(a.translation, a.content, '未翻译时译文行预填原文');
  assert.equal(a.done, false, '预填原文不算已翻译（与桌面版同口径）');
  assert.equal(b.done, true, '译文与原文不同 → 已翻译');

  assert.deepEqual(a.comments, ['#0x16E1'], '地址头挂在段落的注释里，导出时写在原文行之前');
  assert.deepEqual(a.lineIndices, { orig: 1, trans: 2, comments: [0], extra: [] });
  assert.equal(b.lineIndices.orig, 5);
  assert.equal(b.lineIndices.trans, 6);
});

test('镜像格式：列区间指到正确片段（前缀含 // 结构标记）', () => {
  const parsed = parseLines(MIRROR_TEXT);
  const a = parsed.paras[0];
  const origLine = parsed.lines[a.lineIndices.orig].text;
  const transLine = parsed.lines[a.lineIndices.trans].text;

  assert.equal(a.prefix, '★◎  001  ◎★//', '前缀包含 // 标记 —— 它是结构，不是正文');
  assert.equal(a.prefixEnd, a.prefix.length);
  assert.equal(origLine.slice(a.contentRange.from, a.contentRange.to), a.content);
  assert.equal(origLine.slice(a.idRange.from, a.idRange.to), '001');
  assert.equal(transLine.slice(a.translationRange.from, a.translationRange.to), a.translation);
  assert.equal(a.translationRange.from, '★◎  001  ◎★'.length, '译文行前缀不含 //');

  assert.equal(a.speakerRange, null, '镜像格式没有说话人段');
  assert.equal(a.rangeSource, 'mirror');
  assert.deepEqual(a.mirror, {
    plainPrefix: '★◎  001  ◎★',
    plainBody: a.translation,
    indent: true,
  });
  assert.equal(parsed.paras[1].mirror.indent, false, '正文不以全角空格开头时不算缩进');
});

test('镜像格式：斜线行能推出它对应的普通行（补译文行用）', () => {
  assert.equal(mirrorPlainLineOf('★◎  002  ◎★//おやすみ'), '★◎  002  ◎★おやすみ');
  assert.equal(mirrorPlainLineOf('★◎  002  ◎★//　　「あ」'), '★◎  002  ◎★　　「あ」');
  // 不是斜线行 → 拒绝（调用方据此提示，而不是写出格式错误的行）
  assert.equal(mirrorPlainLineOf('★◎  002  ◎★おやすみ'), null);
  assert.equal(mirrorPlainLineOf('☆0001☆藍☆「あ」'), null);
  assert.equal(mirrorPlainLineOf(''), null);
});

test('镜像格式：正文本身以 // 开头时不猜，宁可拒绝补行', () => {
  assert.equal(mirrorPlainLineOf('★◎  003  ◎★////正文'), null);
});

test('镜像格式：最后一条缺普通行（导出中断）仍识别，整行保留不丢内容', () => {
  const text = '#0x1000\n★◎  001  ◎★//おはよう\n★◎  001  ◎★おはよう\n\n#0x1010\n★◎  002  ◎★//おやすみ\n';
  const parsed = parseLines(text);
  assert.equal(parsed.isMirror, true);
  assert.equal(parsed.paras.length, 2);
  assert.equal(parsed.paras[0].lineIndices.trans, 2);

  const tail = parsed.paras[1];
  assert.equal(tail.lineIndices.trans, null, '缺普通行 → 没有译文行');
  assert.equal(tail.mirror, null, '与桌面版一致：整行当正文，不按镜像段处理');
  assert.equal(tail.content, '★◎  002  ◎★//おやすみ');
  assert.equal(tail.done, false);
  assert.equal(mirrorPlainLineOf(tail.orig), '★◎  002  ◎★おやすみ', '补行时去掉 // 标记');
});

test('镜像格式：不误判普通脚本', () => {
  assert.equal(parseLines('☆0001☆藍☆「おはよう」\n★0001★蓝★「早上好」\n').isMirror, false);
  assert.equal(isMirrorDoc('☆0001☆藍☆「おはよう」'), false);
  assert.equal(isMirrorDoc(''), false);
});

test('交叉验证：镜像样本（dc4ph）与 parseFile 逐段逐字段一致', (t) => {
  if (!fs.existsSync(MIRROR_DIR)) { t.skip(`镜像样本目录不存在：${MIRROR_DIR}`); return; }
  const files = fs.readdirSync(MIRROR_DIR).filter(f => f.endsWith('.txt'));
  assert.ok(files.length > 0, '镜像样本目录里应有文件');

  let total = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(MIRROR_DIR, f), 'utf8');
    assert.equal(isMirrorFormatText(text), true, `${f}: 应被桌面版判为镜像格式`);

    const mine = parseLines(text);
    const theirs = parseFile(text);
    assert.equal(mine.isMirror, true, `${f}: 应判为镜像格式`);
    assert.equal(mine.paras.length, theirs.paras.length, `${f}: 段落数不一致`);
    assert.equal(mine.nl, theirs.nl, `${f}: 换行风格不一致`);
    assert.equal(mine.trailingBlank, theirs.trailingBlank, `${f}: trailingBlank 不一致`);
    assert.equal(mine.paras.filter(p => p.mirror).length, theirs.paras.length, `${f}: 每段都应是镜像段`);
    assert.equal(mine.lines.filter(l => l.role === ROLE.OTHER).length, 0, `${f}: 不该有段内多余行`);

    for (let i = 0; i < theirs.paras.length; i++) {
      const a = mine.paras[i], b = theirs.paras[i];
      assert.equal(a.orig, b.orig, `${f} 段${i}: 原文行不一致`);
      assert.equal(a.id, b.id, `${f} 段${i}: 编号不一致`);
      assert.equal(a.content, b.content, `${f} 段${i}: 正文不一致`);
      assert.equal(a.translation, b.translation, `${f} 段${i}: 译文不一致`);
      assert.equal(a.brackets, b.brackets, `${f} 段${i}: 锁定括号判定不一致`);
      assert.equal(a.done, b.done, `${f} 段${i}: done 口径不一致`);
      assert.equal(a.isName, b.isName, `${f} 段${i}: 人名判定不一致`);
      assert.equal(a.mirror.plainPrefix, b.mirror.plainPrefix, `${f} 段${i}: 译文行前缀不一致`);
      assert.equal(a.mirror.plainBody, b.mirror.plainBody, `${f} 段${i}: 译文行原文不一致`);
      assert.equal(a.mirror.indent, b.mirror.indent, `${f} 段${i}: 缩进标记不一致`);
      // 行号保真是本扩展独有的：// 行下一条非空行必定是它的普通行
      assert.equal(a.lineIndices.trans, a.lineIndices.orig + 1, `${f} 段${i}: 译文行号应紧邻原文行`);
    }
    total += mine.paras.length;
  }
  t.diagnostic(`镜像样本 ${files.length} 个文件、${total} 段与 parseFile 完全一致`);
});
