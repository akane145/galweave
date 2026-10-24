// textnorm.js 纯逻辑测试 — node:test + node:assert
// 覆盖: 规则选择 / 三类规范化 / 只作用于译文 / 避头尾检测
// 运行: node --test tests/textnorm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NORM_IDS, normalizeRuleIds, normalizeText, collectNormalizable,
  checkKinjiru, kinjiruLabel, NO_LINE_START, NO_LINE_END,
  validateCustomRules, MAX_CUSTOM_NORM_RULES, MAX_CUSTOM_NORM_LENGTH,
  MAX_NORMALIZED_TEXT_LENGTH,
} from '../src/textnorm.js';

test('自定义标点：三个例子按顺序替换，破折号可以由用户选择保留', () => {
  const rules = [{from:'。」',to:'」'}, {from:'……。',to:'……'}, {from:'……——',to:'……'}];
  assert.equal(normalizeText('「结束。」然后……。最后……——', [], rules), '「结束」然后……最后……');
  assert.equal(normalizeText('……——', [], [{from:'……——',to:'——'}]),'——');
  assert.equal(normalizeText('……——', [], [{from:'……——',to:'——',enabled:false}]),'……——');
});

test('自定义匹配是字面量，允许删除；不会把替换中的 $& 当作特殊语法', () => {
  assert.equal(normalizeText('。',[],[{from:'。',to:'$&'}]),'$&');
  assert.equal(normalizeText('。',[],[{from:'。',to:''}]),'');
  assert.equal(normalizeText('……。',[],[{from:'……。',to:'……'},{from:'……',to:'——'}]),'——');
});

test('规范化保护控制符，拒绝生成新的控制符', () => {
  assert.equal(normalizeText('%f...;文字...'), '%f...;文字……');
  assert.equal(normalizeText('%f。;……[n]。',[],[{from:'。',to:''}]), '%f。;……[n]');
  assert.throws(() => validateCustomRules([{from:'。',to:'[n]'}]),/控制/);
});

test('规则上限和空匹配校验；带括号译文预览不额外包引号', () => {
  assert.equal(MAX_NORMALIZED_TEXT_LENGTH,1000000);
  assert.throws(() => normalizeText('.'.repeat(26),[],[{from:'.',to:'!'.repeat(200)},{from:'!',to:'?'.repeat(200)}]), /100 万/);
  assert.equal(MAX_CUSTOM_NORM_RULES,100);
  assert.equal(MAX_CUSTOM_NORM_LENGTH,200);
  assert.throws(() => validateCustomRules([{from:'',to:'。'}]), /匹配/);
  assert.throws(() => validateCustomRules(Array.from({length:101},()=>({from:'。',to:''}))),/100/);
  const p={translation:'「结束。」',brackets:true};
  assert.deepEqual(collectNormalizable([p],[],[{from:'。」',to:'」'}]),[{i:0,from:'「结束。」',to:'「结束」'}]);
});

/* ---------------- 规则选择 ---------------- */

test('normalizeRuleIds: 缺省全开，空数组全关，未知 id 被忽略', () => {
  assert.deepEqual(normalizeRuleIds(), NORM_IDS);
  assert.deepEqual(normalizeRuleIds(null), NORM_IDS);
  assert.deepEqual(normalizeRuleIds([]), []);
  assert.deepEqual(normalizeRuleIds(['ellipsis']), ['ellipsis']);
  assert.deepEqual(normalizeRuleIds(['不存在的规则', 'tilde']), ['tilde']);
  // 顺序始终按 NORM_RULES，不随入参顺序变
  assert.deepEqual(normalizeRuleIds(['tilde', 'ellipsis']), ['ellipsis', 'tilde']);
});

/* ---------------- 省略号 ---------------- */

test('省略号：连续半角点 → ……（两个、三个、更多都收）', () => {
  assert.equal(normalizeText('等等...'), '等等……');
  assert.equal(normalizeText('等等....'), '等等……');
  assert.equal(normalizeText('等等..........'), '等等……');
  assert.equal(normalizeText('そうか...そうだ'), 'そうか……そうだ');
});

test('省略号：单个点不动（可能是句号或小数）', () => {
  assert.equal(normalizeText('3.14'), '3.14');
  assert.equal(normalizeText('そう。'), 'そう。');
  assert.equal(normalizeText('A.B'), 'A.B');
});

test('省略号：已是中文六点省略号则保持不变（幂等）', () => {
  assert.equal(normalizeText('等等……'), '等等……');
  assert.equal(normalizeText(normalizeText('等等...')), '等等……');
});

test('省略号：不擅自转换。。与・・（可能是有意为之，宁漏报不误报）', () => {
  assert.equal(normalizeText('そう。。'), 'そう。。');
  assert.equal(normalizeText('・・'), '・・');
});

/* ---------------- 破折号 ---------------- */

test('破折号：半角连字符与各类破折号统一为 ——', () => {
  assert.equal(normalizeText('そう--そう'), 'そう——そう');
  assert.equal(normalizeText('そう----そう'), 'そう——そう');
  assert.equal(normalizeText('そう—そう'), 'そう——そう');
  assert.equal(normalizeText('そう――そう'), 'そう——そう');
});

test('破折号：必须不碰片假名长音符「ー」（它是表音字符，不是标点）', () => {
  assert.equal(normalizeText('コーヒー'), 'コーヒー', 'ー 被改动就是破坏日语表记');
  assert.equal(normalizeText('スーパーー'), 'スーパーー');
});

test('破折号：单个连字符不动（可能是正当连字）', () => {
  assert.equal(normalizeText('E-mail'), 'E-mail');
  assert.equal(normalizeText('一-二'), '一-二');
});

/* ---------------- 波浪号 ---------------- */

test('波浪号：半角 ~ 与日文 〜 统一为全角 ～', () => {
  assert.equal(normalizeText('やった~'), 'やった～');
  assert.equal(normalizeText('やった〜'), 'やった～');
  assert.equal(normalizeText('やった～'), 'やった～');
});

/* ---------------- 组合行为 ---------------- */

test('normalizeText: 规则按序应用，互不干扰', () => {
  assert.equal(normalizeText('え...~そう--だ'), 'え……～そう——だ');
});

test('normalizeText: 可单独关闭某条规则', () => {
  assert.equal(normalizeText('等等...', ['tilde']), '等等...');
  assert.equal(normalizeText('等等...', []), '等等...');
  assert.equal(normalizeText('やった~', ['ellipsis']), 'やった~');
});

test('normalizeText: 空/非法输入安全', () => {
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
});

test('normalizeText: 幂等 —— 二次应用不再变化', () => {
  for (const s of ['等等...', 'そう--そう', 'やった~', 'え...~そう--だ']){
    const once = normalizeText(s);
    assert.equal(normalizeText(once), once, s + ' 二次规范化应无变化');
  }
});

/* ---------------- collectNormalizable ---------------- */

test('collectNormalizable: 只收会变化的行，未翻译与 NAME 行跳过', () => {
  const paras = [
    { translation: '等等...' },        // 会变
    { translation: '已经规范……' },     // 不会变
    { translation: '' },               // 未翻译，跳过
    { translation: '名字...', isName: true },  // NAME 行，跳过
    { translation: 'そう--だ' },       // 会变
  ];
  const r = collectNormalizable(paras, null);
  assert.deepEqual(r.map(x => x.i), [0, 4]);
  assert.equal(r[0].from, '等等...');
  assert.equal(r[0].to, '等等……');
});

test('collectNormalizable: 空/非法输入安全', () => {
  assert.deepEqual(collectNormalizable([], null), []);
  assert.deepEqual(collectNormalizable(null, null), []);
  assert.deepEqual(collectNormalizable([null, undefined], null), []);
});

/* ---------------- 避头尾 ---------------- */

test('checkKinjiru: 行首出现句读点 → no-start', () => {
  const r = checkKinjiru('そうだ\n、そう思う');
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'no-start');
  assert.equal(r[0].ch, '、');
});

test('checkKinjiru: 行末出现开引号 → no-end', () => {
  const r = checkKinjiru('そうだ「\nそう思う');
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'no-end');
  assert.equal(r[0].ch, '「');
});

test('checkKinjiru: 引擎换行标签同样参与判断（[r] / 转义 \\n）', () => {
  const a = checkKinjiru('そうだ[r]、そう思う');
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'no-start');
  const b = checkKinjiru('そうだ「\\nそう思う');
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, 'no-end');
});

test('checkKinjiru: 规规矩矩的换行不报', () => {
  assert.deepEqual(checkKinjiru('そうだ。\nそう思う。'), []);
  assert.deepEqual(checkKinjiru('「そうだ」\n「そう思う」'), []);
  assert.deepEqual(checkKinjiru('没有换行的单行文本。'), []);
});

test('checkKinjiru: 空/非法输入安全', () => {
  assert.deepEqual(checkKinjiru(''), []);
  assert.deepEqual(checkKinjiru(null), []);
  assert.deepEqual(checkKinjiru(undefined), []);
});

test('checkKinjiru: 换行处两侧都有问题时两条都报', () => {
  const r = checkKinjiru('そうだ「\n、そう思う');
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(x => x.kind).sort(), ['no-end', 'no-start']);
});

test('kinjiruLabel: 判定文案可读', () => {
  assert.match(kinjiruLabel({ kind: 'no-start', ch: '、' }), /行首.*、/);
  assert.match(kinjiruLabel({ kind: 'no-end', ch: '「' }), /行末.*「/);
  assert.equal(kinjiruLabel(null), '');
});

test('禁则字符集：开闭括号分属两端，不重叠', () => {
  for (const ch of NO_LINE_START){
    assert.ok(!NO_LINE_END.has(ch), ch + ' 不该同时属于行首与行末禁则');
  }
});
