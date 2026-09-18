// nav.test.mjs — 逐行导航的落点计算
//
// Enter / Tab 换行是 Galweave 的核心交互，落点算错会直接打乱翻译节奏，
// 所以这里逐个边界都锁死：首尾段、空行上、目标段落缺译文行、选区碰到原文行。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLines } from '../src/lineparse.js';
import { paraIndexAtLine, paraSpan, navTarget, selectionTouchesOrig } from '../src/nav.js';

const P = (text) => parseLines(text);

// 0 ☆0001…  1 ★0001…  2 空  3 ☆0002…  4 ★0002…  5 空  6 ☆0003…（无译文行）
const MIXED = [
  '☆0001☆藍☆「あ」', '★0001★蓝★「啊」', '',
  '☆0002☆藍☆「い」', '★0002★蓝★「咦」', '',
  '☆0003☆藍☆「う」', '',
].join('\n');

const NAMES = [
  '☆NAME|1☆李四', '',
  '☆0001☆藍☆「あ」', '★0001★蓝★「啊」', '',
].join('\n');

/* ---------------- 定位 ---------------- */

test('paraIndexAtLine：原文行、译文行都算在该段内，空行不算', () => {
  const p = P(MIXED);
  assert.equal(paraIndexAtLine(p, 0), 0);
  assert.equal(paraIndexAtLine(p, 1), 0, '译文行属于同一段');
  assert.equal(paraIndexAtLine(p, 2), -1, '空行不属于任何段');
  assert.equal(paraIndexAtLine(p, 3), 1);
  assert.equal(paraIndexAtLine(p, 4), 1);
  assert.equal(paraIndexAtLine(p, 6), 2);
  assert.equal(paraIndexAtLine(p, 999), -1, '越界');
});

test('paraSpan：覆盖原文行到译文行；有无译文行都对', () => {
  const p = P(MIXED);
  assert.deepEqual(paraSpan(p.paras[0]), [0, 1]);
  assert.deepEqual(paraSpan(p.paras[2]), [6, 6], '没有译文行时就是原文行自己');
});

/* ---------------- 下一段 / 上一段 ---------------- */

test('下一段：光标在原文行时落到下一段的译文行', () => {
  const t = navTarget(P(MIXED), 0, 1);
  assert.equal(t.line, 4, '应落到第 2 段的译文行');
  assert.equal(t.needCreate, false);
  assert.equal(t.para.id, '0002');
});

test('下一段：光标在译文行时同样落到下一段的译文行', () => {
  const t = navTarget(P(MIXED), 1, 1);
  assert.equal(t.line, 4);
});

test('下一段：目标段落没有译文行时标记需要补行', () => {
  const t = navTarget(P(MIXED), 4, 1);
  assert.equal(t.line, 6, '落点是原文行');
  assert.equal(t.needCreate, true, '调用方据此决定补行');
  assert.equal(t.para.id, '0003');
});

test('下一段：已在最后一段返回 null', () => {
  assert.equal(navTarget(P(MIXED), 6, 1), null);
});

test('上一段：从第一段落再往前返回 null', () => {
  assert.equal(navTarget(P(MIXED), 0, -1), null);
  assert.equal(navTarget(P(MIXED), 1, -1), null);
});

test('上一段：落到上一段的译文行', () => {
  const t = navTarget(P(MIXED), 4, -1);
  assert.equal(t.line, 1);
  assert.equal(t.needCreate, false);
});

test('光标在空行上：向后取最近的一段', () => {
  const t = navTarget(P(MIXED), 2, 1);
  assert.equal(t.para.id, '0002');
  assert.equal(t.line, 4);
});

test('光标在空行上：向前取最近的一段', () => {
  const t = navTarget(P(MIXED), 2, -1);
  assert.equal(t.para.id, '0001');
  assert.equal(t.line, 1);
});

test('光标在文件头空行上向后：取第一段', () => {
  const p = P('\n☆0001☆藍☆「あ」\n★0001★蓝★「啊」');
  const t = navTarget(p, 0, 1);
  assert.equal(t.para.id, '0001');
  assert.equal(t.line, 2);
});

test('人名条目也参与导航（它就是一段）', () => {
  // 从人名条目往下走：目标应是它后面那段对话，落点为对话的译文行
  const t = navTarget(P(NAMES), 0, 1);
  assert.equal(t.para.kind, 'dialogue');
  assert.equal(t.line, 3);
  assert.equal(t.needCreate, false);
});

test('没有段落时返回 null；只有一段时前后都没有落点', () => {
  assert.equal(navTarget(P(''), 0, 1), null);
  // 注意：parseLines 对无标记文本照样会分段（只是识别不出前缀），
  // 所以"不是脚本"这件事由扩展侧的 ruleExplains 拦，不在这个纯函数里
  assert.equal(navTarget(P('普通文本'), 0, 1), null, '只有一段，后面没有了');
  assert.equal(navTarget(P('普通文本'), 0, -1), null, '只有一段，前面没有了');
});

/* ---------------- 选区是否碰到原文行（锁定用） ---------------- */

test('selectionTouchesOrig：覆盖到原文行返回 true', () => {
  const p = P(MIXED);
  assert.equal(selectionTouchesOrig(p, 0, 0), true, '原文行本身');
  assert.equal(selectionTouchesOrig(p, 0, 1), true, '跨到译文行也算碰到原文');
  assert.equal(selectionTouchesOrig(p, 3, 4), true);
});

test('selectionTouchesOrig：只覆盖译文行返回 false', () => {
  const p = P(MIXED);
  assert.equal(selectionTouchesOrig(p, 1, 1), false);
  assert.equal(selectionTouchesOrig(p, 4, 4), false);
});

test('selectionTouchesOrig：只覆盖空行返回 false', () => {
  const p = P(MIXED);
  assert.equal(selectionTouchesOrig(p, 2, 2), false);
});

test('selectionTouchesOrig：起点大于终点也能正确判断（反向选区）', () => {
  const p = P(MIXED);
  assert.equal(selectionTouchesOrig(p, 1, 0), true, '反向选到原文行');
});

/* ---------------- 真实样本上不越界 ---------------- */

test('真实样本：从任意行出发的下一段/上一段落点都合法', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { pickRule, BUILTIN_RULES, normalizeRule } = await import('../src/rules.js');

  const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.resolve(extDir, '../test text');
  if (!fs.existsSync(dir)) { t.skip('样本目录不存在'); return; }

  const lib = BUILTIN_RULES.slice();
  for (const n of fs.readdirSync(path.join(extDir, 'rules')).filter(f => f.endsWith('.json'))) {
    lib.push(normalizeRule(JSON.parse(fs.readFileSync(path.join(extDir, 'rules', n), 'utf8')), path.basename(n, '.json')));
  }

  let checked = 0;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.txt'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const picked = pickRule(text, lib);
    if (!picked) continue;
    const parsed = P(text, picked.rule.conf);
    const lineCount = text.split(/\r?\n/).length;

    for (const dir2 of [1, -1]) {
      for (let i = 0; i < Math.min(lineCount, 40); i++) {
        const t2 = navTarget(parsed, i, dir2);
        if (!t2) continue;
        assert.ok(t2.line >= 0 && t2.line < lineCount, `${f} 行${i} dir${dir2}: 落点越界 ${t2.line}`);
        const role = parsed.lines[t2.line].role;
        assert.ok(role === 'orig' || role === 'trans',
          `${f} 行${i} dir${dir2}: 落点应是原文行或译文行，实际 ${role}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0, '应至少检查一个落点');
  t.diagnostic(`检查了 ${checked} 个落点`);
});
