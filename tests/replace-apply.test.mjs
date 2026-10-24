// 「全部替换」提交链路的纯逻辑回归测试 — node:test + node:assert
//
// ⚠️ 本文件**不复制** applySelected 之类的实现，而是直接调用生产函数：
//   src/replace-apply.js 的 buildReplacePlan / planReplaceCommit / commitReplaceEntries
//   + src/model.js 的真实撤销栈（Node 下可直接 import）。
// R1（只勾名字却把译文写回预览时的旧值）正是"测试自写一份提交逻辑"漏掉的缺陷，
// 因此这里坚持走生产路径 —— 见 tasks/translation-ux-handoff/review.md。
//
// 运行: node --test tests/replace-apply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReplacePlan, planReplaceCommit, commitReplaceEntries, replaceTargetField } from '../src/replace-apply.js';
import { makePara } from '../src/parsers.js';
import * as model from '../src/model.js';
import { collectFromParas, emptyTm } from '../src/tm.js';

/* ---------------- 测试夹具：真实 model 撤销栈 + 生产提交函数 ---------------- */

/** 与 main.js replaceAll 相同的同步提交段（只做编排，不含任何业务规则副本） */
function runProductionCommit(paras, plan, picked, field = plan.field){
  const commit = planReplaceCommit({ paras, rows: plan.rows, picked, field });
  if (!commit.ok) return commit;
  if (!commit.entries.length) return { ok: true, applied: [], entries: [] };
  model.pushUndo(commit.entries.map(e => e.i)); // 捕获提交前两个字段与来源的真实状态
  const applied = commitReplaceEntries(paras, commit.entries, commit.field);
  return { ok: true, applied, entries: commit.entries };
}

function setup(paras){
  model.setParas(paras);
  return paras;
}

/** 只读快照：两个字段全取，用于断言"另一字段没被动过" */
const snap = (paras) => paras.map(p => ({ translation: p.translation, nameTr: p.nameTr }));

/* ---------------- R1：只提交目标字段 ---------------- */

test('R1：仅名字替换时，预览期间更新的译文必须保留', () => {
  const paras = setup([
    Object.assign(makePara('☆0000☆アリス☆ああ', '花火旧译'), { nameTr: '沙织' }),
  ]);
  const plan = buildReplacePlan(paras, '沙织', '早苗', 'name', true);
  assert.equal(plan.field, 'nameTr');
  assert.equal(plan.rows.length, 1);

  // 预览期间：后台机翻落地，把译文从 A 改成 B
  paras[0].translation = '后台新译文';

  const r = runProductionCommit(paras, plan, [0]);
  assert.equal(r.ok, true);
  assert.equal(paras[0].nameTr, '早苗', '目标字段（名字）被替换');
  assert.equal(paras[0].translation, '后台新译文', '未替换的译文保持预览期间的最新值');
});

test('R1：仅译文替换时，预览期间更新的译名必须保留（反向）', () => {
  const paras = setup([
    Object.assign(makePara('☆0000☆アリス☆ああ', '花火旧译'), { nameTr: '沙织' }),
  ]);
  const plan = buildReplacePlan(paras, '花火', '烟火', 'trans', true);
  assert.equal(plan.field, 'translation');

  paras[0].nameTr = '预览期间更新的译名';

  const r = runProductionCommit(paras, plan, [0]);
  assert.equal(r.ok, true);
  assert.equal(paras[0].translation, '烟火旧译');
  assert.equal(paras[0].nameTr, '预览期间更新的译名', '未替换的译名保持最新值');
});

test('R1：scope=all 也只改译文，译名不受影响', () => {
  const paras = setup([
    Object.assign(makePara('☆0000☆アリス☆花火', '花火旧译'), { nameTr: '沙织' }),
  ]);
  const plan = buildReplacePlan(paras, '花火', '烟火', 'all', true);
  assert.equal(plan.field, 'translation');
  paras[0].nameTr = '后台改的译名';
  runProductionCommit(paras, plan, plan.rows.map(r => r.i));
  assert.equal(paras[0].translation, '烟火旧译');
  assert.equal(paras[0].nameTr, '后台改的译名');
});

test('replaceTargetField：只有 name 范围写 nameTr', () => {
  assert.equal(replaceTargetField('name'), 'nameTr');
  assert.equal(replaceTargetField('trans'), 'translation');
  assert.equal(replaceTargetField('all'), 'translation');
});

/* ---------------- 目标字段变化 → 拒绝 ---------------- */

test('预览期间目标字段被改动 → 整批拒绝，不覆盖新输入', () => {
  const paras = setup([
    makePara('☆0000☆アリス☆ああ', '花火一'),
    makePara('☆0001☆ボブ☆いい', '花火二'),
  ]);
  const plan = buildReplacePlan(paras, '花火', '烟火', 'trans', true);
  paras[1].translation = '人工改过';
  const r = runProductionCommit(paras, plan, [0, 1]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'row-changed');
  assert.equal(r.i, 1);
  assert.deepEqual(paras.map(p => p.translation), ['花火一', '人工改过'], '一行都不写');
  assert.equal(model.canUndo(), false, '拒绝时不留撤销项');
});

test('行在预览后被移除（段落数组变化）→ 拒绝', () => {
  const paras = setup([
    makePara('☆0000☆アリス☆ああ', '花火一'),
    makePara('☆0001☆ボブ☆いい', '花火二'),
  ]);
  const plan = buildReplacePlan(paras, '花火', '烟火', 'trans', true);
  paras.splice(1, 1); // 模拟文档被替换/收缩
  const r = runProductionCommit(paras, plan, [1]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'row-missing');
});

/* ---------------- 部分选择 ---------------- */

test('部分选择：只改勾选行；未勾选行的两个字段都保持原样', () => {
  const paras = setup([
    makePara('☆0000☆アリス☆ああ', '花火一'),
    makePara('☆0001☆ボブ☆いい', '花火二'),
    makePara('☆0002☆アリス☆うう', '花火三'),
  ]);
  const plan = buildReplacePlan(paras, '花火', '烟火', 'trans', true);
  assert.equal(plan.rows.length, 3);
  const r = runProductionCommit(paras, plan, [0, 2]);
  assert.deepEqual(r.applied, [0, 2]);
  assert.deepEqual(paras.map(p => p.translation), ['烟火一', '花火二', '烟火三']);
});

test('全不选 → 不写入、不留撤销项（等价取消）', () => {
  const paras = setup([makePara('☆0000☆アリス☆ああ', '花火一')]);
  const plan = buildReplacePlan(paras, '花火', '烟火', 'trans', true);
  const r = runProductionCommit(paras, plan, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, []);
  assert.equal(paras[0].translation, '花火一');
  assert.equal(model.canUndo(), false);
});

/* ---------------- 撤销 / 重做 ---------------- */

test('一次撤销恢复全部选中行的两个字段（含预览期间的更新）', () => {
  const paras = setup([
    Object.assign(makePara('☆0000☆アリス☆ああ', '花火一'), { nameTr: '沙织' }),
    Object.assign(makePara('☆0001☆ボブ☆いい', '花火二'), { nameTr: '鲍勃' }),
  ]);
  const plan = buildReplacePlan(paras, '花火', '烟火', 'trans', true);
  paras[1].nameTr = '预览期间改的译名'; // 另一字段在预览期间变化
  runProductionCommit(paras, plan, [0, 1]);

  assert.equal(model.undo(), true);
  assert.deepEqual(snap(paras), [
    { translation: '花火一', nameTr: '沙织' },
    { translation: '花火二', nameTr: '预览期间改的译名' },
  ], '撤销回到提交前一刻的真实状态，不把译名退回到更早的旧值');

  assert.equal(model.redo(), true);
  assert.deepEqual(snap(paras), [
    { translation: '烟火一', nameTr: '沙织' },
    { translation: '烟火二', nameTr: '预览期间改的译名' },
  ]);
});

test('部分选择后一次撤销只回退所选行', () => {
  const paras = setup([
    makePara('☆0000☆アリス☆ああ', '花火一'),
    makePara('☆0001☆ボブ☆いい', '花火二'),
  ]);
  const plan = buildReplacePlan(paras, '花火', '烟火', 'trans', true);
  runProductionCommit(paras, plan, [1]);
  assert.deepEqual(paras.map(p => p.translation), ['花火一', '烟火二']);
  assert.equal(model.undo(), true);
  assert.deepEqual(paras.map(p => p.translation), ['花火一', '花火二']);
});

/* ---------------- R3：只改译名不得升格译文来源 ---------------- */

/** 一行未复核的机翻草稿：来源 mt、校对 pending */
function mtDraftRow(){
  const p = makePara('☆0000☆アリス☆今日は学校に行きません。', '今天去学校吧');
  p.nameTr = '沙织';
  p.src = 'mt';
  p.pr = { status: 'pending', annotations: [] };
  return p;
}

test('R3：只改译名不把未复核机翻标为人工（src 保持 mt）', () => {
  const paras = setup([mtDraftRow()]);
  const plan = buildReplacePlan(paras, '沙织', '早苗', 'name', true);
  const r = runProductionCommit(paras, plan, plan.rows.map(x => x.i));
  assert.equal(r.ok, true);
  assert.equal(paras[0].nameTr, '早苗');
  assert.equal(paras[0].translation, '今天去学校吧', '译文一字未动');
  assert.equal(paras[0].src, 'mt', '只改译名不能把译文记成人工');
});

test('R3：只改译名 → 保存时收割进 TM 仍是草稿（不会被自动扩散）', () => {
  const paras = setup([mtDraftRow()]);
  const plan = buildReplacePlan(paras, '沙织', '早苗', 'name', true);
  runProductionCommit(paras, plan, plan.rows.map(x => x.i));
  const { tm } = collectFromParas(paras, emptyTm(), Date.now());
  assert.equal(tm.entries.length, 1);
  assert.equal(tm.entries[0].status, 'draft', '未复核机翻不得因一次改译名被升为已确认');
  assert.equal(tm.entries[0].dst, '今天去学校吧');
});

test('R3：只改译名后撤销，来源仍为 mt、TM 仍为草稿', () => {
  const paras = setup([mtDraftRow()]);
  const plan = buildReplacePlan(paras, '沙织', '早苗', 'name', true);
  runProductionCommit(paras, plan, plan.rows.map(x => x.i));
  assert.equal(model.undo(), true);
  assert.equal(paras[0].nameTr, '沙织');
  assert.equal(paras[0].src, 'mt', '撤销后来源不能被留下 human');
  const { tm } = collectFromParas(paras, emptyTm(), Date.now());
  assert.equal(tm.entries[0].status, 'draft');
});

test('R3：正文替换记 human（人工动作），撤销后来源回到替换前', () => {
  const paras = setup([mtDraftRow()]);
  const plan = buildReplacePlan(paras, '学校', '学园', 'trans', true);
  runProductionCommit(paras, plan, plan.rows.map(x => x.i));
  assert.equal(paras[0].translation, '今天去学园吧');
  assert.equal(paras[0].src, 'human', '改了译文就是人工动作');

  assert.equal(model.undo(), true);
  assert.equal(paras[0].translation, '今天去学校吧');
  assert.equal(paras[0].src, 'mt', '撤销同时回退归因，保存收割不会把未复核机翻升格');

  assert.equal(model.redo(), true);
  assert.equal(paras[0].translation, '今天去学园吧');
  assert.equal(paras[0].src, 'human', '重做恢复人工归因');
});

test('R3：撤销同时回退已通过状态之外的两个字段与来源（部分选择）', () => {
  const rows = [mtDraftRow(), mtDraftRow()];
  rows[1].content = '☆0001☆ボブ☆そうですね。';
  rows[1].orig = rows[1].content;
  rows[1].translation = '是呢。';
  rows[1].nameTr = '鲍勃';
  const paras = setup(rows);
  const plan = buildReplacePlan(paras, '学校', '学园', 'trans', true);
  runProductionCommit(paras, plan, [0]);
  assert.equal(paras[0].src, 'human');
  assert.equal(paras[1].src, 'mt', '未选中的行不被触碰');
  assert.equal(model.undo(), true);
  assert.deepEqual(paras.map(p => [p.translation, p.src]), [
    ['今天去学校吧', 'mt'],
    ['是呢。', 'mt'],
  ]);
});

test('R3：字段边界对调用方可见（name 范围返回 field=nameTr）', () => {
  // main.js 用 commit.field 决定是否推进 mtTaskEdit 版本号：
  // 只改译名不推进（译文没动，在途机翻落地不覆盖人工内容）
  const paras = setup([mtDraftRow()]);
  const namePlan = buildReplacePlan(paras, '沙织', '早苗', 'name', true);
  const nameCommit = planReplaceCommit({ paras, rows: namePlan.rows, picked: namePlan.rows.map(r => r.i), field: namePlan.field });
  assert.equal(nameCommit.field, 'nameTr');

  const transPlan = buildReplacePlan(paras, '学校', '学园', 'trans', true);
  const transCommit = planReplaceCommit({ paras, rows: transPlan.rows, picked: transPlan.rows.map(r => r.i), field: transPlan.field });
  assert.equal(transCommit.field, 'translation');
});

/* ---------------- 预览行内容（C 的上下文 + 同值过滤） ---------------- */

test('预览行带只读原句与脚本编号，且不重复标记同值替换', () => {
  const paras = setup([
    makePara('☆0000☆アリス☆今天花火大会', '去花火大会吧'),
    makePara('☆0001☆ボブ☆いいえ', '花火'),
    makePara('☆NAME|2☆沙織', ''),
  ]);
  paras[2].nameTr = '沙织';
  const plan = buildReplacePlan(paras, '花火', '烟火', 'trans', true);
  assert.deepEqual(plan.rows.map(r => r.i), [0, 1]);
  assert.equal(plan.rows[0].orig, '今天花火大会', '携带只读原句');
  assert.equal(plan.rows[0].ref, '0000', '携带脚本编号');
  assert.equal(plan.rows[1].before, '花火');
  assert.equal(plan.rows[1].after, '烟火');

  // 同值替换：命中但不改变 → 不出现在预览
  const same = buildReplacePlan(paras, '花火', '花火', 'trans', true);
  assert.equal(same.rows.length, 0);
  assert.ok(same.grand > 0, '命中数仍然统计到，只是没有真正改变的行');
});

test('预览计算不修改输入（非破坏）', () => {
  const paras = setup([makePara('☆0000☆アリス☆ああ', '花火一')]);
  const before = JSON.stringify(paras);
  buildReplacePlan(paras, '花火', '烟火', 'trans', true);
  assert.equal(JSON.stringify(paras), before);
});

/* ---------------- NAME 范围 ---------------- */

test('NAME 范围：只改 nameTr，空译名行的译文不被写入', () => {
  const paras = setup([makePara('☆NAME|0☆沙織', '')]);
  paras[0].nameTr = '沙织';
  const plan = buildReplacePlan(paras, '沙织', '早苗', 'name', true);
  assert.equal(plan.rows.length, 1);
  runProductionCommit(paras, plan, [0]);
  assert.equal(paras[0].nameTr, '早苗');
  assert.equal(paras[0].translation, '');
});

/* ---------------- 搜索同步前提：结果与原地全量替换一致 ---------------- */

test('提交结果与 search.replaceAllInParas 的原地替换一致（下一次搜索无幽灵匹配）', async () => {
  const mk = () => [
    makePara('☆0000☆アリス☆ああ', '花火与花火'),
    makePara('☆0001☆ボブ☆いい', '没有任何命中'),
    makePara('☆0002☆アリス☆うう', '花火'),
  ];
  const viaPlan = mk();
  const viaInPlace = mk();
  const plan = buildReplacePlan(viaPlan, '花火', '烟火', 'trans', true);
  runProductionCommit(viaPlan, plan, plan.rows.map(r => r.i));

  const s = await import('../src/search.js');
  s.replaceAllInParas(viaInPlace, '花火', '烟火', 'trans', true);

  assert.deepEqual(
    viaPlan.map(p => p.translation),
    viaInPlace.map(p => p.translation),
    '两条路径的最终文本必须一致',
  );
  assert.deepEqual(
    s.computeMatches(viaPlan, '花火', 'trans', true),
    [],
    '替换后旧词不再命中（影子同步的前提）',
  );
});
