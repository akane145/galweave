// format-editor-state.js 纯逻辑测试 — node:test + node:assert
// 覆盖: 布局/样例/标注的增删改 / v2 回填 / 组装档案 / 不可变性
// 运行: node --test tests/format-editor-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEditorState, createLayout, resetIdSeq,
  addLayout, removeLayout, setLayoutKind, setLayoutTitle,
  addSample, removeSample, setSampleText,
  addMark, removeMark, fieldLabel,
  stateFromRule, sampleFromFragments,
  buildRule, cloneState, DEFAULT_TITLES,
} from '../src/format-editor-state.js';
import { buildSkeleton, inferLayout } from '../src/format-samples.js';
import { validateFormatV2, migrateV1ToV2, BUILTIN_FORMATS } from '../src/offline-formats.js';

/* ---------------- 构造 ---------------- */

test('createLayout: 默认一个对话布局，两侧各一组空样例', () => {
  resetIdSeq();
  const L = createLayout();
  assert.equal(L.kind, 'dialogue');
  assert.equal(L.title, DEFAULT_TITLES.dialogue);
  assert.equal(L.source.samples.length, 1);
  assert.equal(L.target.samples.length, 1);
  assert.deepEqual(L.source.samples[0], { text:'', marks:[] });
});

test('createLayout: 指定旁白', () => {
  const L = createLayout('narration');
  assert.equal(L.kind, 'narration');
  assert.equal(L.title, DEFAULT_TITLES.narration);
});

test('createLayout: 非法 kind 回退对话', () => {
  assert.equal(createLayout('独白').kind, 'dialogue');
});

test('createEditorState: 默认一个对话布局 + 顺序配对', () => {
  const s = createEditorState();
  assert.equal(s.layouts.length, 1);
  assert.equal(s.pairing, 'order');
  assert.deepEqual(s.ignore, []);
  assert.equal(s.name, '');
});

/* ---------------- 布局操作 ---------------- */

test('addLayout / removeLayout', () => {
  resetIdSeq();
  let s = createEditorState();
  s = addLayout(s, 'narration');
  assert.equal(s.layouts.length, 2);
  assert.equal(s.layouts[1].kind, 'narration');
  const id = s.layouts[1].id;
  s = removeLayout(s, id);
  assert.equal(s.layouts.length, 1);
});

test('setLayoutKind / setLayoutTitle', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = setLayoutKind(s, id, 'narration');
  assert.equal(s.layouts[0].kind, 'narration');
  s = setLayoutTitle(s, id, ' 战斗场景 ');
  assert.equal(s.layouts[0].title, ' 战斗场景 ');
});

test('setLayoutTitle: 超长标题被截断', () => {
  let s = createEditorState();
  s = setLayoutTitle(s, s.layouts[0].id, 'x'.repeat(200));
  assert.equal(s.layouts[0].title.length, 60);
});

/* ---------------- 样例操作 ---------------- */

test('addSample: 原文与译文两侧同时加（一组样例天然成对）', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = addSample(s, id);
  assert.equal(s.layouts[0].source.samples.length, 2);
  assert.equal(s.layouts[0].target.samples.length, 2, '两侧必须等长，否则配对会错位');
});

test('removeSample: 两侧同时删；可以删到 0 组（由归纳环节报错提示）', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = addSample(s, id);
  s = removeSample(s, id, 1);
  assert.equal(s.layouts[0].source.samples.length, 1);
  s = removeSample(s, id, 0);
  assert.equal(s.layouts[0].source.samples.length, 0, '允许删空，不静默补回');
  assert.equal(s.layouts[0].target.samples.length, 0);
});

test('removeSample: 越界索引安全', () => {
  let s = createEditorState();
  s = removeSample(s, s.layouts[0].id, 99);
  assert.equal(s.layouts[0].source.samples.length, 1);
});

test('setSampleText: 写入文本', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = setSampleText(s, id, 'source', 0, 'JP[1] あ');
  assert.equal(s.layouts[0].source.samples[0].text, 'JP[1] あ');
});

test('setSampleText: 改文本时清空该组标注（坐标会失效，不能保留）', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = setSampleText(s, id, 'source', 0, 'JP[1] あ');
  const r = addMark(s, id, 'source', 0, { start:3, end:4, field:'id' });
  assert.equal(r.ok, true);
  assert.equal(r.state.layouts[0].source.samples[0].marks.length, 1);
  const s2 = setSampleText(r.state, id, 'source', 0, 'JP[1] あい');
  assert.equal(s2.layouts[0].source.samples[0].marks.length, 0,
   '文本一变，旧坐标就指向别处；必须清空重标，否则会静默标错位置');
});

test('setSampleText: 文本未变时不清空标注（例如只触发了一次 input 事件）', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = setSampleText(s, id, 'source', 0, 'JP[1] あ');
  s = addMark(s, id, 'source', 0, { start:3, end:4, field:'id' }).state;
  const s2 = setSampleText(s, id, 'source', 0, 'JP[1] あ');
  assert.equal(s2.layouts[0].source.samples[0].marks.length, 1, '文本没变就不该动标注');
});

/* ---------------- 标注操作 ---------------- */

test('addMark: 正常加标注并按位置排序', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = setSampleText(s, id, 'source', 0, 'JP[1] あ');
  let r = addMark(s, id, 'source', 0, { start:6, end:7, field:'text' });
  assert.equal(r.ok, true);
  r = addMark(r.state, id, 'source', 0, { start:3, end:4, field:'id' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.layouts[0].source.samples[0].marks.map(m=>m.field), ['id','text'], '应按位置排序');
});

test('addMark: 同字段重复被拒绝并说明原因', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = setSampleText(s, id, 'source', 0, 'JP[1] あ');
  const r1 = addMark(s, id, 'source', 0, { start:3, end:4, field:'id' });
  const r2 = addMark(r1.state, id, 'source', 0, { start:0, end:2, field:'id' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /已经有「编号」/);
});

test('addMark: 重叠被拒绝', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = setSampleText(s, id, 'source', 0, 'JP[1] あ');
  const r1 = addMark(s, id, 'source', 0, { start:0, end:4, field:'id' });
  const r2 = addMark(r1.state, id, 'source', 0, { start:3, end:7, field:'text' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /重叠/);
});

test('addMark: 越界/空区间/非法字段被拒绝', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = setSampleText(s, id, 'source', 0, 'abc');
  assert.match(addMark(s, id, 'source', 0, { start:0, end:99, field:'text' }).error, /超出/);
  assert.match(addMark(s, id, 'source', 0, { start:1, end:1, field:'text' }).error, /选中/);
  assert.match(addMark(s, id, 'source', 0, { start:0, end:1, field:'bad' }).error, /只能标注为/);
});

test('addMark: 找不到布局/样例时安全失败', () => {
  const s = createEditorState();
  assert.equal(addMark(s, 'nope', 'source', 0, { start:0, end:1, field:'text' }).ok, false);
  assert.equal(addMark(s, s.layouts[0].id, 'source', 9, { start:0, end:1, field:'text' }).ok, false);
});

test('removeMark: 按字段撤销', () => {
  let s = createEditorState();
  const id = s.layouts[0].id;
  s = setSampleText(s, id, 'source', 0, 'JP[1] あ');
  s = addMark(s, id, 'source', 0, { start:3, end:4, field:'id' }).state;
  s = addMark(s, id, 'source', 0, { start:6, end:7, field:'text' }).state;
  s = removeMark(s, id, 'source', 0, 'id');
  assert.deepEqual(s.layouts[0].source.samples[0].marks.map(m=>m.field), ['text']);
});

test('fieldLabel: 中文标签', () => {
  assert.equal(fieldLabel('id'), '编号');
  assert.equal(fieldLabel('name'), '角色名');
  assert.equal(fieldLabel('text'), '正文');
});

/* ---------------- 不可变性 ---------------- */

test('所有操作返回新对象，不改动入参（UI 侧靠这个做撤销/回滚）', () => {
  const s0 = createEditorState();
  const before = JSON.stringify(s0);
  addLayout(s0, 'narration');
  removeLayout(s0, s0.layouts[0].id);
  addSample(s0, s0.layouts[0].id);
  setLayoutTitle(s0, s0.layouts[0].id, '改了');
  setSampleText(s0, s0.layouts[0].id, 'source', 0, '改了');
  addMark(s0, s0.layouts[0].id, 'source', 0, { start:0, end:1, field:'text' });
  removeMark(s0, s0.layouts[0].id, 'source', 0, 'text');
  assert.equal(JSON.stringify(s0), before, '入参必须保持不变');
});

test('cloneState: 深拷贝（改副本不影响原件）', () => {
  const s = createEditorState();
  const c = cloneState(s);
  c.layouts[0].source.samples[0].text = '改了';
  c.layouts[0].source.samples[0].marks.push({ start:0, end:1, field:'text' });
  assert.equal(s.layouts[0].source.samples[0].text, '');
  assert.equal(s.layouts[0].source.samples[0].marks.length, 0);
});

/* ---------------- v2 回填 ---------------- */

test('stateFromRule: v2 档案回填为编辑器状态', () => {
  const v2 = migrateV1ToV2(BUILTIN_FORMATS[1]);
  const s = stateFromRule(v2);
  assert.equal(s.layouts.length, 1);
  assert.equal(s.layouts[0].kind, 'dialogue');
  assert.equal(s.pairing, 'id');
  assert.deepEqual(s.ignore, ['#',';']);
  assert.equal(s.layouts[0].source.samples.length, 2, '已有档案应回填成可直接归纳的两组样例');
  assert.equal(s.layouts[0].target.samples.length, 2);
  // 标注从片段反推：编号在前、正文在后
  const marks = s.layouts[0].source.samples[0].marks;
  assert.deepEqual(marks.map(m=>m.field), ['id','text']);

  const rebuilt = buildRule(s, inferLayout);
  assert.equal(rebuilt.ok, true, '使用已有档案后无需切换高级模式即可重新生成规则');
  assert.deepEqual(validateFormatV2(rebuilt.rule), validateFormatV2(v2));
});

test('stateFromRule: v1 档案先迁移（调用方负责），非 v2 返回 null', () => {
  assert.equal(stateFromRule({version:1}), null);
  assert.equal(stateFromRule(null), null);
  assert.equal(stateFromRule(undefined), null);
});

test('sampleFromFragments: 生成可回推原片段的真实样例与精确标注', () => {
  const frags = [
    { type:'literal', value:'JP[' },
    { type:'field', field:'id' },
    { type:'literal', value:'] ' },
    { type:'field', field:'text' },
  ];
  const sample = sampleFromFragments(frags, 0);
  assert.equal(sample.text, 'JP[1] 样例甲');
  assert.equal(sample.text.slice(sample.marks[0].start, sample.marks[0].end), '1');
  assert.equal(sample.text.slice(sample.marks[1].start, sample.marks[1].end), '样例甲');
  assert.deepEqual(buildSkeleton(sample.text, sample.marks).fragments, frags);
});

/* ---------------- 组装档案 ---------------- */

test('buildRule: 两组样例的对话布局 → 可用的 v2 档案', () => {
  resetIdSeq();
  let s = createEditorState();
  s = setLayoutTitle(s, s.layouts[0].id, '对话');
  const id = s.layouts[0].id;
  s = addSample(s, id);
  s = setSampleText(s, id, 'source', 0, 'JP[1] あ');
  s = setSampleText(s, id, 'target', 0, 'CN[1] 甲');
  s = setSampleText(s, id, 'source', 1, 'JP[2] い');
  s = setSampleText(s, id, 'target', 1, 'CN[2] 乙');
  for (const [idx, txt, sv, tv] of [[0,'JP[1] あ','1','あ'],[1,'JP[2] い','2','い']]){
    let r = addMark(s, id, 'source', idx, { start:txt.indexOf(sv), end:txt.indexOf(sv)+sv.length, field:'id' });
    assert.equal(r.ok, true); s = r.state;
    r = addMark(s, id, 'source', idx, { start:txt.indexOf(tv), end:txt.indexOf(tv)+tv.length, field:'text' });
    assert.equal(r.ok, true); s = r.state;
  }
  for (const [idx, txt, sv, tv] of [[0,'CN[1] 甲','1','甲'],[1,'CN[2] 乙','2','乙']]){
    let r = addMark(s, id, 'target', idx, { start:txt.indexOf(sv), end:txt.indexOf(sv)+sv.length, field:'id' });
    assert.equal(r.ok, true); s = r.state;
    r = addMark(s, id, 'target', idx, { start:txt.indexOf(tv), end:txt.indexOf(tv)+tv.length, field:'text' });
    assert.equal(r.ok, true); s = r.state;
  }
  s = { ...s, name:'我的档案', pairing:'id' };

  const built = buildRule(s, inferLayout);
  assert.equal(built.ok, true, built.errors.map(e=>e.message).join('|'));
  assert.equal(built.rule.version, 2);
  assert.equal(built.rule.name, '我的档案');
  assert.equal(built.rule.pairing, 'id');
  assert.equal(built.rule.sourcePatterns.length, 1);
  assert.equal(built.rule.targetPatterns.length, 1);
  // 生成的档案必须能通过严格校验
  assert.doesNotThrow(() => validateFormatV2(built.rule));
});

test('buildRule: 只有一组样例时失败，错误指向具体布局与侧', () => {
  let s = createEditorState();
  s = setSampleText(s, s.layouts[0].id, 'source', 0, 'JP[1] あ');
  s = setSampleText(s, s.layouts[0].id, 'target', 0, 'CN[1] 甲');
  const built = buildRule(s, inferLayout);
  assert.equal(built.ok, false);
  assert.ok(built.errors.length >= 1);
  assert.match(built.errors[0].message, /至少需要 2 组/);
  assert.equal(built.errors[0].side, 'source', '要指明是原文侧还是译文侧');
});

test('buildRule: 相同译文布局自动复用同一 id（不产生伪歧义）', () => {
  resetIdSeq();
  let s = createEditorState();
  s = { ...s, name: '双布局档案' };
  // 两个布局，译文都是 CN[..] 形式
  s = addLayout(s, 'narration');
  const [a, b] = [s.layouts[0], s.layouts[1]];
  // 两个布局的原文前缀不同（☆ / ◆），译文都是 CN[..] 形式
  for (const [L, srcWords] of [
    [a, ['☆1☆あ','☆2☆い']],
    [b, ['◆1◆あ','◆2◆い']],
  ]){
    s = addSample(s, L.id);
    srcWords.forEach((t, i) => { s = setSampleText(s, L.id, 'source', i, t); s = setSampleText(s, L.id, 'target', i, 'CN[' + (i+1) + '] ' + (i?'乙':'甲')); });
    srcWords.forEach((t, i) => {
      const tv = t.slice(3);
      let r = addMark(s, L.id, 'source', i, { start:1, end:2, field:'id' }); s = r.state;
      r = addMark(s, L.id, 'source', i, { start:3, end:3+tv.length, field:'text' }); s = r.state;
      const tt = 'CN[' + (i+1) + '] ' + (i?'乙':'甲');
      const tvv = tt.slice(5);
      r = addMark(s, L.id, 'target', i, { start:3, end:4, field:'id' }); s = r.state;
      r = addMark(s, L.id, 'target', i, { start:5, end:5+tvv.length, field:'text' }); s = r.state;
    });
  }
  const built = buildRule(s, inferLayout);
  assert.equal(built.ok, true, built.errors.map(e=>e.message).join('|'));
  assert.equal(built.rule.targetPatterns.length, 1, '相同译文布局应复用');
  assert.equal(built.rule.sourcePatterns[0].target, built.rule.sourcePatterns[1].target);
  assert.doesNotThrow(() => validateFormatV2(built.rule));
});

test('buildRule: 归纳失败时把错误归到对应布局', () => {
  let s = createEditorState();
  // 两组样例结构不同 → inferLayout 报错
  s = addSample(s, s.layouts[0].id);
  s = setSampleText(s, s.layouts[0].id, 'source', 0, 'JP[1] あ');
  s = setSampleText(s, s.layouts[0].id, 'source', 1, '◆2◆い');
  s = addMark(s, s.layouts[0].id, 'source', 0, { start:3, end:4, field:'id' }).state;
  s = addMark(s, s.layouts[0].id, 'source', 0, { start:6, end:7, field:'text' }).state;
  s = addMark(s, s.layouts[0].id, 'source', 1, { start:1, end:2, field:'id' }).state;
  s = addMark(s, s.layouts[0].id, 'source', 1, { start:3, end:4, field:'text' }).state;
  const built = buildRule(s, inferLayout);
  assert.equal(built.ok, false);
  assert.equal(built.errors[0].side, 'source');
  assert.ok(built.errors[0].layout.length > 0, '要带上布局名');
});

test('buildRule: 空状态 → 明确失败而非产出空档案', () => {
  const built = buildRule({ layouts: [] }, inferLayout);
  assert.equal(built.ok, false);
  assert.match(built.errors[0].message, /还没有可用的布局/);
});
