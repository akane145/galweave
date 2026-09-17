import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8Bytes, sjisBytes, byteCount, usageLevel, formatByteTitle, encodingLabel, normalizeEncoding, encodingName, ENCODINGS, normalizeByteLimit, BYTE_LIMIT_MIN, BYTE_LIMIT_MAX, BYTE_LIMIT_DEFAULT } from '../src/bytes.js';

test('utf8Bytes：ASCII 1 字节 / 中文 3 字节 / 日文假名 3 字节', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('中文'), 6);
  assert.equal(utf8Bytes('あい'), 6);       // 平假名 U+3042/U+3044 → 3 字节
  assert.equal(utf8Bytes(''), 0);
  assert.equal(utf8Bytes(null), 0);
});

test('utf8Bytes：4 字节区（emoji / 罕用汉字）不能被代理对拆成两次计数', () => {
  // U+1F600 在 UTF-16 里是代理对，按码点迭代必须是 4 字节而非 6
  assert.equal(utf8Bytes('\u{1F600}'), 4);
  assert.equal(utf8Bytes('a\u{1F600}'), 5);
});

test('sjisBytes：半角 1 字节 / 全角 2 字节', () => {
  assert.equal(sjisBytes('abc'), 3);
  assert.equal(sjisBytes('中文'), 4);        // 全角 = 2 字节
  assert.equal(sjisBytes('あい'), 4);
  assert.equal(sjisBytes(''), 0);
});

test('sjisBytes：半角片假名（U+FF61–U+FF9F）按 1 字节算', () => {
  assert.equal(sjisBytes('\uFF71\uFF72'), 2);   // ｱｲ 各 1 字节
  assert.equal(sjisBytes('a\uFF71'), 2);        // a + ｱ
});

test('两种口径在同一句话上确实不同 —— 这是必须标注口径的原因', () => {
  const s = 'これはテストです';
  assert.ok(sjisBytes(s) * 1.5 === utf8Bytes(s), '全角 2 字节 vs 3 字节，应成 2:3');
  assert.equal(sjisBytes(s), 16);
  assert.equal(utf8Bytes(s), 24);
});

test('byteCount 按 enc 分派', () => {
  assert.equal(byteCount('中文', 'sjis'), 4);
  assert.equal(byteCount('中文', 'utf8'), 6);
  assert.equal(byteCount('中文'), 6);           // 默认 utf8
});

test('usageLevel 四段边界', () => {
  const L = 120;
  assert.equal(usageLevel(83, L), 'ok');        // 69.2%
  assert.equal(usageLevel(84, L), 'mid');       // 正好 70%
  assert.equal(usageLevel(107, L), 'mid');      // 89.2%
  assert.equal(usageLevel(108, L), 'near');     // 正好 90%
  assert.equal(usageLevel(120, L), 'near');     // 正好 100%，仍属 near 不报警
  assert.equal(usageLevel(121, L), 'over');     // 100.8%
});

test('usageLevel：limit 未配置（0 / 负数 / NaN）时一律 ok，不误报', () => {
  assert.equal(usageLevel(9999, 0), 'ok');
  assert.equal(usageLevel(9999, -1), 'ok');
  assert.equal(usageLevel(9999, NaN), 'ok');
  assert.equal(usageLevel(9999, undefined), 'ok');
});

test('formatByteTitle：超出时给出差量，未超出时不显示差量', () => {
  assert.equal(
    formatByteTitle(124, 120, 'utf8'),
    '124 / 120 字节（UTF-8）· 超出 4 字节'
  );
  assert.equal(
    formatByteTitle(80, 120, 'sjis'),
    '80 / 120 字节（Shift-JIS）'
  );
  assert.equal(
    formatByteTitle(120, 120, 'utf8'),
    '120 / 120 字节（UTF-8）'          // 正好等于上限不算超出
  );
});

test('encodingLabel', () => {
  assert.equal(encodingLabel('sjis'), 'SJIS');
  assert.equal(encodingLabel('utf8'), 'UTF8');
  assert.equal(encodingLabel(), 'UTF8');
});

test('normalizeEncoding：只认 sjis，其余（含大小写/空白/非法值）回退 utf8', () => {
  assert.equal(normalizeEncoding('sjis'), 'sjis');
  assert.equal(normalizeEncoding('SJIS'), 'sjis');        // 持久化读回可能大小写不一致
  assert.equal(normalizeEncoding(' sjis '), 'sjis');
  assert.equal(normalizeEncoding('utf8'), 'utf8');
  assert.equal(normalizeEncoding('utf-8'), 'utf8');       // 常见误写不认，回退默认
  assert.equal(normalizeEncoding(''), 'utf8');
  assert.equal(normalizeEncoding(null), 'utf8');
  assert.equal(normalizeEncoding(undefined), 'utf8');
  assert.equal(normalizeEncoding(0), 'utf8');
  assert.equal(normalizeEncoding({}), 'utf8');
});

test('encodingLabel：非法值走与 normalizeEncoding 相同的回退路径', () => {
  assert.equal(encodingLabel('SJIS'), 'SJIS');
  assert.equal(encodingLabel('啥'), 'UTF8');
  assert.equal(encodingLabel(null), 'UTF8');
});

test('encodingName：给出中文说明，两种口径文案不同', () => {
  assert.equal(encodingName('sjis'), 'Shift-JIS（全角 2 字节）');
  assert.equal(encodingName('utf8'), 'UTF-8（中文 3 字节）');
  assert.equal(encodingName('啥'), 'UTF-8（中文 3 字节）');
});

test('ENCODINGS 顺序即设置项下拉顺序，且与 normalizeEncoding 的合法集合一致', () => {
  assert.deepEqual(ENCODINGS, ['utf8', 'sjis']);
  for (const e of ENCODINGS) assert.equal(normalizeEncoding(e), e);
});

test('normalizeByteLimit: 0 / 负数 / 非法 → 0（"不校验"），合法值钳位取整', () => {
  assert.equal(normalizeByteLimit(0), 0);
  assert.equal(normalizeByteLimit(-5), 0);
  assert.equal(normalizeByteLimit(''), 0);
  assert.equal(normalizeByteLimit(null), 0);
  assert.equal(normalizeByteLimit(undefined), 0);
  assert.equal(normalizeByteLimit('abc'), 0);
  assert.equal(normalizeByteLimit(NaN), 0);
});

test('normalizeByteLimit: 合法值钳到 [20, 4000] 并取整', () => {
  assert.equal(normalizeByteLimit(120), 120);
  assert.equal(normalizeByteLimit('120'), 120);
  assert.equal(normalizeByteLimit(120.6), 121);
  assert.equal(normalizeByteLimit(1), BYTE_LIMIT_MIN);      // 下限 20
  assert.equal(normalizeByteLimit(999999), BYTE_LIMIT_MAX); // 上限 4000
  assert.equal(BYTE_LIMIT_DEFAULT, 120);
});
