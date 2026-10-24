// encoding.js 纯逻辑测试 — node:test + node:assert
// 覆盖: 编码名归一化 / 显示名 / 可写性 / 导出选项 / 原编码沿用 / 风险提示。
// 运行: node --test tests/encoding.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENCODINGS, DEFAULT_ENCODING,
  normalizeEncoding, encodingInfo, encodingLabel,
  canWriteEncoding, writeEncodingOptions, suggestWriteEncoding,
  encodingWarning, looksChinese,
} from '../src/encoding.js';

test('normalizeEncoding: 别名归一到规范 id', () => {
  assert.equal(normalizeEncoding('utf-8'), 'utf-8');
  assert.equal(normalizeEncoding('UTF8'), 'utf-8');
  assert.equal(normalizeEncoding('utf_8'), 'utf-8');
  assert.equal(normalizeEncoding('UTF-8-SIG'), 'utf-8-bom');
  assert.equal(normalizeEncoding('sjis'), 'shift-jis');
  assert.equal(normalizeEncoding('SHIFT_JIS'), 'shift-jis');
  assert.equal(normalizeEncoding('euc_jp'), 'euc-jp');
  assert.equal(normalizeEncoding('utf16le'), 'utf-16le');
  assert.equal(normalizeEncoding('  utf-16be  '), 'utf-16be');
});

test('normalizeEncoding: 未知输入返回空串（不瞎猜）', () => {
  assert.equal(normalizeEncoding(''), '');
  assert.equal(normalizeEncoding(null), '');
  assert.equal(normalizeEncoding(undefined), '');
  assert.equal(normalizeEncoding('cp932'), '');
  assert.equal(normalizeEncoding('big5'), '');
});

test('encodingInfo / encodingLabel: 认得清单里的，未知原样显示', () => {
  assert.equal(encodingInfo('sjis').id, 'shift-jis');
  assert.equal(encodingInfo('nope'), null);
  assert.equal(encodingLabel('utf-8'), 'UTF-8（无 BOM）');
  // 未知编码要把真实值露出来，否则用户看到"未知"没法排查
  assert.equal(encodingLabel('cp932'), 'cp932');
  assert.equal(encodingLabel(''), '');
});

test('ENCODINGS: 简体中文可用性标注正确（SJIS/EUC-JP 表示不了中文）', () => {
  const byId = Object.fromEntries(ENCODINGS.map(e => [e.id, e]));
  assert.equal(byId['utf-8'].chinese, true);
  assert.equal(byId['utf-16le'].chinese, true);
  assert.equal(byId['shift-jis'].chinese, false);
  assert.equal(byId['euc-jp'].chinese, false);
  // 日文侧：全部都要能表示日文，否则这个工具没法用
  for (const e of ENCODINGS) assert.equal(e.japanese, true, e.id + ' 应支持日文');
});

test('canWriteEncoding: 浏览器端只能写 UTF-8，桌面端全部可写', () => {
  assert.equal(canWriteEncoding('utf-8', false), true);
  assert.equal(canWriteEncoding('shift-jis', false), false);
  assert.equal(canWriteEncoding('utf-16le', false), false);
  assert.equal(canWriteEncoding('shift-jis', true), true);
  assert.equal(canWriteEncoding('utf-16be', true), true);
  assert.equal(canWriteEncoding('cp932', true), false, '未知编码两端都不能写');
});

test('writeEncodingOptions: 不可用的项保留并给出原因（不是从列表里删掉）', () => {
  const browser = writeEncodingOptions(false);
  const sjis = browser.find(o => o.id === 'shift-jis');
  assert.equal(sjis.disabled, true);
  assert.match(sjis.disabledReason, /桌面版/);
  assert.equal(sjis.chineseSafe, false);
  // 桌面端无禁用项
  assert.ok(writeEncodingOptions(true).every(o => !o.disabled));
  // utf-8 在两端都可用
  assert.equal(browser.find(o => o.id === 'utf-8').disabled, false);
});

test('suggestWriteEncoding: 沿用原文件编码（这是修静默改编码的关键）', () => {
  assert.equal(suggestWriteEncoding('shift-jis'), 'shift-jis');
  assert.equal(suggestWriteEncoding('SJIS'), 'shift-jis');
  assert.equal(suggestWriteEncoding('utf-16le'), 'utf-16le');
});

test('suggestWriteEncoding: 无已知编码时回退 UTF-8', () => {
  assert.equal(suggestWriteEncoding(''), DEFAULT_ENCODING);
  assert.equal(suggestWriteEncoding(null), DEFAULT_ENCODING);
  assert.equal(suggestWriteEncoding('cp932'), DEFAULT_ENCODING);
});

test('encodingWarning: 中文 + SJIS 明确警告会拒绝写入', () => {
  const w = encodingWarning('shift-jis', true);
  assert.match(w, /无法表示简体中文/);
  assert.match(w, /拒绝/);
  // 无中文时不报这个错
  assert.equal(encodingWarning('shift-jis', false), '');
});

test('encodingWarning: BOM 提醒只在实际用到时出现', () => {
  assert.match(encodingWarning('utf-8-bom', false), /BOM/);
  // utf-8 无 BOM 正常，不该有提示
  assert.equal(encodingWarning('utf-8', true), '');
  assert.equal(encodingWarning('utf-16le', true), '');
  // 未知编码不产出误导性提示
  assert.equal(encodingWarning('cp932', true), '');
});

test('looksChinese: 识别简体专用字，纯日文为假', () => {
  assert.equal(looksChinese('这句话的翻译'), true);
  assert.equal(looksChinese('こんにちは、今日はいい天気ですね'), false);
  // 日文汉字（与中文同形）不该被判成中文
  assert.equal(looksChinese('今日天気'), false);
  assert.equal(looksChinese(''), false);
  assert.equal(looksChinese(null), false);
});

test('looksChinese: 只看样本前若干字符（性能约束，长文本不全量扫）', () => {
  const long = 'あ'.repeat(5000) + '这句话';
  assert.equal(looksChinese(long, 100), false, '超出样本范围的中文不应被扫到');
  assert.equal(looksChinese(long, 6000), true);
});
