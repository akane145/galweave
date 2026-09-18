// rules.test.mjs — 规则库与每文档规则选择

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILTIN_RULES, normalizeRule, findRule, validateRule, scoreRule, pickRule, fingerprint, sampleOf, SAMPLE_LINES,
} from '../src/rules.js';
import { DEFAULT_COMMENT_PREFIXES, DEFAULT_NAME_ID_PATTERNS } from '../../src/parsers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..');
const SAMPLE_DIR = path.resolve(EXT_DIR, '../test text');

/** 用磁盘上真实的规则文件，顺带验证它的格式 */
function loadRuleFile(rel) {
  const p = path.join(EXT_DIR, rel);
  return normalizeRule(JSON.parse(fs.readFileSync(p, 'utf8')), path.basename(rel, '.json'));
}
const CIRCLE = loadRuleFile('rules/circle-inline-speaker.json');
const DEFAULT_STAR = findRule(BUILTIN_RULES, 'default-star');
const BRACKET = findRule(BUILTIN_RULES, 'star-bracket-speaker');

/* ---------------- 用例文本 ---------------- */

const STAR = [
  '☆0001☆藍☆「おはよう」',
  '★0001★蓝★「早上好」',
  '',
  '☆0002☆☆雨が降る。',
  '',
].join('\n');

const CIRCLE_TEXT = [
  '○00000|000008|003○ [[照]] 「むにゃむにゃ…………」[np]',
  '●00000|000008|003● [[照]] 「唔喵唔喵…………」[np]',
  '',
  '○00001|00000E|003○ [[久遠]] 「……すごい」[np]',
  '●00001|00000E|003● [[久远]] 「……好厉害」[np]',
  '',
].join('\n');

const BRACKET_TEXT = [
  '☆0007☆【藍】「おはよう」',
  '★0007★【蓝】「早上好」',
  '',
].join('\n');

const PLAIN = 'hello world\nthis is plain text\nno markers here\n';

/* ---------------- normalizeRule ---------------- */

test('normalizeRule：裸配置补全成完整配置', () => {
  const r = normalizeRule({ open: '#', close: '@' }, 'my-rule');
  assert.equal(r.id, 'my-rule');
  assert.equal(r.conf.open, '#');
  assert.equal(r.conf.close, '@');
  assert.equal(r.conf.regex, '');
  assert.deepEqual(r.conf.commentPrefixes, DEFAULT_COMMENT_PREFIXES, '未提供的字段应填默认值');
  assert.deepEqual(r.conf.nameIdPatterns, DEFAULT_NAME_ID_PATTERNS);
  assert.notEqual(r.conf.commentPrefixes, DEFAULT_COMMENT_PREFIXES, '应是副本而非同一数组引用');
});

test('normalizeRule：完整规则对象原样保留 conf', () => {
  const r = normalizeRule({ id: 'x', label: 'X 规则', conf: { open: '○', close: '●', regex: '^a$' } }, 'ignored');
  assert.equal(r.id, 'x');
  assert.equal(r.label, 'X 规则');
  assert.equal(r.conf.regex, '^a$');
});

test('normalizeRule：不继承"当前生效配置"，始终补全（避免半套配置静默继承）', () => {
  const r = normalizeRule({}, 'empty');
  assert.deepEqual(r.conf.commentPrefixes, DEFAULT_COMMENT_PREFIXES);
  assert.deepEqual(r.conf.nameIdPatterns, DEFAULT_NAME_ID_PATTERNS);
  assert.equal(r.conf.open, '☆');
  assert.equal(r.conf.close, '★');
});

/* ---------------- scoreRule ---------------- */

test('scoreRule：标准规则在 ☆/★ 文本上解释力最强', () => {
  const s = scoreRule(STAR, DEFAULT_STAR);
  assert.equal(s.marked, 2, '两行原文都被吃掉了前缀');
  assert.equal(s.numbered, 2);
  assert.equal(s.speakers, 1, '只有第一行有内联说话人段');
});

test('scoreRule：标记不匹配的规则得分为 0（不是"能解析就算命中"）', () => {
  const s = scoreRule(CIRCLE_TEXT, DEFAULT_STAR);
  assert.equal(s.marked, 0, '☆/★ 规则吃不动 ○/● 行');
  assert.equal(s.speakers, 0);
});

test('scoreRule：○/● 规则在 ○/● 文本上命中，且取出说话人', () => {
  const s = scoreRule(CIRCLE_TEXT, CIRCLE);
  assert.equal(s.marked, 2);
  assert.equal(s.speakers, 2);
  assert.equal(s.numbered, 2);
});

test('scoreRule：命名捕获组规则没有位置捕获组，仍按"正文变短"计为命中', () => {
  // 这是关键：不能用"前缀非空"当判据 —— 命名组规则的 prefix 是空串
  const s = scoreRule(CIRCLE_TEXT, CIRCLE);
  assert.ok(s.marked > 0, '命名组规则必须能计为命中');
});

test('scoreRule：正文包裹说话人的文本上，括号规则靠说话人数胜出', () => {
  const plain = scoreRule(BRACKET_TEXT, DEFAULT_STAR);
  const bracket = scoreRule(BRACKET_TEXT, BRACKET);
  assert.equal(plain.marked, 1);
  assert.equal(plain.speakers, 0, '标准规则取不到正文里的说话人');
  assert.equal(bracket.marked, 1, '两者都能解释这一行');
  assert.equal(bracket.speakers, 1);
});

test('scoreRule：非法规则记 error 并返回 0 分，不参与解释力比较', () => {
  const bad = normalizeRule({ id: 'bad', conf: { regex: '([unclosed' } }, 'bad');
  const s = scoreRule(STAR, bad);
  assert.equal(s.marked, 0, '坏正则不能被当成"能解析"');
  assert.match(s.error, /正则无法编译/);
});

/* ---------------- validateRule ---------------- */

test('validateRule：坏正则被判为非法（src/parsers.js 会静默回退，必须显式拦住）', () => {
  const bad = normalizeRule({ id: 'bad', conf: { regex: '([unclosed' } }, 'bad');
  assert.match(validateRule(bad), /正则无法编译/);
  assert.equal(validateRule(DEFAULT_STAR), null, '内置规则应合法');
  assert.equal(validateRule(BRACKET), null);
  assert.equal(validateRule(CIRCLE), null);
});

test('validateRule：标记相同或为空、名字行正则坏掉都要拦住', () => {
  assert.match(validateRule(normalizeRule({ conf: { open: '☆', close: '☆' } }, 'x')), /不能相同/);
  assert.match(validateRule(normalizeRule({ conf: { open: '', close: '★' } }, 'x')), /不能为空/);
  assert.match(validateRule(normalizeRule({ conf: { nameIdPatterns: ['[bad'] } }, 'x')), /名字行正则/);
  assert.match(validateRule({}), /缺少 conf/);
});

/* ---------------- pickRule ---------------- */

const ALL_RULES = [DEFAULT_STAR, BRACKET, CIRCLE];

test('pickRule：☆/★ 文本选中标准规则', () => {
  const picked = pickRule(STAR, ALL_RULES);
  assert.equal(picked.rule.id, 'default-star');
  assert.ok(picked.score.marked > 0);
});

test('pickRule：○/● 文本选中 ○/● 规则', () => {
  const picked = pickRule(CIRCLE_TEXT, ALL_RULES);
  assert.equal(picked.rule.id, 'circle-inline-speaker');
});

test('pickRule：正文包裹说话人的文本选中括号规则', () => {
  const picked = pickRule(BRACKET_TEXT, ALL_RULES);
  assert.equal(picked.rule.id, 'star-bracket-speaker');
});

test('pickRule：纯文本没有任何规则命中时返回 null（不误伤普通文件）', () => {
  assert.equal(pickRule(PLAIN, ALL_RULES), null);
});

test('pickRule：空文本返回 null', () => {
  assert.equal(pickRule('', ALL_RULES), null);
});

test('pickRule：规则库为空返回 null', () => {
  assert.equal(pickRule(STAR, []), null);
});

test('pickRule：评分完全持平时保留先出现的规则（内置库把标准规则放最前）', () => {
  // 两条配置完全相同的规则 —— 评分必然相等，先到者胜
  const a = normalizeRule({ id: 'first', conf: DEFAULT_STAR.conf }, 'first');
  const b = normalizeRule({ id: 'second', conf: DEFAULT_STAR.conf }, 'second');
  const picked = pickRule(STAR, [a, b]);
  assert.equal(picked.rule.id, 'first');
});

test('pickRule：非法规则被跳过，不会因为排在前就胜出', () => {
  const bad = normalizeRule({ id: 'bad', conf: { regex: '([unclosed' } }, 'bad');
  const picked = pickRule(STAR, [bad, DEFAULT_STAR]);
  assert.equal(picked.rule.id, 'default-star');
});

test('pickRule：只有非法规则时返回 null', () => {
  const bad = normalizeRule({ id: 'bad', conf: { regex: '([unclosed' } }, 'bad');
  assert.equal(pickRule(STAR, [bad]), null);
});

/* ---------------- 真实样本：自动选择必须选对 ---------------- */

test('真实样本：自动选择能区分 ☆/★ 与 ○/● 两种文件', (t) => {
  if (!fs.existsSync(SAMPLE_DIR)) { t.skip(`样本目录不存在：${SAMPLE_DIR}`); return; }
  const starFiles = ['新建 文本文档 (2).txt', '新建 文本文档 (3).txt', '新建 文本文档 (10).txt'];
  const circleFiles = ['新建 文本文档 (13).txt'];

  for (const f of starFiles) {
    const p = path.join(SAMPLE_DIR, f);
    if (!fs.existsSync(p)) continue;
    const picked = pickRule(fs.readFileSync(p, 'utf8'), ALL_RULES);
    assert.ok(picked, `${f}: 应选中某条规则`);
    assert.equal(picked.rule.id, 'default-star', `${f}: 应选中标准 ☆/★ 规则`);
  }
  for (const f of circleFiles) {
    const p = path.join(SAMPLE_DIR, f);
    if (!fs.existsSync(p)) continue;
    const picked = pickRule(fs.readFileSync(p, 'utf8'), ALL_RULES);
    assert.ok(picked, `${f}: 应选中某条规则`);
    assert.equal(picked.rule.id, 'circle-inline-speaker', `${f}: 应选中 ○/● 规则`);
  }
});

test('真实样本：○/● 文件被标准规则解析时命中数为 0（说明自动选择是必要的）', (t) => {
  const p = path.join(SAMPLE_DIR, '新建 文本文档 (13).txt');
  if (!fs.existsSync(p)) { t.skip(`样本不存在：${p}`); return; }
  const text = fs.readFileSync(p, 'utf8');
  assert.equal(scoreRule(text, DEFAULT_STAR).marked, 0);
  assert.equal(scoreRule(text, CIRCLE).marked, scoreRule(text, CIRCLE).total);
});

/* ---------------- fingerprint ---------------- */

test('fingerprint：同一文本稳定，行数变化后改变', () => {
  const a = fingerprint(STAR, ALL_RULES);
  assert.equal(a, fingerprint(STAR, ALL_RULES), '同输入应稳定');
  assert.notEqual(a, fingerprint(STAR + '☆0003☆A☆「あ」\n', ALL_RULES), '行数变化应改变指纹');
});

test('fingerprint：标记体系变化能被察觉', () => {
  const star = fingerprint(STAR, ALL_RULES);
  const circle = fingerprint(CIRCLE_TEXT, ALL_RULES);
  assert.notEqual(star, circle);
});

/* ---------------- sampleOf ---------------- */

test('sampleOf：只取开头若干行', () => {
  const text = Array.from({ length: SAMPLE_LINES + 50 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(sampleOf(text).split('\n').length, SAMPLE_LINES);
  assert.equal(sampleOf('a\nb').split('\n').length, 2, '不足样本长度时整段返回');
});
