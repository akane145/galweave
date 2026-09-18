// encoding.test.mjs — 编码检测与反向编码
//
// 判定要覆盖两类误判：
//   ① 把 EUC-JP 当 Shift-JIS（A1-DF 在 SJIS 里是合法半角片假名，"能解出来"不代表解对了）
//   ② 把任意垃圾字节当某种日文编码（拿不准必须返回 unknown，让上层什么都不做）
//
// 样本构造方式：用本模块的反向表把日语文本编成 Shift-JIS / EUC-JP 字节，再用 TextDecoder 独立解回来核对 ——
// 于是"样本确实是那种编码"这件事不依赖检测器本身。另外补两组硬编码字节（0x82A0 0x82A2 等）作为独立锚点。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENC, detectEncoding, decodeBytes, isValidUtf8, scanShiftJis, scanEucJp, hasIso2022JpEscape,
  scoreJapanese, buildReverseTable, encodeWithTable, candidateSequences,
  vsCodeEncodingId, encodingLabel, needsUtf8Attention, DECODER_LABEL,
} from '../src/encoding.js';

const decodeLenient = (label, bytes) => new TextDecoder(label).decode(bytes);
const decodeStrict = (label, bytes) => new TextDecoder(label, { fatal: true }).decode(bytes);
const detect = (bytes, withDecoder = true) => detectEncoding(bytes, withDecoder ? { decode: decodeLenient } : {});

/* ---------------- 结构判定 ---------------- */

test('检测：BOM 一票定音', () => {
  assert.equal(detect([0xEF, 0xBB, 0xBF, 0x61]).encoding, ENC.UTF8_BOM);
  assert.equal(detect([0xFF, 0xFE, 0x42, 0x30]).encoding, ENC.UTF16LE);
  assert.equal(detect([0xFE, 0xFF, 0x30, 0x42]).encoding, ENC.UTF16BE);
  assert.equal(detect([0xFF, 0xFE, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]).encoding, ENC.UNKNOWN, 'UTF-32 不解码，但要说清楚');
  assert.equal(detect([0xEF, 0xBB, 0xBF]).bom, true);
});

test('检测：纯 ASCII 与空文件按 UTF-8', () => {
  assert.equal(detect([]).encoding, ENC.UTF8);
  assert.equal(detect([0x61, 0x62, 0x63]).encoding, ENC.UTF8);
  assert.equal(detect('☆0001☆'.split('').map(c => c.charCodeAt(0))).encoding, ENC.UTF8, 'ASCII 子集');
});

test('检测：合法 UTF-8 直接判 UTF-8', () => {
  const bytes = new TextEncoder().encode('☆0001☆藍☆「おはよう、早起きだな」');
  const r = detect(bytes);
  assert.equal(r.encoding, ENC.UTF8);
  assert.equal(r.confidence, 'high');
});

test('检测：无 BOM 的 UTF-16（NUL 集中在同一侧）', () => {
  // 至少 16 字节才用这条判据：短文件里的孤立 NUL 更可能是二进制碎片，不该当 UTF-16
  const le = [0x42, 0x00, 0x30, 0x00, 0x44, 0x00, 0x30, 0x00, 0x45, 0x00, 0x30, 0x00, 0x46, 0x00, 0x30, 0x00];
  assert.equal(detect(le).encoding, ENC.UTF16LE);
  const be = [0x00, 0x42, 0x00, 0x30, 0x00, 0x44, 0x00, 0x30, 0x00, 0x45, 0x00, 0x30, 0x00, 0x46, 0x00, 0x30];
  assert.equal(detect(be).encoding, ENC.UTF16BE);
  assert.notEqual(detect(le).encoding, ENC.UTF8, '满是 NUL 的 UTF-16 不能被当成 ASCII');

  // 含 NUL 又不像 UTF-16 的，直接判 unknown，别硬认成某种日文编码
  assert.equal(detect([0x61, 0x00, 0xFF, 0x80, 0xA0, 0xFD, 0x80, 0xFF]).encoding, ENC.UNKNOWN);
});

test('检测：ISO-2022-JP 的 ESC 切换序列', () => {
  const bytes = [0x1B, 0x24, 0x42, 0x24, 0x22, 0x24, 0x24, 0x1B, 0x28, 0x42];
  assert.equal(hasIso2022JpEscape(bytes), true);
  assert.equal(detect(bytes).encoding, ENC.ISO2022JP);
  assert.equal(hasIso2022JpEscape([0x61, 0x62]), false);
});

test('UTF-8 严格校验：过长编码、代理区、截断都拒绝', () => {
  assert.equal(isValidUtf8(new TextEncoder().encode('あ')), true);
  assert.equal(isValidUtf8([0xC0, 0xAF]), false, '过长编码');
  assert.equal(isValidUtf8([0xED, 0xA0, 0x80]), false, '代理区');
  assert.equal(isValidUtf8([0xE3, 0x81]), false, '截断');
  assert.equal(isValidUtf8([0xF4, 0x90, 0x80, 0x80]), false, '超过 U+10FFFF');
});

/* ---------------- Shift-JIS / EUC-JP ---------------- */

test('检测：Shift-JIS 硬编码锚点（あい）', () => {
  // 0x82A0 = あ、0x82A2 = い（CP932）
  const r = detect([0x82, 0xA0, 0x82, 0xA2]);
  assert.equal(r.encoding, ENC.SJIS);
  assert.equal(r.confidence, 'high');
  assert.equal(decodeStrict('shift_jis', Uint8Array.from([0x82, 0xA0, 0x82, 0xA2])), 'あい');
});

test('检测：EUC-JP 硬编码锚点（あい）—— 没有解码器时只能保守判 Shift-JIS', () => {
  const bytes = [0xA4, 0xA2, 0xA4, 0xA4];
  assert.equal(decodeStrict('euc-jp', Uint8Array.from(bytes)), 'あい');
  // 结构上两种都合法（A1-DF 在 SJIS 里是半角片假名），没解码器就没法裁决
  assert.equal(detect(bytes, false).encoding, ENC.SJIS);
  assert.equal(detect(bytes, false).confidence, 'medium');
  // 注入解码器后：EUC 解出「あい」，SJIS 解出半角片假名 → 判 EUC-JP
  const r = detect(bytes);
  assert.equal(r.encoding, ENC.EUCJP);
  assert.ok(r.candidates.find(c => c.encoding === ENC.EUCJP).score
    > r.candidates.find(c => c.encoding === ENC.SJIS).score);
});

test('检测：整句日语在两种编码下都能认出来（用反向表造样本，再用 TextDecoder 独立核对）', () => {
  const text = '☆0001☆藍☆「おはよう、早起きだな草薙は」\n　放課後、俺と有里咲は買い物を済ませてから帰ってきた。';
  const cases = [
    [ENC.SJIS, 'shift_jis'],
    [ENC.EUCJP, 'euc-jp'],
  ];
  for (const [enc, label] of cases) {
    const table = buildReverseTable(enc, (b) => decodeStrict(label, b));
    const { bytes, missing } = encodeWithTable(text, table);
    assert.deepEqual(missing, [], `${enc}: 这段文本应当都能编出来`);
    assert.equal(decodeStrict(label, bytes), text, `${enc}: 样本本身要能解回原文`);
    const r = detect(bytes);
    assert.equal(r.encoding, enc, `${enc}: 检测结果不符（${r.evidence.join('；')}）`);
    assert.ok(r.confidence !== 'low', `${enc}: 整句日语的置信度不该是 low`);
  }
});

test('检测：一段纯假名文本也分得清（SJIS 的假名不是半角）', () => {
  const hiragana = 'あいうえおかきくけこさしすせそたちつてとなにぬねの';
  const sjis = buildReverseTable(ENC.SJIS, (b) => decodeStrict('shift_jis', b));
  const euc = buildReverseTable(ENC.EUCJP, (b) => decodeStrict('euc-jp', b));
  for (const [enc, table] of [[ENC.SJIS, sjis], [ENC.EUCJP, euc]]) {
    const { bytes } = encodeWithTable(hiragana, table);
    assert.equal(detect(bytes).encoding, enc, `纯假名（${enc}）应认得出来`);
  }
});

test('检测：拿不准就说不知道，不硬猜', () => {
  const garbage = [0xFF, 0x00, 0x80, 0xFE, 0xA0, 0xFD, 0x80, 0xff]; // 两种日文编码里都是非法首字节
  const r = detect(garbage);
  assert.equal(r.encoding, ENC.UNKNOWN);
  assert.equal(r.confidence, 'low');
});

test('结构扫描：半角片假名与汉字都能数对', () => {
  assert.deepEqual(scanShiftJis([0x82, 0xA0, 0xB1]), { pairs: 1, violations: 0, halfWidth: 1 });
  assert.deepEqual(scanShiftJis([0x80]), { pairs: 0, violations: 1, halfWidth: 0 });
  assert.deepEqual(scanEucJp([0xA4, 0xA2, 0x8E, 0xB1]), { pairs: 1, violations: 0, halfWidth: 1 });
  assert.deepEqual(scanEucJp([0xA4]), { pairs: 0, violations: 1, halfWidth: 0 });
});

/* ---------------- 打分 ---------------- */

test('打分：正常日语 > 半角片假名汤 / 替换字符', () => {
  const jp = scoreJapanese('☆0001☆藍☆「おはよう」');
  const halfKana = scoreJapanese('ｱｲｳｴｵｶｷｸｹｺ');
  assert.equal(jp, 1, '整句正常日语应满分');
  assert.equal(halfKana, 0, '整句半角片假名应零分');
  assert.ok(jp > halfKana);
  // 真实场景是"同一串字节的两种解"：坏解要么是半角片假名汤，要么夹着替换字符。
  // 两者都拿 0 分时靠"另一种解得分更高"取胜，所以这里只钉住各自的方向。
  assert.ok(scoreJapanese('かきくけこ') > scoreJapanese('���かきくけこ'), '替换字符要拉低分数');
  assert.ok(scoreJapanese('かきくけこ') > scoreJapanese('ｶｷｸｹｺ'), '半角片假名要拉低分数');
  assert.equal(scoreJapanese(''), 0);
});

/* ---------------- 反向表 ---------------- */

test('反向表：候选序列的字节数是编码规范要求的那种', () => {
  const sjis = [...candidateSequences(ENC.SJIS)];
  assert.ok(sjis.every(s => s.length === 1 || s.length === 2), 'Shift-JIS 只有单字节与双字节');
  assert.ok(sjis.some(s => s.length === 1 && s[0] === 0xA1), '半角片假名在 SJIS 里是单字节');
  const euc = [...candidateSequences(ENC.EUCJP)];
  assert.ok(euc.every(s => s.length === 2 || s.length === 3), 'EUC-JP 是双字节或三字节');
  assert.ok(euc.some(s => s.length === 2 && s[0] === 0x8E), '半角片假名在 EUC 里是 0x8E + 1 字节');
  assert.ok(euc.some(s => s.length === 3 && s[0] === 0x8F), 'JIS X 0212 是 0x8F + 2 字节');
  // 顺序约束：标准双字节区必须排在补字面（0212）之前 —— 同名字符要优先用标准区编码
  const firstTriple = euc.findIndex(s => s.length === 3);
  const lastDouble = euc.map(s => s.length).lastIndexOf(2);
  assert.ok(lastDouble < firstTriple, '双字节（JIS X 0208）优先');
});

test('反向表：编码 → 解码 往返一致，且表大小符合 JIS X 0208 规模', () => {
  for (const [enc, label, min] of [[ENC.SJIS, 'shift_jis', 7000], [ENC.EUCJP, 'euc-jp', 7000]]) {
    const table = buildReverseTable(enc, (b) => decodeStrict(label, b));
    assert.ok(table.size > min, `${enc}: 表里应有几千个字符，实际 ${table.size}`);
    const text = '人名：藍、有里咲\n「……そうか」\n全角　空格\t制表符';
    const { bytes, missing } = encodeWithTable(text, table);
    assert.deepEqual(missing, []);
    assert.equal(decodeStrict(label, bytes), text);
  }
});

test('反向表：编不出来的字符必须报出来，不许拿问号顶替', () => {
  const table = buildReverseTable(ENC.SJIS, (b) => decodeStrict('shift_jis', b));
  // 简体字与 emoji 都不在 CP932 里 —— 中文译文回写 Shift-JIS 时这是常态，必须让调用方能拒绝写盘
  const { missing } = encodeWithTable('你说这🍣', table);
  assert.ok(missing.includes('🍣'), 'emoji 应报出来');
  assert.ok(missing.length >= 1);
  const ok = encodeWithTable('藍さん、おはよう', table);
  assert.deepEqual(ok.missing, []);
  assert.ok(ok.bytes.length > 0);
});

test('反向表：ASCII 直通（编号与标记不受影响）', () => {
  const table = buildReverseTable(ENC.SJIS, (b) => decodeStrict('shift_jis', b));
  const text = '☆NAME|11☆\r\n';
  const { bytes } = encodeWithTable(text, table);
  // ☆（U+2606）在 CP932 里有码位；ASCII 部分与行尾必须一模一样
  assert.deepEqual([...bytes].slice(-2), [0x0D, 0x0A], 'CRLF 原样');
  const arr = [...bytes];
  const at = arr.findIndex((_, i) => arr[i] === 0x4E && arr[i + 1] === 0x41 && arr[i + 2] === 0x4D && arr[i + 3] === 0x45);
  assert.ok(at > 0, 'NAME 应是原样的 ASCII 字节');
  assert.equal(decodeStrict('shift_jis', bytes), text);
});

/* ---------------- 与宿主的对接表 ---------------- */

test('解码：判不出编码时按 UTF-8 硬读，但必须标成降级', () => {
  const bytes = [0xFF, 0x00, 0x80, 0xFE, 0xA0, 0xFD, 0x80, 0xFF];
  const info = detect(bytes);
  assert.equal(info.encoding, ENC.UNKNOWN);
  const r = decodeBytes(bytes, info, decodeLenient);
  assert.equal(r.degraded, true);
  assert.match(r.reason, /未知/);
  assert.equal(typeof r.text, 'string');

  const ok = decodeBytes(new TextEncoder().encode('あ'), { encoding: ENC.UTF8 }, decodeLenient);
  assert.equal(ok.degraded, false);
  assert.equal(ok.text, 'あ');
});

test('映射：VS Code 的 files.encoding 取值', () => {
  assert.equal(vsCodeEncodingId(ENC.UTF8), 'utf8');
  assert.equal(vsCodeEncodingId(ENC.UTF8_BOM), 'utf8bom');
  assert.equal(vsCodeEncodingId(ENC.UTF16LE), 'utf16le');
  assert.equal(vsCodeEncodingId(ENC.UTF16BE), 'utf16be');
  assert.equal(vsCodeEncodingId(ENC.SJIS), 'shiftjis');
  assert.equal(vsCodeEncodingId(ENC.EUCJP), 'eucjp');
  assert.equal(vsCodeEncodingId(ENC.ISO2022JP), null, 'VS Code 的编码注册表里没有 ISO-2022-JP，不能瞎写');
  assert.equal(vsCodeEncodingId(ENC.UNKNOWN), null);
});

test('映射：交给 TextDecoder 的标签与展示名', () => {
  assert.equal(DECODER_LABEL[ENC.SJIS], 'shift_jis');
  assert.equal(DECODER_LABEL[ENC.EUCJP], 'euc-jp');
  assert.equal(DECODER_LABEL[ENC.UTF8_BOM], 'utf-8');
  assert.equal(encodingLabel(ENC.SJIS), 'Shift-JIS');
  assert.equal(encodingLabel(ENC.UTF8_BOM), 'UTF-8 (BOM)');
});

test('提醒判定：只有"按 UTF-8 读会乱码"的编码才需要提醒', () => {
  assert.equal(needsUtf8Attention(ENC.SJIS), true);
  assert.equal(needsUtf8Attention(ENC.EUCJP), true);
  assert.equal(needsUtf8Attention(ENC.UTF16LE), true);
  assert.equal(needsUtf8Attention(ENC.UTF8), false);
  assert.equal(needsUtf8Attention(ENC.UTF8_BOM), false);
  assert.equal(needsUtf8Attention(ENC.UNKNOWN), false);
});
