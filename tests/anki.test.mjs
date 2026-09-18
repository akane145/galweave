// anki.js 纯逻辑测试 — node:test + node:assert
// 覆盖: 请求组装 / 响应解析（含"HTTP 200 也是失败"这个坑） / 卡片内容与转义 / 标签
// 运行: node --test tests/anki.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANKI_DEFAULT_URL, ANKI_DEFAULT_DECK, ANKI_DEFAULT_MODEL,
  buildRequest, versionRequest, deckNamesRequest, addNoteRequest, normalizeNote,
  parseResponse, describeError,
  escHtml, buildCardFields, buildNote, autoTags,
} from '../src/anki.js';

/* ---------------- 请求组装 ---------------- */

test('buildRequest: AnkiConnect 协议是 {action, version:6, params}', () => {
  const r = buildRequest('addNote', { note: {} });
  assert.equal(r.action, 'addNote');
  assert.equal(r.version, 6);
  assert.deepEqual(r.params, { note: {} });
});

test('versionRequest / deckNamesRequest: 探测用请求', () => {
  assert.equal(versionRequest().action, 'version');
  assert.equal(deckNamesRequest().action, 'deckNames');
});

test('addNoteRequest: 包在 params.note 里', () => {
  const r = addNoteRequest({ fields: { Front: 'A', Back: 'B' }, deckName: 'D' });
  assert.equal(r.action, 'addNote');
  assert.equal(r.params.note.fields.Front, 'A');
  assert.equal(r.params.note.deckName, 'D');
});

test('normalizeNote: 字段值统一转字符串，空键丢弃', () => {
  const n = normalizeNote({ fields: { Front: 'A', Back: null, '': 'x', '  ': 'y' } });
  assert.deepEqual(n.fields, { Front: 'A', Back: '' });
});

test('normalizeNote: 标签去空去重前的空白，全空则不带 tags 键', () => {
  assert.deepEqual(normalizeNote({ fields: {}, tags: [' a ', '', '  '] }).tags, ['a']);
  assert.equal('tags' in normalizeNote({ fields: {}, tags: [] }), false);
  assert.equal('tags' in normalizeNote({ fields: {} }), false);
});

test('normalizeNote: 非法输入安全（不抛异常）', () => {
  assert.deepEqual(normalizeNote(null).fields, {});
  assert.deepEqual(normalizeNote('字符串').fields, {});
  assert.deepEqual(normalizeNote(undefined).fields, {});
});

/* ---------------- 响应解析 ---------------- */

test('parseResponse: 正常响应取 result', () => {
  assert.deepEqual(parseResponse({ result: 6, error: null }), { ok: true, result: 6, error: null });
  assert.equal(parseResponse({ result: [1, 2] }).result.length, 2);
  // result 为假值（0 / null）但无 error 时仍算成功
  assert.equal(parseResponse({ result: 0, error: null }).ok, true);
});

test('parseResponse: ⚠️ 有 error 就是失败，即使 HTTP 200', () => {
  // AnkiConnect 出错也返回 200，只看 res.ok 会把失败当成功
  const r = parseResponse({ result: null, error: 'cannot create note' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'cannot create note');
});

test('parseResponse: 非法响应安全', () => {
  assert.equal(parseResponse(null).ok, false);
  assert.equal(parseResponse(undefined).ok, false);
  assert.equal(parseResponse('字符串').ok, false);
});

/* ---------------- 错误文案 ---------------- */

test('describeError: 连不上 → 提示检查 Anki 与插件', () => {
  for (const s of ['failed to connect', 'ECONNREFUSED', 'NetworkError when attempting to fetch resource.']){
    assert.match(describeError(s), /连不上 Anki/, s);
  }
});

test('describeError: 常见错误有专门文案', () => {
  assert.match(describeError('collection is not available'), /同步或关闭中/);
  assert.match(describeError('cannot create note because it is a duplicate'), /已存在/);
  assert.match(describeError('model was not found: X'), /找不到指定的笔记类型/);
});

test('describeError: 未知错误原样返回，空值返回空串', () => {
  assert.equal(describeError('某种新错误'), '某种新错误');
  assert.equal(describeError(null), '');
  assert.equal(describeError(''), '');
});

/* ---------------- 卡片内容 ---------------- */

test('escHtml: HTML 特殊字符被转义（Anki 字段是 HTML）', () => {
  assert.equal(escHtml('a<b>c'), 'a&lt;b&gt;c');
  assert.equal(escHtml('x&y'), 'x&amp;y');
  assert.equal(escHtml('"q"'), '&quot;q&quot;');
  assert.equal(escHtml(null), '');
});

test('buildCardFields: 正面是生词（+假名），背面是释义与语境', () => {
  const f = buildCardFields({
    word: '先輩', reading: 'せんぱい', meaning: '前辈、学长',
    sentence: '先輩、おはよう', translation: '前辈，早上好', speaker: 'アリス',
  });
  assert.match(f.front, /先輩/);
  assert.match(f.front, /せんぱい/);
  assert.doesNotMatch(f.front, /前辈，早上好/, '译文不能出现在正面（会泄题）');
  assert.doesNotMatch(f.front, /前辈、学长/, '释义也不能在正面');
  assert.match(f.back, /前辈、学长/);
  assert.match(f.back, /先輩、おはよう/);
  assert.match(f.back, /前辈，早上好/);
  assert.match(f.back, /アリス/);
});

test('buildCardFields: 假名与生词相同则不重复显示', () => {
  const f = buildCardFields({ word: 'テスト', reading: 'テスト' });
  assert.equal((f.front.match(/テスト/g) || []).length, 1);
});

test('buildCardFields: 内容里的 HTML 被转义（防止注入或被当标签解析）', () => {
  const f = buildCardFields({ word: '<script>', sentence: 'a & b', translation: '甲 <乙>' });
  assert.doesNotMatch(f.front, /<script>/, '不应出现未转义的标签');
  assert.match(f.front, /&lt;script&gt;/);
  assert.match(f.back, /a &amp; b/);
  assert.match(f.back, /甲 &lt;乙&gt;/);
});

test('buildCardFields: 只有生词时背面为空而不报错', () => {
  const f = buildCardFields({ word: '先輩' });
  assert.equal(f.front, '先輩');
  assert.equal(f.back, '');
});

test('buildCardFields: 空/非法输入安全', () => {
  assert.deepEqual(buildCardFields(null), { front: '', back: '' });
  assert.deepEqual(buildCardFields('字符串'), { front: '', back: '' });
});

/* ---------------- buildNote ---------------- */

test('buildNote: 用 Basic 模板的 Front/Back，带默认牌组与类型', () => {
  const n = buildNote({ word: '先輩', meaning: '前辈' });
  assert.equal(n.fields.Front, '先輩');
  assert.match(n.fields.Back, /前辈/);
  assert.equal(n.deckName, ANKI_DEFAULT_DECK);
  assert.equal(n.modelName, ANKI_DEFAULT_MODEL);
});

test('buildNote: 可覆盖牌组/类型并带标签', () => {
  const n = buildNote({ word: 'x' }, { deck: '我的牌组', model: '问答题', tags: ['galweave', 'ch01'] });
  assert.equal(n.deckName, '我的牌组');
  assert.equal(n.modelName, '问答题');
  assert.deepEqual(n.tags, ['galweave', 'ch01']);
});

test('buildNote: 无标签时不带 tags 键（Anki 对空数组也能接受，但少传更干净）', () => {
  assert.equal('tags' in buildNote({ word: 'x' }), false);
});

/* ---------------- 标签 ---------------- */

test('autoTags: 空格与非法字符转下划线，去重去空', () => {
  assert.deepEqual(autoTags('ch 01.ks', 'Galweave 项目'), ['ch_01_ks', 'Galweave_项目']);
  assert.deepEqual(autoTags('a', 'a', ''), ['a']);
  assert.deepEqual(autoTags('', null, undefined), []);
});

test('autoTags: 中日文与连字符保留（Anki 标签允许）', () => {
  assert.deepEqual(autoTags('第一章-起'), ['第一章-起']);
});

test('ANKI_DEFAULT_URL: 是 AnkiConnect 的默认本地端口', () => {
  assert.equal(ANKI_DEFAULT_URL, 'http://127.0.0.1:8331');
});
