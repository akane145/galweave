// deinflect.js 纯逻辑测试 — node:test + node:assert
// 覆盖: 各类活用还原 / 候选排序与上限 / 片假名折叠 / 不还原的输入
// 运行: node --test tests/deinflect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deinflect, describePath, katakanaToHiragana,
  DEINFLECT_RULES, MAX_CANDIDATES,
} from '../src/deinflect.js';

/** 候选里是否包含某个原形 */
const has = (list, w) => list.some(c => c.word === w);
/** 取候选词数组（便于断言顺序） */
const words = (list) => list.map(c => c.word);
/** 最优先的候选词 */
const top = (list) => (list[0] ? list[0].word : null);

/* ---------------- 基本动词活用 ---------------- */

test('五段动词：ます形 / 否定 / て形 / た形', () => {
  assert.ok(has(deinflect('書きます'), '書く'), '書きます → 書く');
  assert.ok(has(deinflect('書かない'), '書く'), '書かない → 書く');
  assert.ok(has(deinflect('書いて'), '書く'), '書いて → 書く（イ音便）');
  assert.ok(has(deinflect('書いた'), '書く'), '書いた → 書く');
  assert.ok(has(deinflect('泳いで'), '泳ぐ'), '泳いで → 泳ぐ');
  assert.ok(has(deinflect('話して'), '話す'), '話して → 話す');
  assert.ok(has(deinflect('待って'), '待つ'), '待って → 待つ（促音便）');
  assert.ok(has(deinflect('買った'), '買う'), '買った → 買う');
  assert.ok(has(deinflect('死んだ'), '死ぬ'), '死んだ → 死ぬ（撥音便）');
  assert.ok(has(deinflect('遊んだ'), '遊ぶ'), '遊んだ → 遊ぶ');
  assert.ok(has(deinflect('読んだ'), '読む'), '読んだ → 読む');
  assert.ok(has(deinflect('取った'), '取る'), '取った → 取る');
});

test('一段动词：ます / ない / て / た / 受身 / 使役', () => {
  assert.ok(has(deinflect('食べます'), '食べる'));
  assert.ok(has(deinflect('食べない'), '食べる'));
  assert.ok(has(deinflect('食べて'), '食べる'));
  assert.ok(has(deinflect('食べた'), '食べる'));
  assert.ok(has(deinflect('食べられる'), '食べる'), '受身/可能同形');
  assert.ok(has(deinflect('食べさせる'), '食べる'), '使役');
  assert.ok(has(deinflect('見れば'), '見る'), '仮定形');
  assert.ok(has(deinflect('見ろ'), '見る'), '命令形');
});

test('する / 来る：不规则动词优先于规则表', () => {
  // する 必须排在「します→す」之前，否则「勉強します」会先给出「勉強す」
  assert.equal(top(deinflect('勉強します')), '勉強する');
  assert.ok(has(deinflect('勉強した'), '勉強する'));
  assert.ok(has(deinflect('勉強しない'), '勉強する'));
  assert.ok(has(deinflect('勉強して'), '勉強する'));

  assert.ok(has(deinflect('来ます'), '来る'));
  assert.ok(has(deinflect('来た'), '来る'));
  assert.ok(has(deinflect('来ない'), '来る'));
  // 假名写法也要覆盖（剧本里两种写法都常见）
  assert.ok(has(deinflect('きます'), 'くる'));
  assert.ok(has(deinflect('きた'), 'くる'));
});

/* ---------------- 补助动词 ---------------- */

test('补助动词：ている / てる / ておく / てしまう 等先剥离再还原', () => {
  assert.ok(has(deinflect('読んでいる'), '読む'), '読んでいる → 読む（两步）');
  assert.ok(has(deinflect('食べている'), '食べる'));
  assert.ok(has(deinflect('食べてる'), '食べる'), '口语缩约');
  assert.ok(has(deinflect('食べてた'), '食べる'));
  assert.ok(has(deinflect('読んでいた'), '読む'));
  assert.ok(has(deinflect('書いておく'), '書く'));
  assert.ok(has(deinflect('食べてしまった'), '食べる'));
  assert.ok(has(deinflect('読んでください'), '読む'));
});

test('补助动词：能给出多步路径（供 UI 显示还原过程）', () => {
  const list = deinflect('読んでいる');
  const hit = list.find(c => c.word === '読む');
  assert.ok(hit, '应能还原到読む');
  assert.equal(hit.steps, 2, '読んでいる → 読んで → 読む 是两步');
  assert.deepEqual(hit.path, ['読んでいる', '読んで', '読む']);
  assert.equal(describePath(hit), '読んでいる → 読んで → 読む');
});

/* ---------------- 形容词 ---------------- */

test('い形容词：く / かった / くない / ければ', () => {
  assert.ok(has(deinflect('高かった'), '高い'));
  assert.ok(has(deinflect('高くない'), '高い'));
  assert.ok(has(deinflect('高くて'), '高い'));
  assert.ok(has(deinflect('高ければ'), '高い'));
  assert.ok(has(deinflect('高くなる'), '高い'), '「高く」+ なる 也要能还原出形容词');
});

test('な形容词 / 名词断定：だ・です・だった・じゃない', () => {
  assert.ok(has(deinflect('静かだった'), '静か'));
  assert.ok(has(deinflect('静かです'), '静か'));
  assert.ok(has(deinflect('静かじゃない'), '静か'));
});

/* ---------------- 多重活用链 ---------------- */

test('多重活用：可以连续还原到辞书形', () => {
  // 食べたくなかった → 食べる。
  // 注意：这条走的是「た→る」这条贪心规则（对一段动词恰好正确），只需 1 步；
  // 不要求它必须多步 —— 步数少是好事，断言的重点是**能拿到正确的原形**。
  const list = deinflect('食べたくなかった');
  assert.ok(has(list, '食べる'), '应能还原到食べる，实际候选：' + words(list).join('/'));
  // 中间形态也要在候选里（供词典逐个试）
  assert.ok(has(list, '食べたい'), '中间形态食べたい也应在候选里');
});

test('多重活用：确实需要多步链的情形（中间形态无词典条目时靠它兜底）', () => {
  // 食べさせられなかった → 食べさせられない → 食べさせられる → 食べさせる → 食べる
  // 这条无法一步到位（「なかった」剥掉后是「食べさせられ」，仍需继续剥），必须多步
  const list = deinflect('食べさせられなかった');
  const hit = list.find(c => c.word === '食べる');
  assert.ok(hit, '应能还原到食べる，实际候选：' + words(list).join('/'));
  assert.ok(hit.steps >= 3, '这条必须走多步，实际 ' + hit.steps + ' 步');
  assert.ok(hit.path.length >= 4, '路径应记录完整链条：' + describePath(hit));
});

test('多重活用：受身 + たい + ない 的组合', () => {
  const list = deinflect('食べさせられたくなかった');
  assert.ok(has(list, '食べる'), '实际候选：' + words(list).join('/'));
});

test('多重活用：ない形 + ている 的组合', () => {
  assert.ok(has(deinflect('読んでいない'), '読む'));
});

/* ---------------- 候选质量 ---------------- */

test('候选不含输入本身（绕回原词无意义）', () => {
  for (const w of ['食べた', '書きます', '読んでいる']){
    assert.ok(!words(deinflect(w)).includes(w), w + ' 的候选不该含自身');
  }
});

test('候选按步数升序排列（最可能的原形在前）', () => {
  const list = deinflect('食べた');
  const steps = list.map(c => c.steps);
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), '步数必须升序');
});

test('候选数量不超过上限', () => {
  for (const w of ['食べた', '書いた', '読んでいる', '食べさせられたくなかった']){
    assert.ok(deinflect(w).length <= MAX_CANDIDATES, w + ' 超出候选上限');
  }
});

test('maxCandidates / maxSteps 可调', () => {
  assert.ok(deinflect('食べた', { maxCandidates: 2 }).length <= 2);
  assert.equal(deinflect('食べたくなかった', { maxSteps: 1 }).every(c => c.steps === 1), true,
    'maxSteps=1 时不该出现两步以上的候选');
});

test('不支持的输入返回空数组（调用方据此不做兜底）', () => {
  for (const w of ['', '   ', null, undefined, 'ABC', '123', 'あいうえお']){
    assert.deepEqual(deinflect(w), [], JSON.stringify(w) + ' 不该产生候选');
    void w;
  }
});

test('已经是辞书形时基本不产出无谓候选', () => {
  // 「食べる」去掉「る」会得到「食べ」这类残缺词，规则表不该把它当成原形产出的主候选
  const list = deinflect('食べる');
  assert.ok(!words(list).includes('食べ'), '不该把残缺词当主候选');
});

/* ---------------- 片假名折叠 ---------------- */

test('katakanaToHiragana：转换主体假名，保留长音符', () => {
  assert.equal(katakanaToHiragana('タベタ'), 'たべた');
  assert.equal(katakanaToHiragana('コーヒー'), 'こーひー', '长音符「ー」是表音符号，不转换');
  assert.equal(katakanaToHiragana('あアいイ'), 'ああいい', '平假名原样保留');
  assert.equal(katakanaToHiragana(''), '');
  assert.equal(katakanaToHiragana(null), '');
});

test('片假名输入：折叠候选 + 折叠后的活用还原', () => {
  const list = deinflect('タベタ');
  assert.ok(has(list, 'たべた'), '应有平假名折叠候选');
  assert.ok(has(list, 'たべる'), '折叠后继续还原应得到原形');
});

test('片假名折叠可关闭', () => {
  const list = deinflect('タベタ', { foldKatakana: false });
  assert.ok(!has(list, 'たべた'));
});

/* ---------------- 规则表自身 ---------------- */

test('规则表非空且每条规则完整（防止手写时漏字段）', () => {
  assert.ok(DEINFLECT_RULES.length > 50, '规则表应有足够覆盖，实际 ' + DEINFLECT_RULES.length);
  for (const r of DEINFLECT_RULES){
    assert.equal(typeof r.from, 'string', 'from 必须是字符串：' + JSON.stringify(r));
    assert.equal(typeof r.to, 'string', 'to 必须是字符串：' + JSON.stringify(r));
    assert.ok(r.from.length > 0, 'from 不能为空');
    assert.ok(r.label, '每条规则要有标签（供 UI 说明）：' + JSON.stringify(r));
  }
});

test('规则表：不允许把词还原得更长（含等长的合法情形）', () => {
  // 等长是合法的（来た→来る、た→る、く→い 这类替换），所以用 <= 而不是 <
  for (const r of DEINFLECT_RULES){
    assert.ok(r.to.length <= r.from.length,
      r.from + ' → ' + r.to + ' 变长了，规则可疑');
  }
});

test('describePath：无路径输入安全', () => {
  assert.equal(describePath(null), '');
  assert.equal(describePath({}), '');
  assert.equal(describePath({ path: ['a'] }), '', '单元素路径不算路径');
  assert.equal(describePath({ path: ['a', 'b'] }), 'a → b');
});

/* ---------------- 实际剧本场景 ---------------- */

test('剧本常见对白片段：能还原出可用原形', () => {
  const cases = [
    ['食べた', '食べる'],
    ['行った', '行く'],
    ['見てる', '見る'],
    ['わからない', 'わかる'],
    ['できなかった', 'できる'],
    ['言われた', '言う'],
    ['読まされる', '読む'],
    ['書かせて', '書く'],
    ['来てる', '来る'],
  ];
  for (const [input, expect] of cases){
    assert.ok(has(deinflect(input), expect),
      input + ' 应能还原到 ' + expect + '，实际：' + words(deinflect(input)).join('/'));
  }
});
