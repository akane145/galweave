// validate.test.mjs — 结构校验与原文基线比对

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLines } from '../src/lineparse.js';
import {
  validateStructure, baselineFrom, diffBaseline, SEVERITY,
} from '../src/validate.js';

const P = (text, conf) => parseLines(text, conf ? { conf } : undefined);
const codes = (findings) => findings.map(f => f.code);

/* ---------------- 编号不匹配 ---------------- */

test('编号不匹配：★ 行编号与 ☆ 行不一致报 error', () => {
  const parsed = P('☆0001☆藍☆「あ」\n★0002★蓝★「啊」\n');
  const f = validateStructure(parsed);
  assert.deepEqual(codes(f), ['id-mismatch']);
  assert.equal(f[0].severity, SEVERITY.ERROR);
  assert.equal(f[0].line, 1, '应指向译文行');
  assert.match(f[0].message, /0002.*0001/);
});

test('编号一致时不报', () => {
  const f = validateStructure(P('☆0001☆藍☆「あ」\n★0001★蓝★「啊」\n'));
  assert.equal(f.length, 0);
});

/* ---------------- 编号系统性偏移（引擎约定，不是错误） ---------------- */

test('编号统一 +1 的引擎约定不逐行报错，只给一条 info', () => {
  // 实测样本 新建 文本文档 (11).txt 就是这个形态：全部 33 对都是 ★ = ☆ + 1
  const paras = [];
  for (let i = 0; i < 5; i++) {
    const a = String(i).padStart(6, '0');
    const b = String(i + 1).padStart(6, '0');
    paras.push(`☆${a}T☆「あ${i}」`, `★${b}T★「啊${i}」`, '');
  }
  const f = validateStructure(P(paras.join('\n')));
  const errs = f.filter(x => x.severity === SEVERITY.ERROR);
  assert.deepEqual(errs, [], '统一偏移不该刷 error');
  const info = f.filter(x => x.code === 'id-offset');
  assert.equal(info.length, 1);
  assert.match(info[0].message, /统一比原文行大 1/);
  assert.match(info[0].message, /不适合"原格式导出"/);
});

test('编号是十进制计数器时不能被当成十六进制算偏移', () => {
  // 关键回归：000009 → 000010 在这套编号里是 +1。
  // 若按十六进制解析，0x09=9 而 0x10=16，会被算成 +7，从而误报一堆"不一致"。
  const paras = [];
  for (let i = 8; i < 13; i++) {
    const a = String(i).padStart(6, '0');
    const b = String(i + 1).padStart(6, '0');
    paras.push(`☆${a}T☆「あ${i}」`, `★${b}T★「啊${i}」`, '');
  }
  const f = validateStructure(P(paras.join('\n')));
  assert.deepEqual(f.filter(x => x.severity === SEVERITY.ERROR), [],
    '跨 000009→000010 的十进制进位不该被误判');
});

test('十六进制地址型编号也能识别出偏移', () => {
  const paras = [];
  for (let i = 0xE; i < 0x14; i++) {
    const a = i.toString(16).toUpperCase().padStart(6, '0');
    const b = (i + 1).toString(16).toUpperCase().padStart(6, '0');
    paras.push(`☆${a}☆「あ」`, `★${b}★「啊」`, '');
  }
  const f = validateStructure(P(paras.join('\n')));
  assert.deepEqual(f.filter(x => x.severity === SEVERITY.ERROR), []);
  assert.equal(f.filter(x => x.code === 'id-offset').length, 1);
});

test('偏移约定里有个别不合群的行，只报那几行', () => {
  const paras = [];
  for (let i = 0; i < 5; i++) {
    const a = String(i).padStart(6, '0');
    const b = String(i === 3 ? 9 : i + 1).padStart(6, '0'); // 第 4 对故意错
    paras.push(`☆${a}T☆「あ${i}」`, `★${b}T★「啊${i}」`, '');
  }
  const f = validateStructure(P(paras.join('\n')));
  const errs = f.filter(x => x.severity === SEVERITY.ERROR);
  assert.equal(errs.length, 1, '只报不合群的那一行');
  assert.equal(errs[0].code, 'id-mismatch');
});

test('证据不足（少于 3 对）时不承认非零偏移，照常报错', () => {
  const f = validateStructure(P('☆0001☆藍☆「あ」\n★0002★蓝★「啊」\n'));
  assert.deepEqual(f.filter(x => x.code === 'id-mismatch').length, 1,
    '只有一对时 +1 不足以证明是约定');
});

test('真实样本上不产生任何 error 级发现（样本都是正常成品文件）', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { pickRule, BUILTIN_RULES, normalizeRule } = await import('../src/rules.js');

  const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.resolve(extDir, '../test text');
  if (!fs.existsSync(dir)) { t.skip('样本目录不存在'); return; }

  const lib = BUILTIN_RULES.slice();
  for (const n of fs.readdirSync(path.join(extDir, 'rules')).filter(f => f.endsWith('.json'))) {
    lib.push(normalizeRule(JSON.parse(fs.readFileSync(path.join(extDir, 'rules', n), 'utf8')), path.basename(n, '.json')));
  }

  const noisy = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.txt'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const picked = pickRule(text, lib);
    if (!picked) continue;
    const findings = validateStructure(P(text, picked.rule.conf));
    for (const x of findings) {
      if (x.severity === SEVERITY.ERROR) noisy.push(`${f} 第 ${x.line + 1} 行：${x.message}`);
    }
  }
  assert.deepEqual(noisy, [], `正常文件不该报 error：\n${noisy.join('\n')}`);
});

/* ---------------- 段内多余行 ---------------- */

test('段内第三行起报 warning（保存时会丢失）', () => {
  const f = validateStructure(P('☆0001☆A☆「あ」\n★0001★甲★「啊」\n☆0002☆B☆「い」\n'));
  const extra = f.filter(x => x.code === 'extra-lines');
  assert.equal(extra.length, 1);
  assert.equal(extra[0].severity, SEVERITY.WARNING);
  assert.equal(extra[0].line, 2);
  assert.match(extra[0].message, /1 行/);
});

/* ---------------- 编号重复 ---------------- */

test('编号重复：同一编号出现两次，两处都报', () => {
  const f = validateStructure(P([
    '☆0001☆A☆「あ」', '★0001★甲★「啊」', '',
    '☆0001☆B☆「い」', '★0001★乙★「咦」', '',
  ].join('\n')));
  const dup = f.filter(x => x.code === 'duplicate-id');
  assert.equal(dup.length, 2, '重复的两段各报一条');
  assert.match(dup[0].message, /出现 2 次/);
});

test('编号为空时不参与重复检查（旁白行常无编号）', () => {
  const f = validateStructure(P('plain one\n\nplain two\n'));
  assert.deepEqual(codes(f), []);
});

/* ---------------- 译文行缺编号 ---------------- */

test('译文行有内容但解析不出编号报 warning', () => {
  // 第二行完全没有标记字符（常见于手误把 ★ 删掉）
  const f = validateStructure(P('☆0001☆A☆「あ」\n「啊」\n'));
  const orphan = f.filter(x => x.code === 'orphan-trans');
  assert.equal(orphan.length, 1);
  assert.match(orphan[0].message, /没有解析出编号/);
});

test('译文行的标记对存在但编号不同 → 走编号不匹配而不是缺编号', () => {
  // 这里 ★译文本行没有标记★ 本身构成一对合法标记，编号是「译文本行没有标记」
  const f = validateStructure(P('☆0001☆A☆「あ」\n★别的东西★「啊」\n'));
  assert.deepEqual(codes(f), ['id-mismatch']);
});

/* ---------------- 人名条目 ---------------- */

test('人名条目没给名字报 hint', () => {
  const f = validateStructure(P('☆NAME|1☆\n'));
  const n = f.filter(x => x.code === 'name-untranslated');
  assert.equal(n.length, 1);
  assert.equal(n[0].severity, SEVERITY.HINT);
});

test('人名条目有名字时不报（有默认名即算已译）', () => {
  const f = validateStructure(P('☆NAME|1☆李四\n'));
  assert.deepEqual(codes(f), []);
});

/* ---------------- 未翻译（可选项） ---------------- */

test('未翻译默认不报，开启后才报', () => {
  const text = '☆0001☆A☆「あ」\n';
  assert.deepEqual(codes(validateStructure(P(text))), []);
  const on = validateStructure(P(text), { reportUntranslated: true });
  assert.deepEqual(codes(on), ['untranslated']);
  assert.equal(on[0].severity, SEVERITY.HINT);
});

/* ---------------- 排序与健壮性 ---------------- */

test('结果按行号排序，便于逐行核对', () => {
  const f = validateStructure(P([
    '☆0001☆A☆「あ」', '★0009★甲★「啊」', '多余行', '',
    '☆0002☆B☆「い」', '★0002★乙★「咦」', '',
    '☆0003☆C☆「う」', '★0003★丙★「呜」', '',
    '☆0002☆D☆「え」', '★0002★丁★「诶」', '',
  ].join('\n')));
  const lines = f.map(x => x.line);
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
});

test('空输入不抛错', () => {
  assert.deepEqual(validateStructure(parseLines('')), []);
  assert.deepEqual(validateStructure(null), []);
});

/* ---------------- 基线 ---------------- */

test('baselineFrom：抽原文行，排除人名条目', () => {
  const parsed = P('☆0001☆A☆「あ」\n★0001★甲★「啊」\n\n☆NAME|1☆李四\n');
  assert.deepEqual(baselineFrom(parsed), ['☆0001☆A☆「あ」']);
});

test('diffBaseline：未记录基线时不做检查', () => {
  const parsed = P('☆0001☆A☆「あ」\n');
  assert.deepEqual(diffBaseline(parsed, null), []);
  assert.deepEqual(diffBaseline(parsed, []), []);
});

test('diffBaseline：完全一致时无发现', () => {
  const text = '☆0001☆A☆「あ」\n★0001★甲★「啊」\n\n☆0002☆B☆「い」\n';
  const parsed = P(text);
  assert.deepEqual(diffBaseline(parsed, baselineFrom(parsed)), []);
});

test('diffBaseline：原文行被改动时报 warning 并指向该行', () => {
  const parsed = P('☆0001☆A☆「あ」\n★0001★甲★「啊」\n\n☆0002☆B改过了☆「い」\n');
  const baseline = ['☆0001☆A☆「あ」', '☆0002☆B☆「い」'];
  const f = diffBaseline(parsed, baseline);
  const line = f.filter(x => x.code === 'baseline-line' && x.line === 3);
  assert.equal(line.length, 1, '应指向第 4 行（0 基 3）');
  assert.equal(line[0].severity, SEVERITY.WARNING);
});

test('diffBaseline：段落数变化报 info', () => {
  const parsed = P('☆0001☆A☆「あ」\n');
  const f = diffBaseline(parsed, ['☆0001☆A☆「あ」', '☆0002☆B☆「い」']);
  assert.ok(f.some(x => x.code === 'baseline-count' && x.severity === SEVERITY.INFO));
});

test('diffBaseline：句中插入导致的错位不误报（内容仍在基线里）', () => {
  const baseline = ['☆0001☆A☆「あ」', '☆0002☆B☆「い」', '☆0003☆C☆「う」'];
  // 在最前面插入一段新内容 → 后面整体错位
  const parsed = P([
    '☆0000☆NEW☆「新」', '★0000★新★「新」', '',
    '☆0001☆A☆「あ」', '★0001★甲★「啊」', '',
    '☆0002☆B☆「い」', '★0002★乙★「咦」', '',
    '☆0003☆C☆「う」', '★0003★丙★「呜」', '',
  ].join('\n'));
  const f = diffBaseline(parsed, baseline);
  const changed = f.filter(x => x.code === 'baseline-line');
  assert.equal(changed.length, 1, '只应报新增的那一段，不该把后面三段全报成改动');
  assert.match(changed[0].message, /NEW/);
});

test('diffBaseline：基线里的行在当前文件找不到时报出来', () => {
  const parsed = P('☆0001☆A☆「あ」\n');
  const f = diffBaseline(parsed, ['☆0001☆A☆「あ」', '☆0009☆消失☆「消」']);
  const gone = f.filter(x => x.code === 'baseline-line' && /找不到/.test(x.message));
  assert.equal(gone.length, 1);
  assert.match(gone[0].message, /消失/);
});

test('diffBaseline：真实样本上基线自比对无噪音', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test text');
  if (!fs.existsSync(dir)) { t.skip('样本目录不存在'); return; }
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.txt'))) {
    const parsed = P(fs.readFileSync(path.join(dir, f), 'utf8'));
    const findings = diffBaseline(parsed, baselineFrom(parsed));
    assert.deepEqual(findings, [], `${f}: 自比对不应有任何发现`);
  }
});

/* ---------------- 镜像格式（dc4ph） ---------------- */

test('镜像格式：真实样本不产生任何结构问题', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test text/dc4ph');
  if (!fs.existsSync(dir)) { t.skip('镜像样本目录不存在'); return; }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
  assert.ok(files.length > 0, '镜像样本目录里应有文件');

  for (const f of files) {
    const parsed = P(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(parsed.isMirror, true, `${f}: 应判为镜像格式`);
    // 编号（transId）来自译文行本身，所以既不会报"编号不匹配"，也不会报"译文行缺编号"
    assert.deepEqual(validateStructure(parsed), [], `${f}: 成品文件不该有任何发现`);
    assert.deepEqual(baselineFrom(parsed), parsed.paras.map(p => p.orig), `${f}: 基线应含全部原文行`);
    assert.deepEqual(diffBaseline(parsed, baselineFrom(parsed)), [], `${f}: 自比对无发现`);
  }
});
