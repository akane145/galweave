import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalize,
  detect,
  renderReport,
  restore,
} from '../src/recognize.js';
import {
  canonicalizeDocument,
  canonicalizeProfile,
  enrichDetectionProfile,
  maskProtectedTokens,
  parseDocument,
  renderDocument,
  restoreCanonicalDocument,
  restoreProfile,
  restoreProtectedTokens,
  serializeDocument,
  tokenizeInline,
} from '../src/universal-parser.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sampleDir = resolve(root, 'test text');
const samples = readdirSync(sampleDir)
  .filter(name => name.endsWith('.txt'))
  .sort((a, b) => a.localeCompare(b, 'zh-CN'));

function sample(name){
  return readFileSync(resolve(sampleDir, name), 'utf8');
}

test('通用格式档案：13 份现有样本均可规范化后字节级还原', () => {
  assert.equal(samples.length, 13);
  for (const name of samples){
    const text = sample(name);
    const profile = enrichDetectionProfile(text, detect(text, name));
    assert.equal(restore(profile, canonicalize(profile)), text, name);
    assert.equal(profile.formatProfile.version, 1, name);
    assert.ok(profile.modules.records.length > 0, name);
    assert.equal(serializeDocument(parseDocument(text, { profile, file: name })), text, name);
  }
});

test('行内 token：识别并原样保留换行、等待、字体、位置和通用命令', () => {
  const text = '前半<r>后半[n][r][np]%p-1;%fＭＳ ゴシック;\\n[イロニー,1]';
  const tokens = tokenizeInline(text);
  assert.equal(tokens.map(token => token.value).join(''), text);
  assert.deepEqual(
    tokens.filter(token => token.type === 'control').map(token => token.role),
    ['line-break', 'line-break', 'line-break', 'wait', 'position', 'font', 'line-break', 'command']
  );
});

test('语义模块：显式标题、N 名字行、R 指令与括号说话人可区分', () => {
  const title = parseDocument(sample('新建 文本文档 (10).txt')).records;
  assert.equal(title[0].kind, 'title');

  const suffix = parseDocument(sample('新建 文本文档 (3).txt')).records;
  assert.equal(suffix[0].kind, 'directive');
  assert.equal(suffix[1].kind, 'speaker');
  assert.equal(suffix[2].kind, 'dialogue');
  assert.equal(suffix[2].speaker.mode, 'inherited');
  assert.equal(suffix[2].speaker.source, '里奈');

  const bracket = parseDocument(sample('新建 文本文档 (13).txt')).records;
  assert.equal(bracket[0].kind, 'dialogue');
  assert.equal(bracket[0].speaker.mode, 'bracket');
  assert.equal(bracket[0].speaker.source, '照');
  assert.ok(bracket[0].source.tokens.some(token => token.value === '[np]' && token.protected));
});

test('弱语义：无标记名字通过相邻对白推断，但必须留下低置信诊断', () => {
  const records = parseDocument(sample('新建 文本文档 (9).txt')).records;
  const speaker = records.find(record => record.source.text === '無名');
  assert.equal(speaker.kind, 'speaker');
  assert.ok(speaker.confidence < 0.8);
  assert.ok(speaker.diagnostics.includes('inferred-speaker'));
  const following = records[records.indexOf(speaker) + 1];
  assert.equal(following.kind, 'dialogue');
  assert.equal(following.speaker.source, '無名');
});

test('连续原译文对不依赖空行也能分成多个段落', () => {
  const text = '☆0001☆第一句\n★0001★第一句译文\n☆0002☆第二句\n★0002★第二句译文\n';
  const document = parseDocument(text);
  assert.equal(document.stats.paired, 2);
  assert.equal(document.records.length, 2);
  assert.equal(serializeDocument(document), text);
});

test('识别报告展示语义模块统计与低置信数量', () => {
  const text = sample('新建 文本文档 (9).txt');
  const profile = enrichDetectionProfile(text, detect(text, 'sample-9'));
  const report = renderReport(profile);
  assert.match(report, /模块:/);
  assert.match(report, /低置信 \d+/);
});

test('正文中的标记字符不被误判为说话人分隔符', () => {
  const document = parseDocument('☆1☆正文含☆字符\n★1★译文含☆字符\n');
  assert.equal(document.records[0].source.text, '正文含☆字符');
  assert.equal(document.records[0].source.explicitSpeaker, '');

  const dialogue = parseDocument('☆2☆角色☆「正文含☆字符」\n★2★角色★「译文」\n');
  assert.equal(dialogue.records[0].source.explicitSpeaker, '角色');
  assert.equal(dialogue.records[0].source.text, '「正文含☆字符」');
});

test('物理结构：混合换行、重复 ID 与显式空注释规则均不丢失', () => {
  const text = '# meta\r\n☆1☆A\n★1★甲\r☆1☆B\r\n★1★乙';
  const document = parseDocument(text);
  assert.equal(serializeDocument(document), text);
  assert.deepEqual(document.records.map(record => record.key), ['1#1', '1#2']);
  assert.deepEqual(document.records[0].controls, ['# meta']);

  const noComments = parseDocument('# meta\n', {
    profile: { marks: { open: '☆', close: '★' }, commentPrefixes: [] },
  });
  assert.equal(noComments.issues[0].type, 'unmarked-line');
});

test('格式档案记录系统性编号偏移，但保留原译文各自 ID', () => {
  const text = sample('新建 文本文档 (11).txt');
  const profile = enrichDetectionProfile(text, detect(text, 'offset'));
  assert.equal(profile.formatProfile.pairing.strategy, 'position-with-systematic-offset');
  assert.equal(profile.formatProfile.pairing.offset, 1);
  assert.equal(profile.modules.records[0].source.id, '000000T');
  assert.equal(profile.modules.records[0].translation.id, '000001T');
});

test('完全没有共同 ID 时以相邻行恢复标记对并识别系统偏移', () => {
  const text = '☆000T☆A\n★100T★甲\n☆001T☆B\n★101T★乙\n';
  const legacy = detect(text, 'fully-offset');
  assert.equal(legacy.marks.close, '');
  const profile = enrichDetectionProfile(text, legacy);
  assert.equal(profile.marks.open, '☆');
  assert.equal(profile.marks.close, '★');
  assert.equal(profile.parseConfig.close, '★');
  assert.equal(profile.idOffset.offset, 100);
  assert.equal(profile.idOffset.systematic, true);
});

test('受保护 token：重复与相邻标签可逆，正文允许自由翻译', () => {
  const masked = maskProtectedTokens('「前半[r][r]后半」[np]');
  assert.equal(masked.tokens.length, 3);
  assert.notEqual(masked.tokens[0].placeholder, masked.tokens[1].placeholder);
  assert.equal(masked.text.includes('[r]'), false);

  const translated = masked.text.replace('前半', '上半').replace('后半', '下半');
  assert.deepEqual(restoreProtectedTokens(translated, masked), {
    ok: true,
    text: '「上半[r][r]下半」[np]',
    errors: [],
  });
});

test('受保护 token：丢失、重复、重排和未知 mask 均明确失败', () => {
  const masked = maskProtectedTokens('A[r]B[np]C');
  const [first, second] = masked.tokens.map(token => token.placeholder);

  assert.equal(restoreProtectedTokens(`译文${first}`, masked).ok, false);
  assert.ok(restoreProtectedTokens(`译文${first}${first}${second}`, masked).errors.some(error => error.code === 'duplicate'));
  assert.ok(restoreProtectedTokens(`译文${second}${first}`, masked).errors.some(error => error.code === 'reordered'));
  assert.ok(restoreProtectedTokens(`译文${first}${second}⟦GWCTRL:99⟧`, masked).errors.some(error => error.code === 'unknown'));
});

test('受保护 token：源文已有占位符样式时自动换命名空间', () => {
  const masked = maskProtectedTokens('原文⟦GWCTRL:0⟧[n]');
  assert.notEqual(masked.tokens[0].placeholder, '⟦GWCTRL:0⟧');
  const restored = restoreProtectedTokens(masked.text, masked);
  assert.equal(restored.ok, true);
  assert.equal(restored.text, '原文⟦GWCTRL:0⟧[n]');
});

test('换行类丢失：就近回填到下一个存活占位符之前 / 末尾', () => {
  // 中间丢失 → 插到下一个存活占位符之前
  let masked = maskProtectedTokens('A[r]B[np]C');
  const wait = masked.tokens[1].placeholder;
  assert.deepEqual(restoreProtectedTokens(`A B${wait}C`, masked), {
    ok: true, text: 'A B[r][np]C', errors: [],
  });
  // 末尾丢失（没有下一个存活占位符）→ 补在末尾
  masked = maskProtectedTokens('A[np]B[r]');
  assert.deepEqual(restoreProtectedTokens(`A${masked.tokens[0].placeholder}B`, masked), {
    ok: true, text: 'A[np]B[r]', errors: [],
  });
  // 连续多个换行丢失 → 按源顺序回填在同一锚点前
  masked = maskProtectedTokens('A[r]B[n]C[np]D');
  const only = masked.tokens[2].placeholder;
  assert.deepEqual(restoreProtectedTokens(`A B C${only}D`, masked), {
    ok: true, text: 'A B C[r][n][np]D', errors: [],
  });
});

test('换行类丢失可回填，但重复/换序仍然失败（不放过真正的破坏）', () => {
  const masked = maskProtectedTokens('A[r]B');
  const ph = masked.tokens[0].placeholder;
  const dup = restoreProtectedTokens(`A${ph}${ph}B`, masked);
  assert.equal(dup.ok, false);
  assert.equal(dup.errors[0].code, 'duplicate');

  const reordered = maskProtectedTokens('A[r]B[np]C');
  const [p0, p1] = reordered.tokens.map(token => token.placeholder);
  const rev = restoreProtectedTokens(`A${p1}B${p0}C`, reordered);
  assert.equal(rev.ok, false);
  assert.ok(rev.errors.some(error => error.code === 'reordered'));
});

test('命令类丢失仍硬拒，且错误带上角色与原值（便于指明是哪个控制符）', () => {
  // 只丢定位命令
  const masked = maskProtectedTokens('A%p100;B');
  const missing = restoreProtectedTokens('AB', masked);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.errors, [
    { code: 'missing', placeholder: masked.tokens[0].placeholder, role: 'position', value: '%p100;' },
  ]);

  // 换行丢失（可回填）与字体命令丢失（不可）同时发生 → 仍然失败，且只报命令那一条
  const mixed = maskProtectedTokens('A[r]B%fＭＳ ゴシック;C');
  const breakPh = mixed.tokens[0].placeholder;
  const result = restoreProtectedTokens(`A B${breakPh}C`, mixed);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].role, 'font');

  // 模型自己编了一个占位符 → 依旧失败
  const unknown = restoreProtectedTokens(`A${breakPh}⟦GWCTRL:77⟧C`, mixed);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some(error => error.code === 'unknown'));
});

test('局部回写：重复 ID 只修改指定 occurrence，并保持 EOL 与另一记录', () => {
  const text = '☆1☆A\r\n★1★甲\r\n☆1☆B\n★1★乙';
  const document = parseDocument(text);
  const result = renderDocument(document, { '1#2': { translationText: '乙改' } });
  assert.deepEqual(result, { ok: true, text: '☆1☆A\r\n★1★甲\r\n☆1☆B\n★1★乙改', errors: [] });
});

test('局部回写：原译 ID 偏移、段式说话人和未编辑前缀保持原样', () => {
  const text = '☆000T☆原名☆「原文」\n★001T★译名★「译文」\n';
  const document = parseDocument(text);
  const result = renderDocument(document, {
    '000T#1': { sourceSpeaker: '新原名', translationSpeaker: '新译名', translationText: '「新译文」' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '☆000T☆新原名☆「原文」\n★001T★新译名★「新译文」\n');
});

test('局部回写：括号说话人的括号样式与周围空白不变', () => {
  const text = '○1○  [[久遠]]   「原文」[np]\n●1● 【久远】 「译文」[np]\n';
  const document = parseDocument(text);
  const result = renderDocument(document, {
    '1#1': { sourceSpeaker: '永遠', translationSpeaker: '永远', translationText: '「新译文」[np]' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '○1○  [[永遠]]   「原文」[np]\n●1● 【永远】 「新译文」[np]\n');
});

test('局部回写：控制 token 被删除或重排时拒绝输出', () => {
  const document = parseDocument('☆1☆A[r]B[np]\n★1★甲[r]乙[np]\n');
  const missing = renderDocument(document, { '1#1': { translationText: '新译文[np]' } });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(error => error.code === 'protected-token-mismatch'));

  const reordered = renderDocument(document, { '1#1': { translationText: '新[np]译[r]文' } });
  assert.equal(reordered.ok, false);
  assert.ok(reordered.errors.some(error => error.code === 'protected-token-mismatch'));
});

test('新规范化适配器：13 份样本未编辑时均可还原原文件', () => {
  for (const name of samples){
    const original = sample(name);
    const document = parseDocument(original, { file: name });
    const canonical = canonicalizeDocument(document);
    assert.equal(canonical.ok, true, name);
    const restored = restoreCanonicalDocument(document, canonical.text);
    assert.equal(restored.ok, true, name);
    assert.equal(restored.text, original, name);
  }
});

test('新规范化适配器：无空行、重复 ID 和编号偏移可定点回写', () => {
  const original = '☆1T☆A\r\n★2T★甲\r\n☆1T☆B\n★2T★乙';
  const document = parseDocument(original);
  const canonical = canonicalizeDocument(document);
  assert.equal(canonical.ok, true);
  assert.match(canonical.text, /☆1T☆A[\s\S]*☆1T☆B/);

  const edited = canonical.text.replace('★2T★乙', '★2T★乙改');
  const restored = restoreCanonicalDocument(document, edited);
  assert.equal(restored.ok, true);
  assert.equal(restored.text, '☆1T☆A\r\n★2T★甲\r\n☆1T☆B\n★2T★乙改');
});

test('新规范化适配器：括号说话人译名可以写回且保留原空白', () => {
  const original = '○1○  [[久遠]]   「原文」[np]\n●1● 【久远】 「译文」[np]\n';
  const document = parseDocument(original);
  const canonical = canonicalizeDocument(document);
  const edited = canonical.text.replace('★1★久远★「译文」[np]', '★1★永远★「新译文」[np]');
  const restored = restoreCanonicalDocument(document, edited);
  assert.equal(restored.ok, true);
  assert.equal(restored.text, '○1○  [[久遠]]   「原文」[np]\n●1● 【永远】 「新译文」[np]\n');
});

test('新规范化适配器：未知物理行拒绝规范化，不静默丢数据', () => {
  const document = parseDocument('未标记控制行\n☆1☆正文\n★1★译文\n');
  const canonical = canonicalizeDocument(document);
  assert.equal(canonical.ok, false);
  assert.ok(canonical.errors.some(error => error.code === 'unsupported-line'));
});

test('增强 profile 自带可序列化的无损恢复信息', () => {
  const original = sample('新建 文本文档 (13).txt');
  const profile = enrichDetectionProfile(original, detect(original, 'profile'));
  const cloned = JSON.parse(JSON.stringify(profile));
  const canonical = canonicalizeProfile(cloned);
  assert.equal(canonical.ok, true);
  const restored = restoreProfile(cloned, canonical.text.replace('唔喵唔喵', '呼噜呼噜'));
  assert.equal(restored.ok, true);
  assert.match(restored.text, /呼噜呼噜/);
  assert.match(restored.text, /\[np\]/);
});
