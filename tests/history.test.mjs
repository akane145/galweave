// history.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/history.test.mjs
// 注：只测纯逻辑（命名 / 快照 / 差异 / 补丁 / 裁剪），不碰 listSnapshots 等 IO。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_VERSION, HISTORY_MAX, HISTORY_MIN_INTERVAL_MS,
  snapshotId, snapshotTimeLabel, snapshotDirName, snapshotRelPath,
  buildSnapshot, parseSnapshot, snapshotStats,
  diffSnapshot, patchFromSnapshot, planPrune, shouldSnapshot, parseIdToTime, listFromDirEntries,
} from '../src/history.js';

/** 普通行 */
const L = (orig, translation, extra = {}) => ({ isName: false, brackets: false, orig, content: orig, translation, nameTr: orig, ...extra });
/** NAME 行 */
const N = (orig, nameTr, extra = {}) => ({ isName: true, orig, name: orig, content: orig, translation: '', nameTr, ...extra });

/* ---------------- 命名 ---------------- */

test('snapshotId: 可排序的时间串（文件名安全）', () => {
  const t = new Date(2026, 8, 10, 21, 30, 5).getTime();
  assert.equal(snapshotId(t), '20260910-213005');
  assert.equal(snapshotId(NaN) !== '', true);   // 非法时间回退当前时间，不抛错
});

test('snapshotTimeLabel: id → 可读时间；非法原样返回', () => {
  assert.equal(snapshotTimeLabel('20260910-213005'), '2026-09-10 21:30:05');
  assert.equal(snapshotTimeLabel('乱码'), '乱码');
  assert.equal(snapshotTimeLabel(null), '');
});

test('parseIdToTime: 与 snapshotId 互逆', () => {
  const t = new Date(2026, 8, 10, 21, 30, 5).getTime();
  assert.equal(parseIdToTime(snapshotId(t)), t);
  assert.equal(parseIdToTime('乱码'), 0);
});

test('snapshotDirName / snapshotRelPath: 去路径分隔与非法字符', () => {
  assert.equal(snapshotDirName('story_01.ks'), 'story_01.ks');
  assert.equal(snapshotDirName('a/b*c?.ks'), 'a_b_c_.ks');
  assert.equal(snapshotDirName(''), 'unnamed');
  assert.equal(snapshotRelPath('story.ks', '20260910-213005'), 'history/story.ks/20260910-213005.json');
});

/* ---------------- 构造 ---------------- */

test('buildSnapshot: 只存有内容的行（空译文 + 未改名一律不存）', () => {
  const snap = buildSnapshot([
    L('おはよう', '早上好'),
    L('未訳の行', ''),
    N('アリス', '爱丽丝'),
    N('ボブ', 'ボブ'),          // 名字未改 → 不存
    null,
  ], 1000, 'save');
  assert.equal(snap.version, HISTORY_VERSION);
  assert.equal(snap.at, 1000);
  assert.equal(snap.reason, 'save');
  assert.equal(snap.total, 5);
  assert.deepEqual(snap.rows.map(r => r[0]), ['おはよう', 'アリス']);
  assert.deepEqual(snap.rows[0], ['おはよう', '早上好', '']);
  assert.deepEqual(snap.rows[1], ['アリス', '', '爱丽丝']);
});

test('buildSnapshot: 普通行的译名改过时一起存（恢复时连名字一起回滚）', () => {
  const snap = buildSnapshot([L('やあ', '呀', { nameTr: '爱丽丝' })], 1, 'x');
  assert.deepEqual(snap.rows[0], ['やあ', '呀', '爱丽丝']);
});

test('buildSnapshot: brackets 行的译文按 transValue 剥括号后存', () => {
  const snap = buildSnapshot([{ isName: false, brackets: true, orig: 'o', content: 'o', translation: '「呀」', nameTr: 'o' }], 1, 'x');
  assert.equal(snap.rows[0][1], '呀');
});

test('parseSnapshot: 接受对象/字符串，损坏返回 null', () => {
  const snap = buildSnapshot([L('a', '甲')], 5, 'save');
  const viaJson = parseSnapshot(JSON.stringify({ version: HISTORY_VERSION, at: 5, reason: 'save', total: 1, rows: [['a', '甲', '']] }));
  assert.deepEqual(viaJson, snap);
  assert.equal(parseSnapshot(null), null);
  assert.equal(parseSnapshot('{坏'), null);
  assert.equal(parseSnapshot({ version: 2, rows: [] }), null);
  assert.equal(parseSnapshot({ version: 1 }), null);           // 缺 rows
  // 行内非法项被丢弃，合法项保留
  assert.deepEqual(parseSnapshot({ version: 1, rows: ['x', [1, 2], ['ok', 'ok', 3]] }).rows, [['ok', 'ok', '']]);
});

test('snapshotStats: 统计已译 / 译名 / 存储行数', () => {
  const snap = buildSnapshot([L('a', '甲'), L('b', ''), N('アリス', '爱丽丝')], 1, 'x');
  const st = snapshotStats(snap);
  assert.equal(st.total, 3);
  assert.equal(st.translated, 1);
  assert.equal(st.names, 1);
  assert.equal(st.stored, 2);
});

/* ---------------- 差异 / 补丁 ---------------- */

test('diffSnapshot: 只报真正变化的行，并区分"会被清空"的行', () => {
  const snap = buildSnapshot([L('a', '甲'), L('b', '乙')], 1, 'x');
  // 当前：a 改成"甲甲"，b 被清空，c 是新翻译的行（快照里没有 → 当时为空）
  const cur = [L('a', '甲甲'), L('b', ''), L('c', '丙')];
  const d = diffSnapshot(snap, cur);
  assert.deepEqual(d.changed.map(c => c.i), [0, 1]);
  assert.equal(d.changed[1].before, '乙');
  assert.equal(d.changed[1].after, '');
  assert.equal(d.willClear, 0);
  assert.equal(d.wasEmpty, 1);
});

test('diffSnapshot: 当前有字而快照为空 → willClear 计数（恢复会抹掉）', () => {
  const snap = buildSnapshot([L('a', '甲'), L('b', '')], 1, 'x');   // b 没进快照
  const d = diffSnapshot(snap, [L('a', '甲'), L('b', '后来补的')]);
  assert.equal(d.wasEmpty, 1);
  assert.equal(d.changed.length, 0, '缺席不算 changed');
});

test('patchFromSnapshot: 缺席行被清空（有意行为），brackets 行按行类型包回括号', () => {
  const snap = buildSnapshot([L('a', '甲'), { isName: false, brackets: true, orig: 'b', content: 'b', translation: '「乙」', nameTr: 'b' }], 1, 'x');
  const cur = [L('a', '改过了'), L('b', '改过了', { brackets: true }), L('c', '新增的')];
  const patch = patchFromSnapshot(snap, cur);
  const by = new Map(patch.map(p => [p.i, p]));
  assert.equal(by.get(0).translation, '甲');              // 还原
  assert.equal(by.get(1).translation, '「乙」');           // 括号按行类型包回
  assert.equal(by.get(2).translation, '');                // 快照缺席 → 清空
});

test('patchFromSnapshot: 已经是该版本 → 空补丁（幂等）', () => {
  const paras = [L('a', '甲')];
  const snap = buildSnapshot(paras, 1, 'x');
  assert.deepEqual(patchFromSnapshot(snap, paras), []);
});

test('patchFromSnapshot / diffSnapshot: 重复 orig 按出现次数对齐，不互相覆盖', () => {
  // 同一 orig 出现两次，译文不同 —— 靠"第几次出现"配对，而不是同一份数据写两遍
  const dup = [
    { isName: false, brackets: false, orig: 'SAME', content: 'SAME', translation: '第一', nameTr: 'SAME' },
    { isName: false, brackets: false, orig: 'SAME', content: 'SAME', translation: '第二', nameTr: 'SAME' },
  ];
  const snap = buildSnapshot(dup, 1, 'x');
  assert.equal(snap.rows.length, 2);

  const changed = [
    { isName: false, brackets: false, orig: 'SAME', content: 'SAME', translation: '改了', nameTr: 'SAME' },
    { isName: false, brackets: false, orig: 'SAME', content: 'SAME', translation: '第二', nameTr: 'SAME' },
  ];
  const d = diffSnapshot(snap, changed);
  assert.deepEqual(d.changed.map(c => c.i), [0]);
  assert.equal(d.changed[0].before, '第一');

  const patch = patchFromSnapshot(snap, changed);
  assert.equal(patch.length, 1);
  assert.equal(patch[0].translation, '第一');
});

test('patchFromSnapshot: NAME 行只动译名，快照未记名字时保持现状', () => {
  const snap = buildSnapshot([N('アリス', '爱丽丝')], 1, 'x');
  const cur = [N('アリス', '艾丽丝')];
  const patch = patchFromSnapshot(snap, cur);
  assert.deepEqual(patch, [{ i: 0, translation: '', nameTr: '爱丽丝' }]);

  // 快照里名字未改（缺席）→ 不动
  const snap2 = buildSnapshot([N('ボブ', 'ボブ')], 1, 'x');
  assert.deepEqual(patchFromSnapshot(snap2, [N('ボブ', '鲍勃')]), []);
});

/* ---------------- 裁剪 / 节流 ---------------- */

test('planPrune: 保留最新 max 份，其余进 remove', () => {
  const entries = [
    { id: 'a', at: 1 }, { id: 'b', at: 3 }, { id: 'c', at: 2 },
  ];
  const { keep, remove } = planPrune(entries, 2);
  assert.deepEqual(keep.map(e => e.id), ['b', 'c']);
  assert.deepEqual(remove.map(e => e.id), ['a']);
  assert.equal(planPrune(entries, 10).remove.length, 0);
  assert.equal(HISTORY_MAX, 20);
  assert.equal(planPrune([], 3).keep.length, 0);
});

test('shouldSnapshot: 距上次太近则跳过；reason=force 总是写', () => {
  const now = 1_000_000;
  assert.equal(shouldSnapshot(0, now), true);                       // 没有历史 → 写
  assert.equal(shouldSnapshot(now - HISTORY_MIN_INTERVAL_MS, now), true);   // 刚好到间隔
  assert.equal(shouldSnapshot(now - 1000, now), false);             // 太近
  assert.equal(shouldSnapshot(now - 1000, now, 'force'), true);      // 强制写
});

test('listFromDirEntries: 只认 <id>.json，按时间降序；忽略目录与其它文件', () => {
  const list = listFromDirEntries([
    { kind: 'file', name: '20260910-213005.json', path: 'p1' },
    { kind: 'file', name: '20260909-100000.json', path: 'p2' },
    { kind: 'file', name: 'notes.txt', path: 'p3' },
    { kind: 'directory', name: 'x.json', path: 'p4' },
    null,
  ]);
  assert.deepEqual(list.map(e => e.id), ['20260910-213005', '20260909-100000']);
});
