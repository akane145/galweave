import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, fuzzyScore, rankCommands, clampIndex, COMMANDS } from '../src/palette.js';

test('normalize：转小写并去掉所有空白', () => {
  assert.equal(normalize('Ctrl+Shift+P'), 'ctrl+shift+p');
  assert.equal(normalize(' 导入 文本 '), '导入文本');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

test('fuzzyScore：空查询返回 0（由调用方返回全部）', () => {
  assert.equal(fuzzyScore('', '导入文本'), 0);
  assert.equal(fuzzyScore('   ', '导入文本'), 0);
});

test('fuzzyScore：命中返回正数，未命中返回 -1', () => {
  assert.ok(fuzzyScore('导入', '导入文本') > 0);
  assert.equal(fuzzyScore('xyz', '导入文本'), -1);
  assert.equal(fuzzyScore('abc', ''), -1);
});

test('fuzzyScore：子序列匹配（字符不必连续但顺序要对）', () => {
  assert.ok(fuzzyScore('术表', '导入术语表') > 0);
  assert.equal(fuzzyScore('表术', '导入术语表'), -1); // 顺序颠倒 → 不匹配
});

test('fuzzyScore：连续匹配得分高于跳字匹配', () => {
  const t = 'abcdef';
  assert.ok(fuzzyScore('abc', t) > fuzzyScore('ace', t));
  assert.ok(fuzzyScore('ace', t) > 0); // 跳字也是合法匹配，只是分低
});

test('fuzzyScore：词首（分隔符后）命中额外加权', () => {
  // 'b' 在 'a、b' 里位于分隔符后 → 加权；在 'xab' 里位于普通字符后 → 不加权
  assert.ok(fuzzyScore('b', 'a、b') > fuzzyScore('b', 'xab'));
});

test('rankCommands：空查询返回全部并保持声明顺序', () => {
  const out = rankCommands('', COMMANDS);
  assert.equal(out.length, COMMANDS.length);
  assert.deepEqual(out.map(c => c.id), COMMANDS.map(c => c.id));
  assert.ok(out.every(c => c.score === 0));
});

test('rankCommands：过滤掉不匹配项，命中项按分数降序', () => {
  const cmds = [
    { id: 'a', title: '导入文本' },
    { id: 'b', title: '导出术语表' },
    { id: 'c', title: '撤销' },
  ];
  const out = rankCommands('导入', cmds);
  assert.deepEqual(out.map(c => c.id), ['a']); // 只有 a 含"导入"

  const out2 = rankCommands('导出', cmds);
  assert.deepEqual(out2.map(c => c.id), ['b']);

  const out3 = rankCommands('zzz', cmds);
  assert.equal(out3.length, 0);
});

test('rankCommands：同分时按声明顺序稳定排列', () => {
  const cmds = [
    { id: 'x', title: '甲' },
    { id: 'y', title: '乙' },
  ];
  // 两者都能匹配"翻译"以外的公共查询，用单字各自命中
  const out = rankCommands('甲乙', cmds);
  assert.equal(out.length, 0); // 顺序不成立时都过滤掉，先确认边界
  const out2 = rankCommands('', cmds);
  assert.deepEqual(out2.map(c => c.id), ['x', 'y']);
});

test('rankCommands：命令表真实场景下能按关键词收敛', () => {
  const out = rankCommands('术语', COMMANDS);
  assert.ok(out.length >= 3);
  assert.ok(out.every(c => c.title.includes('术语') || c.title.includes('词')));
  // 分数非递增即有序
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
});

test('clampIndex：正常区间内原样返回', () => {
  assert.equal(clampIndex(0, 5), 0);
  assert.equal(clampIndex(3, 5), 3);
  assert.equal(clampIndex(4, 5), 4);
});

test('clampIndex：越界循环（上溢回 0，下溢到末位）', () => {
  assert.equal(clampIndex(5, 5), 0);
  assert.equal(clampIndex(-1, 5), 4);
  assert.equal(clampIndex(6, 5), 1);
});

test('clampIndex：长度非法或输入非法一律返回 0', () => {
  assert.equal(clampIndex(3, 0), 0);
  assert.equal(clampIndex(3, -2), 0);
  assert.equal(clampIndex(NaN, 5), 0);
  assert.equal(clampIndex(undefined, 5), 0);
  assert.equal(clampIndex(0, NaN), 0);
});

test('COMMANDS：结构完整且 id 唯一', () => {
  assert.ok(COMMANDS.length > 0);
  const ids = new Set();
  for (const c of COMMANDS) {
    assert.ok(c.id, `命令缺少 id: ${JSON.stringify(c)}`);
    assert.ok(c.title, `命令缺少 title: ${c.id}`);
    assert.ok(c.group, `命令缺少 group: ${c.id}`);
    assert.equal(ids.has(c.id), false, `命令 id 重复: ${c.id}`);
    ids.add(c.id);
  }
});

test('COMMANDS：hint 若存在必须是非空字符串', () => {
  for (const c of COMMANDS) {
    if (c.hint !== undefined) {
      assert.equal(typeof c.hint, 'string');
      assert.ok(c.hint.length > 0, `${c.id} 的 hint 为空串`);
    }
  }
});
