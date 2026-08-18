// 校对模式单元测试 — node:test + node:assert, 纯逻辑不依赖 DOM
// 运行: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as model from '../src/model.js';
import { makePara } from '../src/parsers.js';
import {
  STATUS, resetState, setEnabled, setFilter, statusOf, unresolvedCount,
  toggleApprove, toggleIssue, addAnnotation, resolveAnnotation, deleteAnnotation,
  demoteApproved, recordChange, snapshot, recordDiff, restoreChange,
  stats, rowPassesFilter, getChanges, collect, setKeys, proofKeys, defaultKeys,
  analyzeRow, analyzeRows,
} from '../src/proof.js';

function paras3(){
  return [
    makePara('☆0000☆☆判断基準は面白さ', '判断标准是有趣'),
    makePara('☆0001☆ゆゆ☆「ごめんね」', '「抱歉」'),
    makePara('☆NAME|2☆ティナ'),
  ];
}

/* ---------------- 状态切换 ---------------- */

test('toggleApprove / toggleIssue: 三态互切并可取消', () => {
  model.setParas(paras3());
  resetState();
  setEnabled(true);
  assert.equal(statusOf(0), STATUS.PENDING);
  toggleApprove(0);
  assert.equal(statusOf(0), STATUS.APPROVED);
  toggleApprove(0);
  assert.equal(statusOf(0), STATUS.PENDING, '再点取消通过');
  toggleIssue(0);
  assert.equal(statusOf(0), STATUS.ISSUE);
  toggleIssue(0);
  assert.equal(statusOf(0), STATUS.PENDING, '再点取消有问题');
  // 关闭校对模式不影响已存状态
  setEnabled(false);
  toggleApprove(1);
  assert.equal(statusOf(1), STATUS.APPROVED);
});

/* ---------------- 批注 ---------------- */

test('批注: 问题/疑问 自动标「有问题」,全部解决回「待校对」', () => {
  model.setParas(paras3());
  resetState();
  const a1 = addAnnotation(0, 'issue', '这里漏译');
  assert.ok(a1 && a1.id, '返回批注对象');
  assert.equal(statusOf(0), STATUS.ISSUE, '问题批注 → 自动有问题');
  assert.equal(unresolvedCount(0), 1);

  const a2 = addAnnotation(0, 'note', '备注而已');
  assert.equal(statusOf(0), STATUS.ISSUE, '备注批注不改变状态');

  resolveAnnotation(0, a2.id);
  assert.equal(statusOf(0), STATUS.ISSUE, '还有未解决的「问题」批注,保持有问题');
  resolveAnnotation(0, a1.id);
  assert.equal(statusOf(0), STATUS.PENDING, '问题批注全部解决 → 回待校对');
  assert.equal(unresolvedCount(0), 0);
});

test('批注: 删除 问题/疑问 批注后回「待校对」;空文本拒绝', () => {
  model.setParas(paras3());
  resetState();
  const a = addAnnotation(1, 'question', '这里对吗？');
  assert.equal(statusOf(1), STATUS.ISSUE);
  deleteAnnotation(1, a.id);
  assert.equal(statusOf(1), STATUS.PENDING);
  assert.equal(addAnnotation(1, 'issue', '   '), null, '空文本不添加');
});

test('demoteApproved: 文本变化 → 已通过失效', () => {
  model.setParas(paras3());
  resetState();
  toggleApprove(0);
  assert.equal(statusOf(0), STATUS.APPROVED);
  assert.equal(demoteApproved(0), true);
  assert.equal(statusOf(0), STATUS.PENDING);
  assert.equal(demoteApproved(0), false, '非已通过行不降级');
});

/* ---------------- 修改记录 ---------------- */

test('recordChange: 仅校对模式开启时记录;字段/来源正确', () => {
  model.setParas(paras3());
  resetState();
  setEnabled(false);
  assert.equal(recordChange(0, 'translation', 'a', 'b', 'edit'), false, '关闭时不记录');
  setEnabled(true);
  assert.equal(recordChange(0, 'translation', 'a', 'b', 'edit'), true);
  assert.equal(recordChange(0, 'translation', 'b', 'b', 'edit'), false, '无变化不记录');
  const changes = getChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].line, 1);
  assert.equal(changes[0].field, 'translation');
  assert.equal(changes[0].before, 'a');
  assert.equal(changes[0].after, 'b');
  assert.equal(changes[0].source, 'edit');
  assert.ok(changes[0].paraId, '记录 paraId(原文行)');
});

test('recordDiff: 快照对比记录改动并让已通过失效', () => {
  model.setParas(paras3());
  resetState();
  setEnabled(true);
  const p0 = model.getPara(0), p1 = model.getPara(1);
  toggleApprove(0); // 已通过
  toggleApprove(1); // 已通过
  const snap = snapshot();
  p0.translation = '改后的译文';
  p1.nameTr = 'ゆゆ改';
  model.recalcDone(p0);
  model.recalcDone(p1);
  recordDiff(snap, 'batch');
  const changes = getChanges();
  const c0 = changes.find(c => c.paraId === p0.orig && c.field === 'translation');
  assert.ok(c0 && c0.before === '判断标准是有趣' && c0.after === '改后的译文', '记录译文改动');
  const c1 = changes.find(c => c.paraId === p1.orig && c.field === 'nameTr');
  assert.ok(c1 && c1.before === 'ゆゆ' && c1.after === 'ゆゆ改', '记录译名改动');
  assert.equal(statusOf(0), STATUS.PENDING, '译文变化 → 已通过失效');
  assert.equal(statusOf(1), STATUS.PENDING, '译名变化 → 已通过失效');
});

test('restoreChange: 还原到修改前并记录「还原」来源', () => {
  model.setParas(paras3());
  resetState();
  setEnabled(true);
  const p0 = model.getPara(0);
  p0.translation = '改后的译文';
  recordChange(0, 'translation', '判断标准是有趣', '改后的译文', 'edit'); // 等价于输入结算
  const changes = getChanges();
  assert.equal(changes.length, 1);
  const r = restoreChange(changes[0].id);
  assert.ok(r && r.idx === 0);
  assert.equal(p0.translation, '判断标准是有趣', '已还原');
  const changes2 = getChanges();
  assert.equal(changes2[0].source, 'restore', '还原本身也记录');
  assert.equal(changes2[0].before, '改后的译文');
  assert.equal(changes2[0].after, '判断标准是有趣');
  assert.equal(restoreChange('no-such-id'), null, '找不到的修改记录');
  assert.equal(model.canUndo(), true, '还原可撤销');
});

/* ---------------- 统计 / 过滤 ---------------- */

test('stats / rowPassesFilter: 三态统计与过滤', () => {
  model.setParas(paras3());
  resetState();
  setEnabled(true);
  toggleApprove(0);
  toggleIssue(1);
  const st = stats();
  assert.equal(st.total, 3);
  assert.equal(st.approved, 1);
  assert.equal(st.issue, 1);
  assert.equal(st.pending, 1);
  setFilter('approved');
  assert.equal(rowPassesFilter(0), true);
  assert.equal(rowPassesFilter(1), false);
  setFilter('all');
  assert.equal(rowPassesFilter(1), true);
  setEnabled(false);
  assert.equal(rowPassesFilter(0), true, '关闭校对模式时不过滤');
});

/* ---------------- 持久化数据形状 ---------------- */

test('collect: 只收集非默认状态的批注数据,含修改记录', () => {
  model.setParas(paras3());
  resetState();
  setEnabled(true);
  addAnnotation(1, 'issue', '问题');
  recordChange(2, 'nameTr', 'ティナ', '蒂娜', 'edit');
  const data = collect();
  assert.equal(data.version, 1);
  assert.ok(data.annotations[model.getPara(1).orig], '有批注的行进入 annotations');
  assert.equal(data.annotations[model.getPara(0).orig], undefined, '默认状态行不进入');
  assert.equal(data.changes.length, 1);
  assert.equal(data.changes[0].source, 'edit');
});

/* ---------------- 快捷键配置 ---------------- */

test('快捷键: 默认值与自定义', () => {
  resetState();
  assert.deepEqual(defaultKeys(), { approve: 'q', issue: 'w', annotate: 'a', nextIssue: '', toggleMode: '' });
  setKeys({ approve: 'Ctrl+K' });
  assert.equal(proofKeys.approve, 'Ctrl+K');
  assert.equal(proofKeys.issue, 'w', '未指定的沿用默认');
  setKeys(defaultKeys());
  assert.equal(proofKeys.approve, 'q');
});

/* ---------------- 漏翻 / 异常分析 ---------------- */

test('analyzeRow: 译文为空 → missing', () => {
  assert.deepEqual(analyzeRow(makePara('☆0000☆☆こんにちは', '')), { kind: 'missing' });
  assert.deepEqual(analyzeRow(makePara('☆0000☆☆こんにちは', '  ')), { kind: 'missing' });
});

test('analyzeRow: 译文照抄原文 → placeholder', () => {
  assert.deepEqual(analyzeRow(makePara('☆0000☆☆こんにちは', 'こんにちは')), { kind: 'placeholder' });
});

test('analyzeRow: 长度比异常 → ratio', () => {
  const short = analyzeRow(makePara('☆0000☆☆今日はいい天気ですね、一緒に散歩しましょう', '嗯'));
  assert.equal(short.kind, 'ratio', '超短译文(省译)判可疑');
  const long = analyzeRow(makePara('☆0000☆☆短い', '短い短い短い'.repeat(20)));
  assert.equal(long.kind, 'ratio', '超长译文(扩写)判可疑');
});

test('analyzeRow: 正常译文 → null;NAME 行排除', () => {
  assert.equal(analyzeRow(makePara('☆0000☆☆こんにちは', '你好')), null);
  assert.equal(analyzeRow(makePara('☆NAME|2☆ティナ', '')), null, 'NAME 不判定漏翻');
  assert.equal(analyzeRow(makePara('☆NAME|2☆ティナ', 'ティナ')), null, 'NAME 不判定占位');
});

test('analyzeRows: 汇总三类并排除 NAME,条目含预览', () => {
  model.setParas([
    makePara('☆0000☆☆こんにちは', '你好'),
    makePara('☆0001☆☆さようなら', ''),
    makePara('☆0002☆☆おやすみ', 'おやすみ'),
    makePara('☆NAME|4☆ぼっち'),
  ]);
  const a = analyzeRows();
  assert.ok(a.missing.some(x => x.i === 1));
  assert.ok(a.placeholder.some(x => x.i === 2));
  assert.ok(a.missing.every(x => x.i !== 3) && a.placeholder.every(x => x.i !== 3), 'NAME 不入清单');
  assert.equal(a.total, a.missing.length + a.placeholder.length + a.ratio.length);
  const m = a.missing.find(x => x.i === 1);
  assert.ok(m.origPreview !== undefined && m.transPreview !== undefined, '清单项带预览');
});
