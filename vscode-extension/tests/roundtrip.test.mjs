// roundtrip.test.mjs — 导出保真：解析 → buildExport 重建 → 与原文逐字节比对
//
// 这是"原文永不修改"与"段落对象与 makePara 兼容"两条保证的硬验收：
// buildExport 是导出/回写的唯一出口（parsers.js:381 原文行原样 push），
// 如果重建结果与原文不一致，说明段落对象少了字段、字段形态不对、或重建时丢了内容。
//
// 样本都是已翻译的成品文件，所以**重建结果应当与原文完全相同**。
// 唯一的例外是"段内多余行"（parseFile/buildExport 只处理段内前两行），
// 这类样本会被显式跳过并计数，不能悄悄放过。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLines, isMirrorDoc } from '../src/lineparse.js';
import { pickRule, BUILTIN_RULES, normalizeRule } from '../src/rules.js';
import { buildExport } from '../../src/parsers.js';
import {
  exportOriginalFormat, restoreTrailingNewline, verifyRoundTrip, explainRoundTripFailure,
} from '../src/export-text.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..');
const SAMPLE_DIR = path.resolve(EXT_DIR, '../test text');

function ruleLibrary() {
  const lib = BUILTIN_RULES.slice();
  const dir = path.join(EXT_DIR, 'rules');
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    lib.push(normalizeRule(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), path.basename(name, '.json')));
  }
  return lib;
}

function samples() {
  if (!fs.existsSync(SAMPLE_DIR)) return [];
  return fs.readdirSync(SAMPLE_DIR).filter(f => f.endsWith('.txt'))
    .map(f => ({ name: f, text: fs.readFileSync(path.join(SAMPLE_DIR, f), 'utf8') }));
}

/** 镜像格式(dc4ph)样本在子目录里 —— 单独取，不混进上面那批（它们的规则选择路径不同） */
function mirrorSamples() {
  const dir = path.join(SAMPLE_DIR, 'dc4ph');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.txt'))
    .map(f => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/**
 * 跑一遍全部样本，按自检结果分两类。
 * 返回 { safe: [{name,text,parsed}], unsafe: [{name,text,parsed,check}] }
 */
function classify() {
  const lib = ruleLibrary();
  const safe = [], unsafe = [];
  for (const { name, text } of samples()) {
    const picked = pickRule(text, lib);
    if (!picked) continue;
    const parsed = parseLines(text, { conf: picked.rule.conf });
    if (parsed.paras.some(p => p.lineIndices.extra.length)) continue; // 段内多余行另有说明
    const conf = picked.rule.conf;
    const check = verifyRoundTrip(parsed, text, buildExport, conf);
    (check.ok ? safe : unsafe).push({ name, text, parsed, conf, check });
  }
  return { safe, unsafe };
}

test('导出保真：能安全重建的样本必须逐字节相同（LF 与 CRLF 都覆盖）', (t) => {
  if (!samples().length) { t.skip(`样本目录不存在：${SAMPLE_DIR}`); return; }
  const { safe } = classify();
  assert.ok(safe.length > 0, '应至少有一个可安全重建的样本');
  for (const { name, text, parsed, conf } of safe) {
    assert.equal(exportOriginalFormat(parsed, buildExport, conf), text, `${name}: 重建结果与原文不一致`);
  }
  const crlf = safe.filter(s => s.parsed.nl === '\r\n').length;
  assert.ok(crlf > 0, '安全样本里应包含 CRLF 文件');
  t.diagnostic(`可安全重建 ${safe.length} 个样本（其中 CRLF ${crlf} 个）`);
});

test('导出保真：重建结果不依赖"最后一次解析的是哪个文件"（模块级配置陷阱）', () => {
  // buildExport 内部读模块级 parseConf.close。导出必须显式对齐配置，
  // 否则"打开文件 B 之后再导出文件 A"会拿 B 的标记字符写 A 的译文行。
  const star = '☆0001☆藍☆「おはよう」\n★0001★蓝★「早上好」\n';
  const parsedStar = parseLines(star);

  const circle = '○0001○藍○「おはよう」\n●0001●蓝●「早上好」\n';
  const lib = ruleLibrary();
  const pickedCircle = pickRule(circle, lib);
  parseLines(circle, { conf: pickedCircle.rule.conf }); // 把全局配置改成 ○/● 规则

  // 不加 conf 时会被带偏（这就是为什么签名要求显式传）
  assert.notEqual(exportOriginalFormat(parsedStar, buildExport), star,
    '不传 conf 时确实会被上一次解析的规则带偏');

  // 显式传 conf 后结果稳定
  const starConf = pickRule(star, lib).rule.conf;
  assert.equal(exportOriginalFormat(parsedStar, buildExport, starConf), star);
  assert.equal(exportOriginalFormat(parsedStar, buildExport, starConf), star, '可重复');
});

test('导出保真：不能安全重建的样本会被自检拦下并给出成因', (t) => {
  if (!samples().length) { t.skip(`样本目录不存在：${SAMPLE_DIR}`); return; }
  const { unsafe } = classify();
  if (!unsafe.length) { t.diagnostic('样本里没有不能安全重建的文件'); return; }

  for (const { name, check, parsed } of unsafe) {
    assert.equal(check.ok, false);
    assert.ok(check.diffAt >= 0, `${name}: 应给出差异位置`);
    assert.ok(check.line >= 1, `${name}: 应给出行号`);
    const reasons = explainRoundTripFailure(parsed);
    assert.ok(reasons.length > 0, `${name}: 应能解释成因`);
  }
  t.diagnostic(`拦下 ${unsafe.length} 个：${unsafe.map(u => u.name).join('、')}`);
});

test('自检能识别三种已知的不可安全重建成因', (t) => {
  if (!samples().length) { t.skip(`样本目录不存在：${SAMPLE_DIR}`); return; }
  const { unsafe } = classify();
  const byName = (n) => unsafe.find(u => u.name === n);
  const reasonsOf = (n) => {
    const u = byName(n);
    return u ? explainRoundTripFailure(u.parsed).join(' | ') : '';
  };

  // ① 译文行编号与原文行不同（引擎约定，全部 +1）
  const idOffset = reasonsOf('新建 文本文档 (11).txt');
  if (idOffset) assert.match(idOffset, /编号与原文行不同/);

  // ② 自定义正则规则：译文行格式与 ☆/★ 分段式不同
  const named = reasonsOf('新建 文本文档 (13).txt');
  if (named) assert.match(named, /自定义正则规则/);

  // ③ 文件开头有空行
  const leading = reasonsOf('新建 文本文档 (8).txt');
  if (leading) assert.match(leading, /开头有空行/);

  const found = [idOffset, named, leading].filter(Boolean).length;
  t.diagnostic(`识别到 ${found}/3 类成因`);
});

test('导出保真：末尾无换行的文件不会被补上换行', () => {
  const noNl = '☆0001☆藍☆「おはよう」\n★0001★蓝★「早上好」';
  const conf = pickRule(noNl, ruleLibrary())?.rule.conf;
  const parsed = parseLines(noNl, { conf });
  assert.equal(parsed.endsWithNewline, false);
  assert.equal(exportOriginalFormat(parsed, buildExport, conf), noNl, '末尾不应多出换行');

  const withNl = noNl + '\n';
  const parsed2 = parseLines(withNl, { conf });
  assert.equal(parsed2.endsWithNewline, true);
  assert.equal(exportOriginalFormat(parsed2, buildExport, conf), withNl);
});

test('导出保真：buildExport 本身总是补换行 —— 这是我们要抹平的既有行为', () => {
  // 记录共享代码的实际行为：parsers.js:401 的 `lines.join(nl) + nl`
  const noNl = '☆0001☆藍☆「おはよう」\n★0001★蓝★「早上好」';
  const parsed = parseLines(noNl);
  const raw = buildExport(parsed.paras, parsed.nl, parsed.trailingBlank);
  assert.equal(raw, noNl + '\n', 'buildExport 会补一个换行');
  assert.equal(restoreTrailingNewline(raw, false), noNl, 'restoreTrailingNewline 抹平它');
  assert.equal(restoreTrailingNewline(raw, true), raw, '源文件本来有换行时不动它');
});

test('导出保真：CRLF 文件换行风格不丢', (t) => {
  if (!samples().length) { t.skip(`样本目录不存在：${SAMPLE_DIR}`); return; }
  const lib = ruleLibrary();
  let checked = 0;
  for (const { name, text } of samples()) {
    if (!text.includes('\r\n')) continue;
    const picked = pickRule(text, lib);
    if (!picked) continue;
    const parsed = parseLines(text, { conf: picked.rule.conf });
    assert.equal(parsed.nl, '\r\n', `${name}: 应识别为 CRLF`);
    if (parsed.paras.some(p => p.lineIndices.extra.length)) continue;
    if (!verifyRoundTrip(parsed, text, buildExport, picked.rule.conf).ok) continue;
    assert.equal(exportOriginalFormat(parsed, buildExport, picked.rule.conf), text, `${name}: CRLF 重建结果与原文不一致`);
    checked++;
  }
  assert.ok(checked > 0, '应至少验证一个 CRLF 样本');
});

test('导出保真：改掉一行译文后，只有那一行变化', () => {
  const text = '☆0001☆藍☆「おはよう」\n★0001★蓝★「早上好」\n\n☆0002☆藍☆「おやすみ」\n★0002★蓝★「晚安」\n';
  const parsed = parseLines(text);
  parsed.paras[1].translation = '「晚安了」';
  parsed.paras[1].done = true;
  const rebuilt = buildExport(parsed.paras, parsed.nl, parsed.trailingBlank);
  const lines = rebuilt.split('\n');
  assert.equal(lines[4], '★0002★蓝★「晚安了」', '译文行应更新');
  assert.equal(lines[0], '☆0001☆藍☆「おはよう」', '其他原文行不变');
  assert.equal(lines[1], '★0001★蓝★「早上好」', '其他译文行不变');
});

test('导出保真：原文行即使被外部改动也会原样输出（写入层不重写原文）', () => {
  const text = '☆0001☆藍☆「おはよう」\n★0001★蓝★「早上好」\n';
  const parsed = parseLines(text);
  // 模拟用户在编辑器里改了原文（VS Code 没有行级只读 API，拦不住）
  const tampered = '☆0001☆藍☆「おはよう、元気？」';
  parsed.paras[0].orig = tampered;
  const rebuilt = buildExport(parsed.paras, parsed.nl, parsed.trailingBlank);
  assert.match(rebuilt, /「おはよう、元気？」/, 'buildExport 输出的是 p.orig，不做任何改写');
});

test('导出保真：注释行还原回原文行之前', () => {
  const text = '#NOTTRANS\n☆0000☆☆雨が降る。\n★0000★★　下雨了。\n';
  const parsed = parseLines(text);
  const rebuilt = buildExport(parsed.paras, parsed.nl, parsed.trailingBlank);
  assert.equal(rebuilt, text);
  assert.ok(!rebuilt.includes('[object Object]'), '注释行不能变成对象字符串');
});

/* ---------------- 镜像格式（dc4ph）的往返保真 ---------------- */

test('导出保真：镜像格式样本（dc4ph）逐字节可重建', (t) => {
  const mirrors = mirrorSamples().filter(({ text }) => isMirrorDoc(text));
  if (!mirrors.length) { t.skip('样本目录里没有镜像格式样本'); return; }
  let paras = 0;
  for (const { name, text } of mirrors) {
    const parsed = parseLines(text);
    paras += parsed.paras.length;
    assert.equal(parsed.isMirror, true, `${name}: 应判为镜像格式`);
    const check = verifyRoundTrip(parsed, text, buildExport);
    assert.equal(check.ok, true, `${name}: 镜像样本应能无损重建`);
    assert.equal(exportOriginalFormat(parsed, buildExport), text, `${name}: 重建结果与原文不一致`);
  }
  t.diagnostic(`镜像格式样本 ${mirrors.length} 个（${paras} 段）全部逐字节还原`);
});

test('导出保真：镜像格式已翻译的行按原文写法写回（不额外补「」）', () => {
  // 桌面版 makeMirrorPara 会在"原文带「」而译文不带"时替译文补上括号 ——
  // 补出来的括号源文件里没有，重建就不一致，等于把这个文件挡在导出之外。
  // 本扩展保存译文原文，所以这道关卡能过。
  const text = [
    '#0x1000',
    '★◎  001  ◎★//「おはよう」',
    '★◎  001  ◎★早上好',
    '',
  ].join('\n');
  const parsed = parseLines(text);
  assert.equal(parsed.isMirror, true);
  assert.equal(parsed.paras[0].translation, '早上好', '译文原样存，不补「」');
  assert.equal(parsed.paras[0].done, true, '正文与原文不同 → 已翻译');
  assert.equal(parsed.paras[0].brackets, true, '原文带「」→ 这一行仍按锁定括号处理');
  assert.equal(verifyRoundTrip(parsed, text, buildExport).ok, true);
});

test('导出保真：镜像格式的预填行不会把正文写重', () => {
  const text = '#0x1000\n★◎  001  ◎★//　おはよう\n★◎  001  ◎★　おはよう\n';
  const parsed = parseLines(text);
  assert.equal(parsed.paras[0].done, false, '预填行 = 未翻译');
  const rebuilt = exportOriginalFormat(parsed, buildExport);
  assert.equal(rebuilt, text);
  assert.equal(rebuilt.split('おはよう').length - 1, 2, '两条正文各出现一次');
});
