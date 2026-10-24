// fileguard.js 纯逻辑测试 — node:test + node:assert
// 覆盖: 指纹归一化 / 同内容判定 / 四种情形判定 / 冲突文案 / 选项顺序 / 写盘结果摘要。
// 重点锁住两条安全属性：**默认不覆盖**、**取不到状态不谎报"已变"**。
// 运行: node --test tests/fileguard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICTS, CONFLICT_ACTIONS,
  normalizeStat, sameStat, compareStat,
  conflictMessage, conflictChoices, describeWriteResult,
} from '../src/fileguard.js';

const stat = (o = {}) => ({ exists: true, size: 100, mtimeMs: 1000, hash: 'abc', ...o });

/* ---------------- 归一化 ---------------- */

test('normalizeStat: 保留有效字段，丢弃坏字段', () => {
  assert.deepEqual(normalizeStat({ exists: true, size: 5, mtimeMs: 9, hash: 'h' }),
    { exists: true, size: 5, mtimeMs: 9, hash: 'h' });
  // 类型不对 = 当作没有这个维度
  assert.deepEqual(normalizeStat({ exists: true, size: 'big', mtimeMs: 9 }),
    { exists: true, mtimeMs: 9 });
  assert.equal(normalizeStat({ hash: '' }), null, '空散列等于没有');
  assert.equal(normalizeStat(null), null);
  assert.equal(normalizeStat('x'), null);
  assert.equal(normalizeStat({}), null);
});

test('normalizeStat: exists=false 是有效信息，不能被当成空对象丢掉', () => {
  assert.deepEqual(normalizeStat({ exists: false }), { exists: false });
});

/* ---------------- 同内容判定 ---------------- */

test('sameStat: 双方都有散列时以散列为准', () => {
  // mtime 变了但内容一样（外部工具"重新保存但内容未变"）→ 视为没变
  assert.equal(sameStat(stat({ mtimeMs: 1 }), stat({ mtimeMs: 2 })), true);
  assert.equal(sameStat(stat({ hash: 'a' }), stat({ hash: 'b' })), false);
});

test('sameStat: 无散列时退化为大小+时间', () => {
  const a = { exists: true, size: 10, mtimeMs: 100 };
  const b = { exists: true, size: 10, mtimeMs: 100 };
  assert.equal(sameStat(a, b), true);
  assert.equal(sameStat(a, { ...b, size: 11 }), false);
  assert.equal(sameStat(a, { ...b, mtimeMs: 101 }), false);
});

test('sameStat: 缺维度不否决（避免误报"被改过"）', () => {
  // 只有 size 可比，且相同 → 认为没变
  assert.equal(sameStat({ exists: true, size: 10 }, { exists: true, size: 10 }), true);
  // 时间和大小都拿不到 → 无从判断，不谎报变化
  assert.equal(sameStat({ exists: true }, { exists: true }), true);
});

test('sameStat: 存在性不同即不同', () => {
  assert.equal(sameStat(stat(), { exists: false }), false);
  assert.equal(sameStat({ exists: false }, { exists: false }), true);
});

test('sameStat: 任一边无效 → 返回 false（由 compareStat 归为未知）', () => {
  assert.equal(sameStat(null, stat()), false);
  assert.equal(sameStat(stat(), null), false);
});

/* ---------------- 情形判定 ---------------- */

test('compareStat: 没变 → SAME 且不带理由（不该弹提示）', () => {
  const r = compareStat(stat(), stat());
  assert.equal(r.verdict, VERDICTS.SAME);
  assert.equal(r.changed, false);
  assert.equal(r.reason, '');
});

test('compareStat: 内容变了 → CHANGED', () => {
  const r = compareStat(stat({ hash: 'a' }), stat({ hash: 'b' }));
  assert.equal(r.verdict, VERDICTS.CHANGED);
  assert.equal(r.changed, true);
  assert.match(r.reason, /被别的程序改过/);
});

test('compareStat: 文件消失 → MISSING（保存会重建，必须说清）', () => {
  const r = compareStat(stat(), { exists: false });
  assert.equal(r.verdict, VERDICTS.MISSING);
  assert.equal(r.changed, true);
  assert.match(r.reason, /不存在/);
});

test('compareStat: 路径上出现新文件 → APPEARED（保存会覆盖它）', () => {
  const r = compareStat({ exists: false }, stat());
  assert.equal(r.verdict, VERDICTS.APPEARED);
  assert.equal(r.changed, true);
  assert.match(r.reason, /出现了新文件/);
});

test('compareStat: 两边都不存在 → 没变化（新文件首次保存的正常路径）', () => {
  const r = compareStat({ exists: false }, { exists: false });
  assert.equal(r.verdict, VERDICTS.SAME);
  assert.equal(r.changed, false);
});

test('compareStat: 无基线 → UNKNOWN 但不阻断保存（浏览器版没有指纹）', () => {
  const r = compareStat(null, stat());
  assert.equal(r.verdict, VERDICTS.UNKNOWN);
  assert.equal(r.changed, false, '未知不该当成"被改过"而挡住保存');
  assert.match(r.reason, /无法判断/);
});

test('compareStat: 取不到当前状态 → UNKNOWN 也不阻断', () => {
  const r = compareStat(stat(), null);
  assert.equal(r.verdict, VERDICTS.UNKNOWN);
  assert.equal(r.changed, false);
});

/* ---------------- 冲突文案与选项 ---------------- */

test('conflictMessage: 三种情形都说清"会丢什么"', () => {
  assert.match(conflictMessage('a.ks', VERDICTS.CHANGED), /整份覆盖/);
  assert.match(conflictMessage('a.ks', VERDICTS.CHANGED), /丢/);
  assert.match(conflictMessage('a.ks', VERDICTS.MISSING), /重新创建/);
  assert.match(conflictMessage('a.ks', VERDICTS.APPEARED), /覆盖掉/);
  // 文件名要出现在文案里，用户才知道是哪个文件出问题
  assert.match(conflictMessage('chapter_01.ks', VERDICTS.CHANGED), /chapter_01\.ks/);
});

test('conflictMessage: 缺文件名时有兜底称呼', () => {
  assert.match(conflictMessage('', VERDICTS.CHANGED), /当前文件/);
  assert.match(conflictMessage(null, VERDICTS.CHANGED), /当前文件/);
});

test('conflictChoices: 另存为排第一且是默认（安全属性）', () => {
  const list = conflictChoices();
  assert.equal(list[0].id, CONFLICT_ACTIONS.SAVE_AS);
  // 覆盖不能是默认项 —— 这是"默认不丢数据"的硬要求
  assert.notEqual(list[0].id, CONFLICT_ACTIONS.OVERWRITE);
  assert.equal(list.length, 3);
  // 三个选项都要有解释，否则用户看不懂后果
  for (const c of list) assert.ok(c.hint && c.hint.length > 0, c.id + ' 缺少说明');
});

test('conflictChoices: 字段名是 id —— showChoice 按 id 认选项（曾用 action 导致空对话框）', () => {
  // 这条锁的是模块间的字段契约：conflictChoices 的返回值直接喂给 modals.showChoice，
  // 而 showChoice 过滤条件是 `c && c.id`。字段名写成 action 会让三个按钮全部消失
  // ——用户在"文件被外部改过"时看到一个空对话框，比不弹窗更糟。
  for (const c of conflictChoices()){
    assert.equal(typeof c.id, 'string');
    assert.ok(c.id.length > 0);
    assert.equal(c.action, undefined, '不该再暴露 action 字段名');
  }
});

test('conflictChoices: 覆盖按钮带 danger 标记（视觉上区别于安全项）', () => {
  const overwrite = conflictChoices().find(c => c.id === CONFLICT_ACTIONS.OVERWRITE);
  assert.equal(overwrite.danger, true);
  const saveAs = conflictChoices().find(c => c.id === CONFLICT_ACTIONS.SAVE_AS);
  assert.notEqual(saveAs.danger, true, '安全项不该是危险样式');
});

test('CONFLICT_ACTIONS: 取值稳定（UI 与单测共用同一份字面量）', () => {
  assert.equal(CONFLICT_ACTIONS.SAVE_AS, 'saveAs');
  assert.equal(CONFLICT_ACTIONS.OVERWRITE, 'overwrite');
  assert.equal(CONFLICT_ACTIONS.CANCEL, 'cancel');
});

/* ---------------- 写盘结果摘要 ---------------- */

test('describeWriteResult: 一切正常时不报警告', () => {
  const r = describeWriteResult({ atomic: true, backup: 'created', encoding: 'utf-8' }, 'C:/a.ks');
  assert.equal(r.warning, false);
  assert.match(r.text, /已保存/);
  assert.match(r.text, /C:\/a\.ks/);
  // UTF-8 是默认，不必占用提示行
  assert.doesNotMatch(r.text, /编码/);
});

test('describeWriteResult: 非 UTF-8 编码会写进提示（让用户知道存成了什么）', () => {
  const r = describeWriteResult({ atomic: true, backup: 'created', encoding: 'shift-jis' }, 'C:/a.ks');
  assert.match(r.text, /shift-jis/);
});

test('describeWriteResult: 备份失败必须显著提示并给出补救路径', () => {
  const r = describeWriteResult({ atomic: true, backup: 'failed', backupError: '磁盘满' }, 'C:/a.ks');
  assert.equal(r.warning, true);
  assert.match(r.text, /备份失败/);
  assert.match(r.text, /磁盘满/);
  assert.match(r.text, /历史/, '要指向还能找回旧版本的地方');
});

test('describeWriteResult: 非原子回退也要提示（可能留下不完整文件）', () => {
  const r = describeWriteResult({ atomic: false, atomicReason: '替换失败(占用)', backup: 'exists' }, 'C:/a.ks');
  assert.equal(r.warning, true);
  assert.match(r.text, /不是原子替换/);
  assert.match(r.text, /替换失败/);
});

test('describeWriteResult: 空/异常输入不抛错', () => {
  assert.doesNotThrow(() => describeWriteResult(null, 'x'));
  assert.doesNotThrow(() => describeWriteResult(undefined, undefined));
  assert.equal(describeWriteResult({}, 'x').warning, false);
});
