// qa.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/qa.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_TERM_LEN, MAX_TERM_HITS_PER_ROW, QA_KINDS,
  normalizeDigits, termEntries, extractTokens,
  termMisses, nameConflicts, tokenMisses, punctMisses, analyzeQA, analyzeRowQA, controlMisses,
} from '../src/qa.js';

/** 造一条普通（非 NAME）段落；brackets=false 时 transValue === translation */
const P = (content, translation, extra = {}) => ({
  isName: false, brackets: false, content, translation, ...extra,
});

/* ---------------- termEntries ---------------- */

test('termEntries: names 与 terms 合并，长词条优先', () => {
  const ents = termEntries({
    names: { 'アリス': '爱丽丝' },
    terms: { '東京': '东京', '東京大学': '东京大学' },
  });
  assert.equal(ents.length, 3);
  assert.equal(ents[0].src, '東京大学');   // 最长的排最前
  assert.equal(ents[0].group, 'terms');
  assert.equal(ents[1].src, 'アリス');      // 3 字
  assert.equal(ents[2].src, '東京');        // 2 字
});

test('termEntries: 过滤空条目 / 原文=译文 / 单字词条（噪音源）', () => {
  const ents = termEntries({
    names: { 'アリス': '爱丽丝' },
    terms: {
      '私': '我',            // 单字 → 过滤
      '東京': '東京',        // 未翻译映射 → 过滤
      '': '空源',            // 空源 → 过滤
      '空译': '   ',         // 空译 → 过滤
      '先輩': '前辈',
    },
  });
  assert.deepEqual(ents.map(e => e.src), ['アリス', '先輩']);   // 3 字 → 2 字
});

test('termEntries: minLen 可调；非对象/缺分组安全', () => {
  assert.equal(termEntries(null).length, 0);
  assert.equal(termEntries({}).length, 0);
  assert.equal(termEntries({ terms: { '私': '我' } }, 1).length, 1);
  assert.equal(MIN_TERM_LEN, 2);
});

/* ---------------- termMisses ---------------- */

test('termMisses: 源句命中术语但译文未用约定译名 → 报；用了 → 不报', () => {
  const ents = termEntries({ terms: { '先輩': '前辈' } });
  const miss = termMisses([P('先輩、おはよう', '早上好')], ents);
  assert.equal(miss.length, 1);
  assert.equal(miss[0].kind, 'term');
  assert.equal(miss[0].i, 0);
  assert.equal(miss[0].term, '先輩');
  assert.equal(miss[0].expect, '前辈');

  assert.equal(termMisses([P('先輩、おはよう', '前辈，早上好')], ents).length, 0);
});

test('termMisses: 空译文 / 照抄原文 / NAME 行一律跳过（归 proof.js 报，不重复）', () => {
  const ents = termEntries({ terms: { '先輩': '前辈' } });
  assert.equal(termMisses([P('先輩', '')], ents).length, 0);          // 空译文
  assert.equal(termMisses([P('先輩', '先輩')], ents).length, 0);      // 照抄原文
  assert.equal(termMisses([P('先輩', '前辈', { isName: true })], ents).length, 0);
  assert.equal(termMisses([P('', '随便')], ents).length, 0);          // 无源文
});

test('termMisses: 命中数封顶，避免一行刷屏', () => {
  const ents = termEntries({ terms: {
    '先輩': '前辈', '部室': '社团教室', '放課後': '放学后', '図書室': '图书室',
  } });
  const src = '先輩と部室で放課後に図書室へ';
  const miss = termMisses([P(src, '去了图书馆')], ents);
  assert.equal(miss.length, MAX_TERM_HITS_PER_ROW);
  assert.equal(MAX_TERM_HITS_PER_ROW, 3);
});

test('termMisses: 无术语表 → 直接返回空，不做无谓扫描', () => {
  assert.deepEqual(termMisses([P('先輩', '早上好')], []), []);
  assert.deepEqual(termMisses([P('先輩', '早上好')], null), []);
});

/* ---------------- nameConflicts ---------------- */

test('nameConflicts: 同一源名多个译名 → 只在首次出现行报一条', () => {
  const paras = [
    P('', '你好', { name: 'アリス', nameTr: '爱丽丝' }),
    P('', '嗯', { name: 'アリス', nameTr: '爱丽丝' }),
    P('', '早', { name: 'アリス', nameTr: '艾丽丝' }),
  ];
  const c = nameConflicts(paras);
  assert.equal(c.length, 1);
  assert.equal(c[0].i, 0);                                  // 首次出现行
  assert.equal(c[0].kind, 'name-conflict');
  assert.equal(c[0].name, 'アリス');
  assert.deepEqual(c[0].values, ['爱丽丝', '艾丽丝']);        // 按出现次数降序
  assert.deepEqual(c[0].counts, [2, 1]);
});

test('nameConflicts: 译名一致 / 未译（nameTr 为空或等于原文名）不报', () => {
  assert.equal(nameConflicts([
    P('', '你好', { name: 'アリス', nameTr: '爱丽丝' }),
    P('', '早', { name: 'アリス', nameTr: '爱丽丝' }),
  ]).length, 0);

  assert.equal(nameConflicts([
    P('', '你好', { name: 'アリス', nameTr: 'アリス' }),   // 未改过名
    P('', '早', { name: 'アリス', nameTr: '' }),           // 空译名
  ]).length, 0);
});

test('nameConflicts: 多个名字各自成条，按行号升序', () => {
  const c = nameConflicts([
    P('', 'x', { name: 'アリス', nameTr: '爱丽丝' }),
    P('', 'y', { name: 'ボブ', nameTr: '鲍勃' }),
    P('', 'z', { name: 'ボブ', nameTr: '波布' }),
    P('', 'w', { name: 'アリス', nameTr: '艾丽丝' }),
  ]);
  assert.deepEqual(c.map(x => x.name), ['アリス', 'ボブ']);
  assert.deepEqual(c.map(x => x.i), [0, 1]);
});

/* ---------------- 占位符 ---------------- */

test('normalizeDigits: 全角数字转半角 + 去千分位逗号', () => {
  assert.equal(normalizeDigits('１２３'), '123');
  assert.equal(normalizeDigits('1,234'), '1234');
  assert.equal(normalizeDigits('１，２３４'), '1234');
  assert.equal(normalizeDigits(null), '');
});

test('extractTokens: 数字串 + 【…】内容；超长括号不当占位符', () => {
  const t = extractTokens('第3話「【名前】」と12時、これは【' + 'あ'.repeat(30) + '】');
  assert.deepEqual(t.map(x => x.value), ['3', '12', '名前']);
  assert.deepEqual(t.map(x => x.type), ['num', 'num', 'bracket']);
});

test('tokenMisses: 数字/占位符在译文缺失 → 报；跨全半角视为保留 → 不报', () => {
  assert.deepEqual(tokenMisses(P('第3話', '这一话')), [{ type: 'num', value: '3' }]);
  assert.deepEqual(tokenMisses(P('第3話', '第3话')), []);
  assert.deepEqual(tokenMisses(P('第３話', '第3话')), []);                 // 全角源 / 半角译
  assert.deepEqual(tokenMisses(P('【名前】は？', '名字是？')), [{ type: 'bracket', value: '名前' }]);
  assert.deepEqual(tokenMisses(P('【名前】は？', '名前呢？')), []);
});

test('tokenMisses: 空译文 / 照抄原文跳过', () => {
  assert.deepEqual(tokenMisses(P('第3話', '')), []);
  assert.deepEqual(tokenMisses(P('第3話', '第3話')), []);
});

/* ---------------- 标点 ---------------- */

test('punctMisses: 半角标点紧贴中日文 → 报全角建议', () => {
  const out = punctMisses(P('これは何?', '这是什么?'));
  assert.equal(out.length, 1);
  assert.equal(out[0].ch, '?');
  assert.equal(out[0].suggest, '？');

  const out2 = punctMisses(P('はい,そうです', '对,没错'));
  assert.equal(out2[0].ch, ',');
  assert.equal(out2[0].suggest, '，');
});

test('punctMisses: 拉丁语境的半角标点不误报', () => {
  assert.deepEqual(punctMisses(P('バージョン3.0', 'Sakura 3.0')), []);
  assert.deepEqual(punctMisses(P('CV: 花澤香菜', 'CV: 花泽香菜')), []);   // 冒号后紧跟空格
});

test('punctMisses: 「」不配对单独报一条', () => {
  const out = punctMisses(P('「おはよう', '「早上好'));
  assert.equal(out.length, 1);
  assert.equal(out[0].unbalanced, true);
  assert.equal(out[0].ch, '「');
});

test('punctMisses: 半角标点封顶，不淹没清单', () => {
  const out = punctMisses(P('a,b,c,d,e', '甲,乙,丙,丁,戊'));
  assert.equal(out.length, 3);
});

/* ---------------- 汇总 ---------------- */

test('analyzeQA: 四类结果齐全，total = 各类之和', () => {
  const paras = [
    P('先輩、第3話だよ', '前辈，第3话哦'),        // 全对 → 不报
    P('先輩、第3話だよ', '第3话'),                // 术语未用
    P('これは?', '这是什么?'),                    // 半角标点
    P('', 'x', { name: 'アリス', nameTr: '爱丽丝' }),
    P('', 'y', { name: 'アリス', nameTr: '艾丽丝' }),  // 译名冲突
  ];
  const r = analyzeQA(paras, { terms: { '先輩': '前辈' }, names: {} });

  assert.equal(r.term.length, 1);
  assert.equal(r.term[0].i, 1);
  assert.equal(r['name-conflict'].length, 1);
  assert.equal(r['name-conflict'][0].i, 3);
  assert.equal(r.punct.length, 1);
  assert.equal(r.punct[0].i, 2);
  assert.equal(r.total, r.term.length + r['name-conflict'].length + r.token.length + r.punct.length);
});

test('analyzeQA: 空输入 / 无术语表安全', () => {
  assert.equal(analyzeQA([], null).total, 0);
  assert.equal(analyzeQA(null, null).total, 0);
  const r = analyzeQA([P('先輩', '早上好')], null);
  assert.equal(r.total, 0);   // 无术语表 → 不产生 term 类噪音
});

test('QA_KINDS: 与 analyzeQA 返回的类别键一一对应', () => {
  const r = analyzeQA([], null);
  for (const k of QA_KINDS) assert.ok(Array.isArray(r[k]), `缺少类别 ${k}`);
  assert.deepEqual(QA_KINDS, ['term', 'name-conflict', 'token', 'punct']);
});

/* ---------------- analyzeRowQA: 行级实时门禁的单行入口 ---------------- */

const ENTRIES = termEntries({ names: { 'アリス': '爱丽丝' }, terms: { '先輩': '前辈' } });

test('analyzeRowQA: 与批量 analyzeQA 判定一致（同一套阈值，不另设标准）', () => {
  const p = P('先輩、おはよう', '早上好');   // 命中术语却没用译名
  const row = analyzeRowQA(p, ENTRIES);
  const batch = analyzeQA([p], { names: { 'アリス': '爱丽丝' }, terms: { '先輩': '前辈' } });
  assert.equal(row.total, batch.total, '单行入口不得比批量多报或少报');
  assert.deepEqual(row.issues.map(x => x.kind).sort(), batch.term.concat(batch.token, batch.punct).map(x => x.kind).sort());
  assert.equal(row.term.term, '先輩');
  assert.equal(row.term.expect, '前辈');
});

test('analyzeRowQA: 译文已用约定译名则无问题', () => {
  const r = analyzeRowQA(P('先輩、おはよう', '前辈，早上好'), ENTRIES);
  assert.equal(r.total, 0);
  assert.equal(r.term, null);
});

test('analyzeRowQA: 空译文/照抄原文交给 proof,不由本项重复报（避免双份噪音）', () => {
  assert.equal(analyzeRowQA(P('先輩', ''), ENTRIES).total, 0);
  assert.equal(analyzeRowQA(P('先輩', '先輩'), ENTRIES).total, 0);
});

test('analyzeRowQA: NAME 行不参与（译名走另一条链路）', () => {
  const r = analyzeRowQA({ isName: true, brackets: false, content: 'アリス', translation: '' }, ENTRIES);
  assert.equal(r.total, 0);
});

test('analyzeRowQA: 无术语表 / 非法输入安全', () => {
  assert.equal(analyzeRowQA(P('先輩', '早上好'), null).total, 0);
  assert.equal(analyzeRowQA(P('先輩', '早上好'), undefined).total, 0);
  assert.equal(analyzeRowQA(null, ENTRIES).total, 0);
});

test('analyzeRowQA: 术语条目按上限截断（沿用 MAX_TERM_HITS_PER_ROW）', () => {
  const gloss = { names: {}, terms: { 'あ': 'A', 'い': 'B', 'う': 'C', 'え': 'D', 'お': 'E' } };
  const ents = termEntries(gloss, 1);          // 放宽最短长度以便命中
  const p = P('あいうえお', '无关译文');
  const r = analyzeRowQA(p, ents);
  assert.equal(r.issues.filter(x => x.kind === 'term').length, MAX_TERM_HITS_PER_ROW);
});

test('analyzeRowQA: 占位符与标点也纳入单行判定', () => {
  const r = analyzeRowQA(P('第3話', '第话'), ENTRIES);   // 数字 3 丢失
  assert.ok(r.issues.some(x => x.kind === 'token' && x.value === '3'));
  const r2 = analyzeRowQA(P('そう', '这样,对吧'), ENTRIES);  // 半角逗号紧贴中文
  assert.ok(r2.issues.some(x => x.kind === 'punct' && x.ch === ','));
});

test('analyzeRowQA: term 字段取第一条术语问题,供胶囊一键填入', () => {
  const gloss = { names: {}, terms: { '先輩': '前辈', 'アリス': '爱丽丝' } };
  const ents = termEntries(gloss);
  const r = analyzeRowQA(P('アリスと先輩', '早上好'), ents);
  assert.ok(r.term, '有术语问题时必须给出可一键填入的条目');
  assert.ok(['前辈', '爱丽丝'].includes(r.term.expect));
  assert.equal(r.term.kind, 'term');
});

/* ---------------- controlMisses: 手改译文的控制符核对 ---------------- */

test('controlMisses: 原文有控制符而译文丢了 → 报（含缺几个）', () => {
  const p = P('こんにちは[r]そうだ[r]', '你好，是这样');
  const miss = controlMisses(p);
  assert.equal(miss.length, 1);
  assert.equal(miss[0].ch, '[r]');
  assert.equal(miss[0].role, 'line-break');
  assert.equal(miss[0].count, 2);
  assert.equal(miss[0].fullwidth, false);
});

test('controlMisses: 译文保留了全部控制符 → 不报', () => {
  assert.deepEqual(controlMisses(P('そうだ%p250,0;', '是这样%p250,0;')), []);
  assert.deepEqual(controlMisses(P('あ[r]い', '啊[r]咦')), []);
});

test('controlMisses: 原文没有控制符 → 不参与（无从漏起）', () => {
  assert.deepEqual(controlMisses(P('こんにちは', '你好')), []);
});

test('controlMisses: 只报"少"，多出来的不报（译者可能有意加断行）', () => {
  const p = P('こんにちは', '你好[r]朋友');
  assert.deepEqual(controlMisses(p), [], '多出来的控制符不报，视为有意为之');
});

test('controlMisses: 全角误输单独标记（敲成 ［ｒ］ 而非真丢失）', () => {
  const p = P('そうだ[r]', '是这样［ｒ］');
  const miss = controlMisses(p);
  assert.equal(miss.length, 1);
  assert.equal(miss[0].fullwidth, true, '折半角后够了 → 判定为全角误输');
});

test('controlMisses: 大小写不敏感（[R] 与 [r] 同一记号）', () => {
  assert.deepEqual(controlMisses(P('あ[r]い', '啊[R]咦')), []);
});

test('controlMisses: 语序变化不算问题（只比集合，不要求顺序）', () => {
  const p = P('あ[r]い%p100,0;', '咦[r]啊%p100,0;');
  assert.deepEqual(controlMisses(p), [], '中文语序本就该重排，顺序不同不是错');
});

test('controlMisses: 空译文/照抄原文跳过（归 proof 管）', () => {
  assert.deepEqual(controlMisses(P('あ[r]い', '')), []);
  assert.deepEqual(controlMisses(P('あ[r]い', 'あ[r]い')), []);
});

test('analyzeRowQA: 控制符检查**默认关闭**（断行标签本就要重排，默认报是噪音）', () => {
  // 不传 opts → 不该报 control
  const off = analyzeRowQA(P('あ[r]い', '啊咦'), null);
  assert.equal(off.issues.filter(x => x.kind === 'control').length, 0,
    '默认必须不报控制符，否则每行的断行标签都会刷提示');
  // 显式传 false 也一样
  assert.equal(analyzeRowQA(P('あ[r]い', '啊咦'), null, { checkControls: false })
    .issues.filter(x => x.kind === 'control').length, 0);
});

test('analyzeRowQA: 开启后控制符丢失仍会被报（kind 为 control）', () => {
  const r = analyzeRowQA(P('あ[r]い', '啊咦'), null, { checkControls: true });
  const ctl = r.issues.filter(x => x.kind === 'control');
  assert.equal(ctl.length, 1);
  assert.equal(ctl[0].ch, '[r]');
});

test('analyzeRowQA: 控制符保留时不报（无论开关）', () => {
  for (const opts of [undefined, { checkControls: true }]){
    const r = analyzeRowQA(P('あ[r]い', '啊[r]咦'), null, opts);
    assert.equal(r.issues.filter(x => x.kind === 'control').length, 0);
  }
});

test('analyzeRowQA: 术语表为空时，非术语类检查仍然工作（避头尾/标点/占位符）', () => {
  // 曾以 `entries.length` 作总开关，导致没有术语表时这些检查全部不跑 ——
  // 但它们与术语表无关，不该被术语表的有无连带影响。
  assert.ok(analyzeRowQA(P('そう', '这样。\n、然后'), null).issues.some(x => x.kind === 'kinjiru'),
    '避头尾应照常检出');
  assert.ok(analyzeRowQA(P('そう', '这样,对吧'), null).issues.some(x => x.kind === 'punct'),
    '标点检查应照常检出');
  assert.ok(analyzeRowQA(P('第3話', '第话'), null).issues.some(x => x.kind === 'token'),
    '占位符检查应照常检出');
});
