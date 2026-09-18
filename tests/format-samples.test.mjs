// format-samples.js 纯逻辑测试 — node:test + node:assert
// 覆盖: 标注校验 / 单组骨架 / 多样例归纳与冲突定位 / 覆盖区间
// 运行: node --test tests/format-samples.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SAMPLES, normalizeMarks, buildSkeleton, inferLayout, describeConflict,
  firstLiteralDiff, toSourcePattern, toTargetPattern, uncoveredRanges,
} from '../src/format-samples.js';

/** 便捷：在 text 里定位子串并标为某字段 */
function mark(text, sub, field, from = 0){
  const i = text.indexOf(sub, from);
  assert.ok(i >= 0, '样例里找不到子串：' + sub);
  return { start: i, end: i + sub.length, field };
}

/* ---------------- 标注校验 ---------------- */

test('normalizeMarks: 正常标注按位置排序返回', () => {
  const t = 'JP[1] おはよう';
  const r = normalizeMarks(t, [mark(t, 'おはよう', 'text'), mark(t, '1', 'id')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.marks.map(m => m.field), ['id', 'text'], '应按位置排序');
});

test('normalizeMarks: 缺少正文被拒绝', () => {
  const t = 'JP[1] おはよう';
  const r = normalizeMarks(t, [mark(t, '1', 'id')]);
  assert.equal(r.ok, false);
  assert.match(r.error, /必须标注一处「正文」/);
});

test('normalizeMarks: 同一字段标两次被拒绝', () => {
  const t = 'JP[1] おはよう';
  const r = normalizeMarks(t, [
    { start: 3, end: 4, field: 'id' },      // 「1」
    { start: 0, end: 2, field: 'id' },      // 「JP」也标成编号
    mark(t, 'おはよう', 'text'),
  ]);
  assert.equal(r.ok, false);
  assert.match(r.error, /只能标注一次/);
});

test('normalizeMarks: 重叠区间被拒绝并指出是哪两个字段', () => {
  const t = 'JP[1] おはよう';
  const r = normalizeMarks(t, [
    { start: 0, end: 5, field: 'id' },
    { start: 3, end: 9, field: 'text' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.error, /重叠/);
});

test('normalizeMarks: 越界与空区间被拒绝', () => {
  const t = 'abc';
  assert.equal(normalizeMarks(t, [{ start: 0, end: 99, field: 'text' }]).ok, false);
  assert.equal(normalizeMarks(t, [{ start: 2, end: 2, field: 'text' }]).ok, false);
  assert.equal(normalizeMarks(t, [{ start: -1, end: 2, field: 'text' }]).ok, false);
  assert.match(normalizeMarks(t, [{ start: 0.5, end: 2, field: 'text' }]).error, /整数/);
});

test('normalizeMarks: 非法字段名被拒绝', () => {
  const t = 'abc';
  assert.equal(normalizeMarks(t, [{ start: 0, end: 1, field: 'bad' }]).ok, false);
  assert.match(normalizeMarks(t, [{ start: 0, end: 1, field: 'bad' }]).error, /只能标注为/);
});

/* ---------------- 单组骨架 ---------------- */

test('buildSkeleton: 未标注部分成为固定文字', () => {
  const t = 'JP[1] おはよう';
  const r = buildSkeleton(t, [mark(t, '1', 'id'), mark(t, 'おはよう', 'text')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fragments, [
    { type: 'literal', value: 'JP[' },
    { type: 'field', field: 'id' },
    { type: 'literal', value: '] ' },
    { type: 'field', field: 'text' },
  ]);
});

test('buildSkeleton: 带角色名的对话', () => {
  const t = '☆0001☆アリス☆おはよう';
  const r = buildSkeleton(t, [
    mark(t, '0001', 'id'), mark(t, 'アリス', 'name'), mark(t, 'おはよう', 'text'),
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fragments, [
    { type: 'literal', value: '☆' },
    { type: 'field', field: 'id' },
    { type: 'literal', value: '☆' },
    { type: 'field', field: 'name' },
    { type: 'literal', value: '☆' },
    { type: 'field', field: 'text' },
  ]);
});

test('buildSkeleton: 旁白（无角色名）', () => {
  const t = '　きれいな夕焼けだ。';
  const r = buildSkeleton(t, [mark(t, 'きれいな夕焼けだ。', 'text')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fragments, [
    { type: 'literal', value: '　' },
    { type: 'field', field: 'text' },
  ]);
});

test('buildSkeleton: 空译文样例合法（正文标为末尾空白字符）', () => {
  // 'CN[1] ' —— 末尾有一个空格，它既是"空译文的占位"也是正文槽
  const t = 'CN[1] ';
  const r = buildSkeleton(t, [{ start: 3, end: 4, field: 'id' }, { start: 5, end: 6, field: 'text' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fragments, [
    { type: 'literal', value: 'CN[' },
    { type: 'field', field: 'id' },
    { type: 'literal', value: ']' },
    { type: 'field', field: 'text' },
  ]);
});

test('buildSkeleton: 多行正文（含换行）', () => {
  const t = '<jp 1>\n第一行\n第二行\n</jp>';
  const r = buildSkeleton(t, [mark(t, '1', 'id'), mark(t, '第一行\n第二行', 'text')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fragments, [
    { type: 'literal', value: '<jp ' },
    { type: 'field', field: 'id' },
    { type: 'literal', value: '>\n' },
    { type: 'field', field: 'text' },
    { type: 'literal', value: '\n</jp>' },
  ]);
});

test('buildSkeleton: CRLF 样例（标注落在 \\r\\n 之间不破坏结构）', () => {
  const t = 'JP[1] おはよう\r\n';
  const r = buildSkeleton(t, [mark(t, '1', 'id'), mark(t, 'おはよう', 'text')]);
  assert.equal(r.ok, true);
  assert.equal(r.fragments[r.fragments.length - 1].value, '\r\n', 'CRLF 作为固定文字保留');
});

test('buildSkeleton: 全角符号构成的固定文字', () => {
  const t = '原文：おはよう';
  const r = buildSkeleton(t, [mark(t, 'おはよう', 'text')]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fragments, [
    { type: 'literal', value: '原文：' },
    { type: 'field', field: 'text' },
  ]);
});

test('buildSkeleton: 以字段开头被拒绝（布局必须固定文字起头）', () => {
  const t = 'おはよう';
  const r = buildSkeleton(t, [mark(t, 'おはよう', 'text')]);
  assert.equal(r.ok, false);
  assert.match(r.error, /必须以未标注的固定文字开头/);
});

/* ---------------- 多组归纳 ---------------- */

test('inferLayout: 单个样例被明确拒绝', () => {
  const t = 'JP[1] おはよう';
  const r = inferLayout([{ text: t, marks: [mark(t, '1', 'id'), mark(t, 'おはよう', 'text')] }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /至少需要 2 组样例/);
  assert.equal(MIN_SAMPLES, 2);
});

test('inferLayout: 两组同布局样例归纳成功（内容不同但结构相同）', () => {
  const a = 'JP[1] おはよう';
  const b = 'JP[2] こんばんは';
  const r = inferLayout([
    { text: a, marks: [mark(a, '1', 'id'), mark(a, 'おはよう', 'text')] },
    { text: b, marks: [mark(b, '2', 'id'), mark(b, 'こんばんは', 'text')] },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.fragments, [
    { type: 'literal', value: 'JP[' },
    { type: 'field', field: 'id' },
    { type: 'literal', value: '] ' },
    { type: 'field', field: 'text' },
  ]);
});

test('inferLayout: 对话与旁白混在一起 → 定位到冲突（字段数量不同）', () => {
  const a = '☆0001☆アリス☆おはよう';
  const b = '　きれいな夕焼けだ。';
  const r = inferLayout([
    { text: a, marks: [mark(a, '0001', 'id'), mark(a, 'アリス', 'name'), mark(a, 'おはよう', 'text')] },
    { text: b, marks: [mark(b, 'きれいな夕焼けだ。', 'text')] },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].reason, 'shape');
  assert.match(r.error, /不是同一种布局/);
});

test('inferLayout: 漏标一段内容 → 报出"漏标的片段"，不静默合并', () => {
  // 第二组把末尾的「」也标进正文，于是它多出一段固定文字 '」'
  const a = 'JP[1] おはよう';
  const b = 'JP[2]「こんばんは」';
  const r = inferLayout([
    { text: a, marks: [mark(a, '1', 'id'), mark(a, 'おはよう', 'text')] },
    { text: b, marks: [mark(b, '2', 'id'), mark(b, 'こんばんは', 'text')] },
  ]);
  assert.equal(r.ok, false, '结构不一致必须失败，不能猜');
  assert.equal(r.conflicts[0].reason, 'shape');
  // 关键：错误要指向"漏标了什么"，而不是干巴巴说"多一段"
  assert.match(r.error, /未被标注|忘记标注/);
  assert.match(r.error, /第 2 组/, '要指明是哪一组');
});

test('inferLayout: 固定文字不同但不影响结构时，报"固定文字不一致"', () => {
  // 两组片段数相同、字段相同，仅中段固定文字不同（'] ' vs '] ='）
  const a = 'JP[1] あ';
  const b = 'JP[2] =い';
  const r = inferLayout([
    { text: a, marks: [mark(a, '1', 'id'), mark(a, 'あ', 'text')] },
    { text: b, marks: [mark(b, '2', 'id'), mark(b, 'い', 'text')] },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].reason, 'literal');
  assert.match(r.error, /固定文字不一致/);
});

test('inferLayout: 换行结构不一致被识别为结构冲突', () => {
  const a = 'JP[1] あ\n';
  const b = 'JP[2] い';
  const r = inferLayout([
    { text: a, marks: [mark(a, '1', 'id'), mark(a, 'あ', 'text')] },
    { text: b, marks: [mark(b, '2', 'id'), mark(b, 'い', 'text')] },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].reason, 'shape');
  assert.match(r.error, /未被标注|忘记标注|换行/);
});

test('inferLayout: 字段顺序标反 → 定位到具体字段', () => {
  const a = 'JP[1] おはよう';
  const b = 'JP[2] こんばんは';
  const r = inferLayout([
    { text: a, marks: [mark(a, '1', 'id'), mark(a, 'おはよう', 'text')] },
    // 第二组把「2」标成正文、「こんばんは」标成编号
    { text: b, marks: [mark(b, '2', 'text'), mark(b, 'こんばんは', 'id')] },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.error, /字段不一致/);
});

test('inferLayout: 三组样例全部同形才通过', () => {
  const mk = (n, w) => { const t = `JP[${n}] ${w}`; return { text: t, marks: [mark(t, String(n), 'id'), mark(t, w, 'text')] }; };
  assert.equal(inferLayout([mk(1, 'あ'), mk(2, 'い'), mk(3, 'う')]).ok, true);
  const bad = { text: 'JP[9] え', marks: [] };
  const t9 = 'JP[9] え';
  bad.marks = [mark(t9, '9', 'id'), mark(t9, 'え', 'text')];
  // 第三组结构不同（多一个固定片段）
  const t3 = 'JPX[3] う';
  const mixed = { text: t3, marks: [mark(t3, '3', 'id'), mark(t3, 'う', 'text')] };
  const r = inferLayout([mk(1, 'あ'), mk(2, 'い'), mixed]);
  assert.equal(r.ok, false, '任一组不同形即失败');
});

test('inferLayout: 空/非法输入安全', () => {
  assert.equal(inferLayout([]).ok, false);
  assert.equal(inferLayout(null).ok, false);
  assert.equal(inferLayout([null, null]).ok, false);
});

/* ---------------- 冲突说明 ---------------- */

test('describeConflict: 用"第几组样例/哪段固定文字"表述，不暴露内部结构', () => {
  const a = [{ type: 'literal', value: 'JP[' }, { type: 'field', field: 'id' }, { type: 'literal', value: '] ' }, { type: 'field', field: 'text' }];
  const b = [{ type: 'literal', value: 'JP[' }, { type: 'field', field: 'id' }, { type: 'literal', value: '] ' }];
  const msg = describeConflict(a, b, 0, 1);
  assert.match(msg, /第 1 组|第 2 组/);
  assert.match(msg, /未被标注|字段/);
  assert.doesNotMatch(msg, /\{|\}|type:|field:/, '不该出现内部数据结构字样');
});

test('firstLiteralDiff: 无差异返回空串', () => {
  const a = [{ type: 'literal', value: 'A' }, { type: 'field', field: 'text' }];
  assert.equal(firstLiteralDiff(a, a.map(f => ({ ...f }))), '');
});

/* ---------------- 组装 v2 pattern ---------------- */

test('toSourcePattern: 产出可被 validateFormatV2 接受的原文布局', () => {
  const frags = [{ type: 'literal', value: 'JP[' }, { type: 'field', field: 'id' }, { type: 'literal', value: '] ' }, { type: 'field', field: 'text' }];
  const p = toSourcePattern(frags, { id: 's1', kind: 'dialogue', target: 't1' });
  assert.equal(p.kind, 'dialogue');
  assert.equal(p.target, 't1');
  // 深拷贝：改返回值不该影响传入数组
  p.fragments[0].value = 'XX';
  assert.equal(frags[0].value, 'JP[');
});

test('toSourcePattern: 非法 kind 回退 dialogue', () => {
  assert.equal(toSourcePattern([], { kind: '独白' }).kind, 'dialogue');
  assert.equal(toSourcePattern([], { kind: 'narration' }).kind, 'narration');
});

test('toTargetPattern: 译文布局不带 kind', () => {
  const p = toTargetPattern([{ type: 'literal', value: 'CN: ' }, { type: 'field', field: 'text' }], 't1');
  assert.equal('kind' in p, false, 'kind 是原文布局的属性');
});

/* ---------------- 覆盖区间 ---------------- */

test('uncoveredRanges: 报出未被标注的区间（UI 用来提示"这些会成为固定文字"）', () => {
  const t = 'JP[1] おはよう';
  const r = uncoveredRanges(t, [mark(t, '1', 'id'), mark(t, 'おはよう', 'text')]);
  assert.deepEqual(r, [
    { start: 0, end: 3 },   // 'JP['
    { start: 4, end: 6 },   // '] '
  ]);
});

test('uncoveredRanges: 全标注时无未覆盖区间', () => {
  const t = 'AB';
  assert.deepEqual(uncoveredRanges(t, [{ start: 0, end: 1, field: 'id' }, { start: 1, end: 2, field: 'text' }]), []);
});

test('uncoveredRanges: 非法标注时退回按有效区间计算，不抛异常', () => {
  const t = 'abc';
  const r = uncoveredRanges(t, [{ start: 9, end: 99, field: 'text' }]);
  assert.deepEqual(r, [{ start: 0, end: 3 }]);
  assert.deepEqual(uncoveredRanges('', []), []);
  assert.deepEqual(uncoveredRanges(null, null), []);
});
