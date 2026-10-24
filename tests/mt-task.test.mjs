// mt-task.js 纯逻辑测试 — node:test + node:assert
// 覆盖: 任务状态机 / 停止 / 失败清单 / 只重试失败行 / 迟到结果判定 / 计数与文案。
// 重点锁住三条需求验收点：
//   ① 运行途中停止，已完成译文仍保留；
//   ② 重试只请求失败行；
//   ③ 等待期间人工修改的译文不会被迟到结果覆盖。
// 运行: node --test tests/mt-task.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROW_STATE,
  createTask, isStopped, beginRow, markDone, markFailed, markEdited, settleStale,
  requestStop, stateOf, pendingIndexes, retryIndexes, failureList,
  summarize, progressLabel, summaryText, retryTask, createEditTracker,
} from '../src/mt-task.js';

test('createTask: 记录全部目标行，初始都待处理', () => {
  const t = createTask([1, 2, 3]);
  assert.deepEqual(t.all, [1, 2, 3]);
  assert.deepEqual(pendingIndexes(t), [1, 2, 3]);
  assert.equal(t.stopped, false);
  assert.equal(summarize(t).pending, 3);
});

test('createTask: 过滤非整数行号，容忍空/异常输入', () => {
  assert.deepEqual(createTask([1, 'x', null, 2.5, 3]).all, [1, 3]);
  assert.deepEqual(createTask([]).all, []);
  assert.deepEqual(createTask(null).all, []);
  assert.equal(summarize(null).total, 0);
});

test('markDone / markFailed: 状态与计数正确', () => {
  const t = createTask([0, 1, 2]);
  markDone(t, 0);
  markFailed(t, 1, new Error('连接失败'));
  const s = summarize(t);
  assert.equal(s.done, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.pending, 1, '未处理的行仍是 pending');
  assert.equal(stateOf(t, 0), ROW_STATE.DONE);
  assert.equal(stateOf(t, 1), ROW_STATE.FAILED);
});

test('markFailed: 错误原因进清单，字符串与 Error 都能收', () => {
  const t = createTask([0, 1]);
  markFailed(t, 0, new Error('超时'));
  markFailed(t, 1, '服务未启动');
  const list = failureList(t);
  assert.equal(list.length, 2);
  assert.equal(list.find(x => x.i === 0).err, '超时');
  assert.equal(list.find(x => x.i === 1).err, '服务未启动');
});

test('markDone: 清掉该行之前的失败原因（重试成功后不该还留着错）', () => {
  const t = createTask([0]);
  markFailed(t, 0, 'first fail');
  assert.equal(failureList(t).length, 1);
  markDone(t, 0);
  assert.equal(failureList(t).length, 0);
  assert.equal(stateOf(t, 0), ROW_STATE.DONE);
});

test('标记不存在的行 → 返回 false，不静默新建条目', () => {
  const t = createTask([0]);
  assert.equal(markDone(t, 99), false);
  assert.equal(markFailed(t, 99, 'x'), false);
  assert.equal(markEdited(t, 99), false);
  assert.equal(summarize(t).total, 1);
});

/* ---------------- 停止（验收点 ①） ---------------- */

test('requestStop: 未处理的行标 STOPPED，已完成的行原样保留', () => {
  const t = createTask([0, 1, 2, 3]);
  markDone(t, 0);
  markDone(t, 1);
  beginRow(t, 2, 0);
  requestStop(t);
  assert.equal(isStopped(t), true);
  // 已完成的两行必须还在 —— 这是"停止后保留已完成结果"的硬要求
  assert.deepEqual(t.done, [0, 1]);
  assert.equal(stateOf(t, 0), ROW_STATE.DONE);
  assert.equal(stateOf(t, 1), ROW_STATE.DONE);
  assert.equal(stateOf(t, 2), ROW_STATE.STOPPED);
  assert.equal(stateOf(t, 3), ROW_STATE.STOPPED);
  assert.deepEqual(pendingIndexes(t), []);
});

test('requestStop: 停止不算失败（不污染重试清单）', () => {
  const t = createTask([0, 1, 2]);
  markFailed(t, 0, 'boom');
  requestStop(t);
  const retry = retryIndexes(t);
  assert.deepEqual(retry, [0], '只有真正失败的行进重试清单');
  assert.equal(retry.includes(1), false);
  assert.equal(retry.includes(2), false);
});

test('requestStop: 幂等，空任务与 null 安全', () => {
  const t = createTask([0]);
  requestStop(t);
  requestStop(t);
  assert.equal(stateOf(t, 0), ROW_STATE.STOPPED);
  assert.doesNotThrow(() => requestStop(null));
});

test('停止后 finished 的行不影响，仍能再重试失败行', () => {
  const t = createTask([0, 1]);
  markFailed(t, 0, 'x');
  requestStop(t);
  const t2 = retryTask(t);
  assert.deepEqual(t2.all, [0], '停止后仍可只重试失败行');
  assert.equal(t2.stopped, false, '重试任务本身是全新的、未停止的');
});

/* ---------------- 只重试失败行（验收点 ②） ---------------- */

test('retryIndexes: 只含 failed（不含 done / stopped / edited / pending）', () => {
  const t = createTask([0, 1, 2, 3, 4]);
  markDone(t, 0);
  markFailed(t, 1, 'e1');
  markFailed(t, 2, 'e2');
  markEdited(t, 3);
  requestStop(t);   // 4 → stopped
  assert.deepEqual(retryIndexes(t), [1, 2]);
});

test('retryTask: 新任务只含失败行，标签带「重试」', () => {
  const t = createTask([0, 1, 2], { label: 'chapter_01.ks' });
  markDone(t, 0);
  markFailed(t, 1, 'x');
  markFailed(t, 2, 'y');
  const t2 = retryTask(t);
  assert.deepEqual(t2.all, [1, 2]);
  assert.match(t2.label, /chapter_01\.ks/);
  assert.match(t2.label, /重试/);
  // 新任务初始全 pending
  assert.deepEqual(pendingIndexes(t2), [1, 2]);
});

test('retryTask: 无失败行时得到空任务', () => {
  const t = createTask([0, 1]);
  markDone(t, 0);
  markDone(t, 1);
  assert.deepEqual(retryTask(t).all, []);
});

test('重试里又失败的行还能再重试（同一套状态机，不需要第二套机制）', () => {
  const t = createTask([0, 1]);
  markFailed(t, 0, 'a');
  markFailed(t, 1, 'b');
  const t2 = retryTask(t);
  markDone(t2, 0);
  markFailed(t2, 1, 'still failing');
  const t3 = retryTask(t2);
  assert.deepEqual(t3.all, [1]);
});

/* ---------------- 迟到结果不覆盖人工修改（验收点 ③） ---------------- */

test('settleStale: 版本号没变 → 可以写入', () => {
  const t = createTask([0]);
  const tr = createEditTracker();
  beginRow(t, 0, tr.get(0));       // 发请求前记版本 0
  assert.equal(settleStale(t, 0, tr.get(0)), true);
});

test('settleStale: 等待期间人工改过 → 拒绝写入（不覆盖用户刚打的字）', () => {
  const t = createTask([0]);
  const tr = createEditTracker();
  beginRow(t, 0, tr.get(0));       // 版本 0
  tr.bump(0);                      // 用户自己敲了译文
  assert.equal(settleStale(t, 0, tr.get(0)), false,
    '机翻结果迟到，必须让位给人工输入');
});

test('settleStale: 改了又改回原样仍算人工介入（版本号而非内容比较）', () => {
  const t = createTask([0]);
  const tr = createEditTracker();
  beginRow(t, 0, tr.get(0));
  tr.bump(0);
  tr.bump(0);
  assert.equal(settleStale(t, 0, tr.get(0)), false);
});

test('settleStale: 用户清空译文也算介入（版本号变了就不写）', () => {
  const t = createTask([0]);
  const tr = createEditTracker();
  beginRow(t, 0, tr.get(0));
  tr.bump(0);   // 清空也是一次编辑
  assert.equal(settleStale(t, 0, tr.get(0)), false);
});

test('settleStale: 没记录过版本 → 保守放行（不因台账缺失而卡住翻译）', () => {
  const t = createTask([0]);
  assert.equal(settleStale(t, 0, 0), true);
});

test('settleStale: 多行各自独立判定（相邻行被改不影响本行）', () => {
  const t = createTask([0, 1]);
  const tr = createEditTracker();
  beginRow(t, 0, tr.get(0));
  beginRow(t, 1, tr.get(1));
  tr.bump(1);                       // 只改了第 1 行
  assert.equal(settleStale(t, 0, tr.get(0)), true, '第 0 行没人动，可以写');
  assert.equal(settleStale(t, 1, tr.get(1)), false, '第 1 行被改过，不能写');
});

test('markEdited: 计入"跳过"而不是"失败"，并清掉失败原因', () => {
  const t = createTask([0]);
  markFailed(t, 0, '先失败过');
  markEdited(t, 0);
  assert.equal(stateOf(t, 0), ROW_STATE.EDITED);
  assert.equal(summarize(t).edited, 1);
  assert.equal(summarize(t).failed, 0);
  assert.deepEqual(retryIndexes(t), [], '被人工改过的行不该被重试再覆盖一遍');
});

/* ---------------- 计数与文案 ---------------- */

test('summarize: 各状态计数互斥且合计等于总数', () => {
  const t = createTask([0, 1, 2, 3, 4, 5]);
  markDone(t, 0);
  markFailed(t, 1, 'x');
  markEdited(t, 2);
  requestStop(t);
  const s = summarize(t);
  assert.equal(s.total, 6);
  assert.equal(s.done + s.failed + s.edited + s.stopped + s.pending, s.total,
    '各状态合计必须等于总数（面板与提示共用这份口径）');
  assert.equal(s.done, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.edited, 1);
  assert.equal(s.stopped, 3);
});

test('progressLabel: 有进度数字，失败/停止/跳过各自显式出现', () => {
  const t = createTask([0, 1, 2, 3]);
  markDone(t, 0);
  markFailed(t, 1, 'x');
  const label = progressLabel(t);
  assert.match(label, /1 \/ 4/);
  assert.match(label, /1 失败/);
  assert.equal(progressLabel(createTask([])), '');
  assert.equal(progressLabel(null), '');
});

test('progressLabel: 已跳过的行计入"已处理"，否则进度看着像卡住了', () => {
  const t = createTask([0, 1]);
  markEdited(t, 0);
  assert.match(progressLabel(t), /1 \/ 2/);
  assert.match(progressLabel(t), /已跳过/);
});

test('summaryText: 停止与完成的标题不同，且都列出明细', () => {
  const t = createTask([0, 1, 2]);
  markDone(t, 0);
  markFailed(t, 1, 'x');
  assert.match(summaryText(t), /^批量翻译完成/);
  assert.match(summaryText(t), /机翻 1 行/);
  assert.match(summaryText(t), /失败 1 行/);
  assert.match(summaryText(t), /重试/, '失败时要告诉用户能只重试失败行');

  requestStop(t);
  const stopped = summaryText(t);
  assert.match(stopped, /^已停止机翻/);
  assert.match(stopped, /未处理/, '停止后要说清还有多少行没做');
});

test('summaryText: 带翻译记忆行数，且空任务有兜底文案', () => {
  const t = createTask([0]);
  markDone(t, 0);
  assert.match(summaryText(t, 5), /翻译记忆 5 行/);
  assert.match(summaryText(createTask([])), /没有需要处理的行/);
  assert.doesNotThrow(() => summaryText(null));
});

test('summaryText: 被跳过的人工改动会出现在总结里（用户要知道机翻没碰它）', () => {
  const t = createTask([0]);
  markEdited(t, 0);
  assert.match(summaryText(t), /跳过 1 行/);
});

/* ---------------- 编辑版本号台账 ---------------- */

test('createEditTracker: 未记录为 0，bump 递增，reset/clear 归零', () => {
  const tr = createEditTracker();
  assert.equal(tr.get(3), 0);
  assert.equal(tr.bump(3), 1);
  assert.equal(tr.bump(3), 2);
  assert.equal(tr.get(3), 2);
  tr.reset(3);
  assert.equal(tr.get(3), 0);
  tr.bump(5);
  tr.clear();
  assert.equal(tr.get(5), 0);
});

test('createEditTracker: 各行版本号互不干扰', () => {
  const tr = createEditTracker();
  tr.bump(1);
  tr.bump(1);
  tr.bump(2);
  assert.equal(tr.get(1), 2);
  assert.equal(tr.get(2), 1);
  assert.equal(tr.get(3), 0);
});
