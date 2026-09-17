// mirror-dc4ph.test.mjs — dc4ph 文本导出(镜像装饰格式)适配测试
// master 确认的格式语义:
//   - 每条消息 = #0x 地址头 + 两行: ★◎(前缀) NNN ◎★(后缀);带 // 的是原文行,没有 // 的是译文行
//   - 译文行未翻译时预填原文(与原文行相同);已翻译时内容不同
//   - 带「」的是对话,没有的是旁白
// 编辑器呈现: 未翻译记录一行 ☆;译文写回译文行(普通行),原文行(//)始终保留原文。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalize,
  detect,
  restore,
} from '../src/recognize.js';
import {
  canonicalizeDocument,
  canonicalizeProfile,
  enrichDetectionProfile,
  parseDocument,
  renderDocument,
  restoreCanonicalDocument,
  restoreProfile,
  serializeDocument,
} from '../src/universal-parser.js';
import { buildExport, computeDone, mergeSavedState, parseFile, setParseConf } from '../src/parsers.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sampleDir = resolve(root, 'test text/dc4ph');
const files = (existsSync(sampleDir) ? readdirSync(sampleDir) : [])
  .filter(name => name.endsWith('.txt') && !name.startsWith('_'))
  .sort();

const testWithSamples = (name, fn) => test(name, { skip: files.length < 5 ? '需要本地 dc4ph 游戏样本（不随源码分发）' : false }, fn);

function sample(name){
  return readFileSync(resolve(sampleDir, name), 'utf8');
}

// 与真实样本同构的最小文件(含 \n 字面换行令牌与末尾空行)
const CRAFTED = [
  '#0xAD5',
  '★◎  001  ◎★//一登',
  '★◎  001  ◎★一登',
  '',
  '#0xADB',
  '★◎  002  ◎★//「第一句\\n　第二句」',
  '★◎  002  ◎★「第一句\\n　第二句」',
  '',
].join('\n');

// 已翻译状态: 译文行内容与原文行不同
const TRANSLATED = [
  '#0xAD5',
  '★◎  001  ◎★//一登',
  '★◎  001  ◎★登场',
  '',
].join('\n');

testWithSamples('镜像格式：5 份 dc4ph 样本每条消息解析为一条记录且物理无损', () => {
  assert.ok(files.length >= 5, '存在 5 份 dc4ph 样本');
  for (const name of files){
    const text = sample(name);
    const document = parseDocument(text, { file: name });
    const headerCount = (text.match(/^#0x[0-9A-Fa-f]+$/gm) || []).length;
    assert.equal(document.records.length, headerCount, name);
    assert.equal(document.issues.length, 0, name);
    assert.equal(document.format.framing.shape, 'mirror-dc4ph', name);
    assert.equal(document.format.pairing.strategy, 'mirror-pairs', name);
    assert.equal(serializeDocument(document), text, name);
    for (const record of document.records){
      assert.match(record.id, /^\d{3}$/, name);
      assert.equal(record.translation, null, name); // 样本均未翻译: 译文行预填原文
      assert.ok(record.translationSlot, name);
      assert.equal(record.translationSlot.line, record.source.line + 1, name);
      assert.equal(record.translationSlot.body, record.source.text, name);
      assert.ok(Array.isArray(record.controls) && record.controls.length === 1, name);
      assert.match(record.controls[0], /^#0x[0-9A-Fa-f]+$/, name);
      assert.ok(['dialogue', 'narration'].includes(record.kind), name);
      assert.equal(record.speaker.mode, 'none', name);
    }
    assert.equal(document.stats.lowConfidence, 0, name);
  }
});

testWithSamples('镜像格式：分类遵循「带「」=对话,否则=旁白」,不推断说话人', () => {
  const records = parseDocument(sample('dc4_asa20190429c1.txt')).records;
  assert.equal(records[0].source.text, '一登');
  assert.equal(records[0].kind, 'narration');
  assert.equal(records[1].kind, 'dialogue');
  assert.ok(records[1].source.text.startsWith('「'));
  const kinds = document => document.stats.kinds;
  const doc = parseDocument(sample('dc4_asa20190429c1.txt'));
  assert.deepEqual(Object.keys(kinds(doc)).sort(), ['dialogue', 'narration']);
});

testWithSamples('镜像格式：规范化输出未翻译记录只有一行 ☆,无 // 无装饰残留', () => {
  const document = parseDocument(sample('dc4_asa20190429c1.txt'));
  const canonical = canonicalizeDocument(document);
  assert.equal(canonical.ok, true);
  const lines = canonical.text.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['#0xAD5', '☆001☆一登', '']);
  assert.equal(lines.filter(line => line.startsWith('☆')).length, 150);
  assert.equal(lines.filter(line => line.startsWith('★')).length, 0);
  assert.ok(!canonical.text.includes('★◎'));
  assert.ok(!canonical.text.includes('//一登'));
  assert.ok(canonical.text.includes('☆002☆「魔法使いは恋をしちゃいけない'));
});

testWithSamples('镜像格式：未编辑还原对 5 份样本均字节级一致', () => {
  for (const name of files){
    const text = sample(name);
    const document = parseDocument(text, { file: name });
    const canonical = canonicalizeDocument(document);
    assert.equal(canonical.ok, true, name);
    const restored = restoreCanonicalDocument(document, canonical.text);
    assert.equal(restored.ok, true, name);
    assert.equal(restored.text, text, name);
  }
});

test('镜像格式：译文写回译文行(普通行),原文行(//)保留原文', () => {
  const document = parseDocument(CRAFTED);
  const canonical = canonicalizeDocument(document);
  const edited = canonical.text
    .replace('☆002☆「第一句\\n　第二句」', '☆002☆「第一句\\n　第二句」\n★002★「訳文一段\\n　訳文二段」');
  const restored = restoreCanonicalDocument(document, edited);
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.equal(restored.text, [
    '#0xAD5',
    '★◎  001  ◎★//一登',
    '★◎  001  ◎★一登',
    '',
    '#0xADB',
    '★◎  002  ◎★//「第一句\\n　第二句」',
    '★◎  002  ◎★「訳文一段\\n　訳文二段」',
    '',
  ].join('\n'));
});

test('镜像格式：受保护 token 缺失与译文编号篡改均拒绝', () => {
  const document = parseDocument(CRAFTED);
  const canonical = canonicalizeDocument(document);
  // 译文少了 \n 令牌 → 拒绝
  const dropped = canonical.text
    .replace('☆002☆「第一句\\n　第二句」', '☆002☆「第一句\\n　第二句」\n★002★「訳文没有换行」');
  const bad = restoreCanonicalDocument(document, dropped);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(error => error.code === 'protected-token-mismatch'));
  // 译文编号与原文不一致 → 拒绝
  const wrongId = canonical.text
    .replace('☆002☆「第一句\\n　第二句」', '☆002☆「第一句\\n　第二句」\n★999★「訳文」');
  const badId = restoreCanonicalDocument(document, wrongId);
  assert.equal(badId.ok, false);
  assert.ok(badId.errors.some(error => error.code === 'translation-id-modified'));
  // 直接对译文槽写译文 → 只更新普通行
  const direct = renderDocument(document, {
    '001#1': { translationText: '一登译' },
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.text, [
    '#0xAD5',
    '★◎  001  ◎★//一登',
    '★◎  001  ◎★一登译',
    '',
    '#0xADB',
    '★◎  002  ◎★//「第一句\\n　第二句」',
    '★◎  002  ◎★「第一句\\n　第二句」',
    '',
  ].join('\n'));
});

test('镜像格式：已翻译文件(译文行≠原文行)走标准成对流程', () => {
  // 译文行内容与原文不同 → 已有译文,标准成对流程
  const document = parseDocument(TRANSLATED);
  assert.equal(document.records.length, 1);
  assert.equal(document.records[0].translation.text, '登场');
  assert.ok(!document.records[0].translationSlot, '译文行内容不同即为已有译文');
  assert.equal(document.stats.paired, 1);
  const canonical = canonicalizeDocument(document);
  assert.equal(canonical.ok, true);
  assert.ok(canonical.text.includes('☆001☆一登'));
  assert.ok(canonical.text.includes('★001★登场'));
  // 已有译文被删除 → 拒绝(与既有格式一致的防护)
  const stripped = canonical.text.replace('★001★登场\n', '');
  const bad = restoreCanonicalDocument(document, stripped);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(error => error.code === 'translation-removed'));
  // 修改已有译文 → 只更新译文行,原文行保留
  const edited = canonical.text.replace('★001★登场', '★001★新译名');
  const restored = restoreCanonicalDocument(document, edited);
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.equal(restored.text, [
    '#0xAD5',
    '★◎  001  ◎★//一登',
    '★◎  001  ◎★新译名',
    '',
  ].join('\n'));

  // 译文行与原文相同 → 未翻译状态,规范化只有 ☆ 行
  const same = TRANSLATED.replace('★◎  001  ◎★登场', '★◎  001  ◎★一登');
  const docSame = parseDocument(same);
  assert.equal(docSame.records[0].translation, null);
  assert.ok(docSame.records[0].translationSlot);
  const canonicalSame = canonicalizeDocument(docSame);
  assert.ok(canonicalSame.text.includes('☆001☆一登'));
  assert.ok(!canonicalSame.text.includes('★001★'));
});

test('镜像格式：结构不完整(译文行缺失)时拒绝规范化,不静默丢内容', () => {
  const incomplete = CRAFTED.replace('\n★◎  002  ◎★「第一句\\n　第二句」', '');
  const doc2 = parseDocument(incomplete);
  assert.ok(doc2.issues.some(issue => issue.type === 'mirror-incomplete'));
  const can2 = canonicalizeDocument(doc2);
  assert.equal(can2.ok, false);
  assert.ok(can2.errors.some(error => error.code === 'unsupported-line'));
  assert.equal(serializeDocument(doc2), incomplete);
});

testWithSamples('镜像格式：legacy detect/canonicalize/restore 闭环可字节级还原', () => {
  const text = sample('dc4_asa20190429c1.txt');
  const profile = detect(text, 'c1');
  assert.equal(profile.structure.shape, 'mirror-dc4ph');
  assert.equal(profile.marks.open, '★');
  assert.equal(profile.marks.confidence, 1);
  assert.equal(profile.structure.idShape, 'numeric');
  assert.equal(profile.rows.filter(row => row.kind === 'control').length, 150);
  assert.equal(profile.rows.filter(row => row.kind === 'row').length, 150);
  const first = profile.rows.find(row => row.kind === 'row');
  assert.equal(first.id, '001');
  assert.equal(first.source, '一登');
  assert.equal(first.translation, '');
  assert.equal(first.lineKind, 'narration');
  assert.deepEqual(first.mirrorPrefixes, { slash: '★◎  001  ◎★//', plain: '★◎  001  ◎★' });
  const canonicalText = canonicalize(profile);
  assert.ok(canonicalText.includes('☆001☆一登'));
  assert.equal(restore(profile, canonicalText), text);
});

test('镜像格式：legacy restore 将译文写入译文行,原文行保留', () => {
  const profile = detect(TRANSLATED, 't');
  const first = profile.rows.find(row => row.kind === 'row');
  assert.equal(first.translation, '登场');
  assert.equal(first.translationLine, '★◎  001  ◎★登场');
  const canonicalText = canonicalize(profile);
  assert.ok(canonicalText.includes('☆001☆一登'));
  assert.ok(canonicalText.includes('★001★登场'));
  // 未翻译时规范化无 ★ 行
  const profile2 = detect(TRANSLATED.replace('★◎  001  ◎★登场', '★◎  001  ◎★一登'), 'u');
  const canonical2 = canonicalize(profile2);
  assert.ok(canonical2.includes('☆001☆一登'));
  assert.ok(!canonical2.includes('★001★'));
  // 新增译文后还原: 译文行更新,原文行保留
  const restored = restore(profile2, canonical2.replace('☆001☆一登', '☆001☆一登\n★001★登场'));
  assert.equal(restored, [
    '#0xAD5',
    '★◎  001  ◎★//一登',
    '★◎  001  ◎★登场',
    '',
  ].join('\n'));
});

testWithSamples('镜像格式：增强 profile 序列化后仍可新增译文并还原', () => {
  const text = sample('dc4_asa20190429c1.txt');
  const profile = enrichDetectionProfile(text, detect(text, 'c1-profile'));
  const cloned = JSON.parse(JSON.stringify(profile));
  const canonical = canonicalizeProfile(cloned);
  assert.equal(canonical.ok, true);
  const edited = canonical.text.replace('☆001☆一登', '☆001☆一登\n★001★一登（译）');
  const restored = restoreProfile(cloned, edited);
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.ok(restored.text.includes('★◎  001  ◎★//一登')); // 原文行保留
  assert.ok(restored.text.includes('★◎  001  ◎★一登（译）')); // 译文行更新
  // 未编辑时仍字节级一致
  const noEdit = restoreProfile(cloned, canonical.text);
  assert.equal(noEdit.ok, true);
  assert.equal(noEdit.text, text);
});

test('镜像格式：编辑器闭环(parseFile → 填译文 → buildExport)产出的规范文本可还原', () => {
  const document = parseDocument(CRAFTED);
  const canonical = canonicalizeDocument(document);
  setParseConf({ open: '☆', close: '★', regex: '' });
  const paras = parseFile(canonical.text).paras;
  assert.equal(paras.length, 2);
  assert.equal(paras[0].id, '001');
  assert.equal(paras[0].done, false, '未翻译记录不预填译文');
  paras[0].translation = '一登（译）';
  paras[1].translation = '「訳文一段\\n　訳文二段」';
  const exported = buildExport(paras, '\n', false);
  const restored = restoreCanonicalDocument(document, exported);
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  const lines = restored.text.split('\n');
  assert.equal(lines[1], '★◎  001  ◎★//一登');
  assert.equal(lines[2], '★◎  001  ◎★一登（译）');
  assert.equal(lines[5], '★◎  002  ◎★//「第一句\\n　第二句」');
  assert.equal(lines[6], '★◎  002  ◎★「訳文一段\\n　訳文二段」');
});

testWithSamples('镜像格式：规范文本不会被反向误判为镜像格式', () => {
  const document = parseDocument(sample('dc4_asa20190429c1.txt'));
  const canonical = canonicalizeDocument(document);
  const reparsed = parseDocument(canonical.text, { file: 'canonical' });
  assert.notEqual(reparsed.format.framing.shape, 'mirror-dc4ph');
  assert.equal(reparsed.records[0].id, '001');
  assert.equal(reparsed.records[0].source.text, '一登');
  assert.equal(reparsed.records[0].controls[0], '#0xAD5');
});
/* ---------- 原生解析/导出(parsers.js): 不做任何格式转换 ---------- */

testWithSamples('镜像格式原生解析：5 份样本直接打开即为干净待翻译行,注释头不进正文', () => {
  for (const name of files){
    const { paras, nl, trailingBlank } = parseFile(sample(name));
    const headerCount = (sample(name).match(/^#0x[0-9A-Fa-f]+$/gm) || []).length;
    assert.equal(paras.length, headerCount, name);
    assert.equal(nl, '\n', name);
    assert.equal(trailingBlank, true, name);
    for (const p of paras){
      assert.match(p.id, /^\d{3}$/, name);
      assert.equal(p.isName, false, name);
      // 样本未翻译: 译文栏预填原文(与文件里的译文行保持一致),可直接在此基础上改
      assert.equal(p.translation, p.content, name);
      assert.equal(p.done, false, name); // 预填占位不算已翻译,进度不虚高
      assert.ok(p.mirror, name);
      assert.equal(p.mirror.plainBody, p.content, name);
      assert.ok(Array.isArray(p.comments) && p.comments.length === 1, name);
      assert.match(p.comments[0], /^#0x[0-9A-Fa-f]+$/, name);
      assert.ok(!p.content.includes('//'), name);
      assert.ok(!p.content.includes('★◎'), name);
    }
  }
});

test('镜像格式原生解析：译文栏预填原文,改过才算已翻译(占位不计进度)', () => {
  const { paras } = parseFile(CRAFTED);
  assert.equal(paras[0].content, '一登');
  assert.equal(paras[0].translation, '一登', '未翻译行译文栏预填原文');
  assert.equal(paras[0].done, false, '预填占位仍是未翻译');
  // 括号行: 预填同样带「」,比较走 stripBrackets 后的实质内容
  assert.equal(paras[1].translation, '「第一句\\n　第二句」');
  assert.equal(paras[1].done, false);
  // 改成与原文不同 → 已翻译
  paras[0].translation = '一登（译）';
  assert.equal(computeDone(paras[0]), true);
  // 改回与原文相同 → 退回占位(未翻译)
  paras[0].translation = '一登';
  assert.equal(computeDone(paras[0]), false);
  // 清空 → 未翻译
  paras[0].translation = '';
  assert.equal(computeDone(paras[0]), false);
});

test('镜像格式原生导出：预填原文后不编辑仍字节级还原,编辑只动译文行', () => {
  const { paras, nl, trailingBlank } = parseFile(CRAFTED);
  assert.equal(buildExport(paras, nl, trailingBlank), CRAFTED, '预填不影响无损还原');
  paras[0].translation = '一登（译）';
  assert.equal(buildExport(paras, nl, trailingBlank),
    CRAFTED.replace('★◎  001  ◎★一登', '★◎  001  ◎★一登（译）'));
});

test('镜像格式：预填的原文占位不会挡住缓存进度回填', () => {
  const fresh = parseFile(CRAFTED).paras;
  const saved = [{ orig: fresh[0].orig, translation: '一登（缓存）' }];
  const merged = mergeSavedState(fresh, saved);
  assert.equal(merged[0].translation, '一登（缓存）', '占位行应被缓存译文覆盖');
  assert.equal(merged[0].done, true);
  // 未命中进度的行保持预填
  assert.equal(merged[1].translation, '「第一句\\n　第二句」');
  assert.equal(merged[1].done, false);
});

testWithSamples('镜像格式原生导出：未编辑时 5 份样本字节级还原原文件', () => {
  for (const name of files){
    const text = sample(name);
    const { paras, nl, trailingBlank } = parseFile(text);
    assert.equal(buildExport(paras, nl, trailingBlank), text, name);
  }
});

test('镜像格式原生导出：译文写入译文行(无 //),原文行(//)与 #0x 头原样保留', () => {
  const { paras, nl, trailingBlank } = parseFile(CRAFTED);
  assert.equal(paras.length, 2);
  // 「」对白行锁定括号;名字行不锁
  assert.equal(paras[0].brackets, false);
  assert.equal(paras[1].brackets, true);
  paras[0].translation = '一登（译）';
  paras[1].translation = '「訳文一段\\n　訳文二段」';
  const out = buildExport(paras, nl, trailingBlank);
  assert.equal(out, [
    '#0xAD5',
    '★◎  001  ◎★//一登',
    '★◎  001  ◎★一登（译）',
    '',
    '#0xADB',
    '★◎  002  ◎★//「第一句\\n　第二句」',
    '★◎  002  ◎★「訳文一段\\n　訳文二段」',
    '',
  ].join('\n'));
  // 再解析一遍仍可继续编辑(幂等): 两行已不同 → 已翻译状态
  const again = parseFile(out);
  assert.equal(again.paras[1].translation, '「訳文一段\\n　訳文二段」');
  assert.equal(again.paras[1].done, true);
  assert.equal(again.paras[0].translation, '一登（译）');
  assert.equal(again.paras[0].done, true);
});

test('镜像格式原生导出：清空译文即回到未翻译状态(译文行保留预填原文)', () => {
  const { paras, nl, trailingBlank } = parseFile(CRAFTED);
  paras[0].translation = '一登（译）';
  paras[0].translation = ''; // 用户清空 → 未翻译
  const out = buildExport(paras, nl, trailingBlank);
  assert.equal(out, CRAFTED);
});

test('镜像格式原生解析不受用户注释/标记规则影响(按 // 有无识别,与解析配置无关)', () => {
  setParseConf({ open: '★', close: '', regex: '', commentPrefixes: [], nameIdPatterns: [] });
  try {
    const { paras } = parseFile(CRAFTED);
    assert.equal(paras.length, 2);
    assert.equal(paras[0].content, '一登');
    assert.equal(paras[0].comments[0], '#0xAD5');
  } finally {
    setParseConf({ open: '☆', close: '★', regex: '' });
  }
});

/* ---------- 旁白全角空格缩进约定 ---------- */

const CRAFTED_NAR = [
  '#0xAD5',
  '★◎  001  ◎★//　放課後、帰ってきた。',
  '★◎  001  ◎★　放課後、帰ってきた。',
  '',
  '#0xADB',
  '★◎  002  ◎★//「対話」',
  '★◎  002  ◎★「対話」',
  '',
].join('\n');

test('镜像格式旁白缩进：原文行带全角空格时译文导出自动补齐,译文已带则不重复', () => {
  const { paras, nl, trailingBlank } = parseFile(CRAFTED_NAR);
  assert.equal(paras[0].mirror.indent, true, '旁白行标记缩进');
  assert.equal(paras[1].mirror.indent, false, '对白行无缩进');
  // 译文不带空格 → 自动补齐
  paras[0].translation = '放課後、回家了。';
  let out = buildExport(paras, nl, trailingBlank);
  let lines = out.split('\n');
  assert.equal(lines[2], '★◎  001  ◎★　放課後、回家了。');
  // 译文已带空格 → 不重复
  paras[0].translation = '　放課後、回家了。';
  out = buildExport(paras, nl, trailingBlank);
  lines = out.split('\n');
  assert.equal(lines[2], '★◎  001  ◎★　放課後、回家了。');
  // 对白行不加空格
  paras[1].translation = '「对话」';
  out = buildExport(paras, nl, trailingBlank);
  lines = out.split('\n');
  assert.equal(lines[6], '★◎  002  ◎★「对话」');
});

test('镜像格式旁白缩进：清空译文回到未翻译状态仍字节级还原', () => {
  const { paras, nl, trailingBlank } = parseFile(CRAFTED_NAR);
  paras[0].translation = '放課後、回家了。';
  paras[0].translation = '';
  assert.equal(buildExport(paras, nl, trailingBlank), CRAFTED_NAR);
});

test('镜像格式旁白缩进：canonical 还原路径同样自动补齐', () => {
  const document = parseDocument(CRAFTED_NAR);
  const canonical = canonicalizeDocument(document);
  const edited = canonical.text.replace('☆001☆　放課後、帰ってきた。', '☆001☆　放課後、帰ってきた。\n★001★放課後、回家了。');
  const restored = restoreCanonicalDocument(document, edited);
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.ok(restored.text.includes('★◎  001  ◎★　放課後、回家了。'), '译文行带全角空格');
  assert.ok(restored.text.includes('★◎  001  ◎★//　放課後、帰ってきた。'), '原文行原样');
});
