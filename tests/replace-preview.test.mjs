// search-remote 非破坏替换的契约测试 — node:test + node:assert
//
// 本文件只覆盖 **search-remote.js 提供的 deltas 计算契约**（预览与提交共同依赖的
// 底层函数）：非破坏、count、范围规则、边界。
//
// ⚠️ 涉及"提交/撤销/字段边界"的行为断言在 tests/replace-apply.test.mjs，
// 那里只调用生产函数，不再在测试里复制一份 applySelected —— 上一次正是因为
// 测试自写提交逻辑，漏掉了 R1（只勾名字却把译文写回旧值）。
//
// 运行: node --test tests/replace-preview.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { replaceAllInParasDeltas } from '../src/search-remote.js';
import { replaceAllInParas } from '../src/search.js';
import { makePara } from '../src/parsers.js';

/* ---------------- 非破坏性：预览不修改输入 ---------------- */

test('预览计算不修改输入数组（草稿不落地）', () => {
  const paras = [makePara('☆0☆A☆花', '花火爆発'), makePara('☆1☆A☆花', '没有命中')];
  const before = JSON.stringify(paras);
  const r = replaceAllInParasDeltas(paras, '花火', '烟火', 'trans', false);
  assert.equal(r.deltas.length, 1);
  assert.equal(JSON.stringify(paras), before, '预览阶段不改翻译');
});

test('deltas 带 count（逐行"替换 N 处"的来源）', () => {
  const paras = [makePara('☆0☆A☆x', '花花花花')];
  const r = replaceAllInParasDeltas(paras, '花', '草', 'trans', false);
  assert.equal(r.deltas[0].count, 4);
  assert.equal(r.total, 4);
});

test('deltas 同时携带两个字段的预览值（字段边界的判断在提交层）', () => {
  const paras = [makePara('☆0☆A☆x', '花火一')];
  const r = replaceAllInParasDeltas(paras, '花火', '烟火', 'trans', false);
  assert.equal(r.deltas[0].translation, '烟火一');
  assert.equal(typeof r.deltas[0].nameTr, 'string', '未替换字段也带预览时的旧值');
});

/* ---------------- 范围与边界 ---------------- */

test('NAME 范围只改 nameTr，译文不动', () => {
  const paras = [makePara('☆NAME|0☆沙織', '正文不该动')];
  paras[0].nameTr = '沙织';
  const r = replaceAllInParasDeltas(paras, '沙织', '早苗', 'name', false);
  assert.ok(r.deltas.length >= 1);
  assert.equal(r.deltas[0].nameTr, '早苗');
  assert.equal(r.deltas[0].translation, '正文不该动', '译文保持原值');
});

test('译文范围跳过 NAME 行的正文（与 replaceAllInParas 同规则）', () => {
  const mk = () => {
    const p = makePara('☆NAME|0☆沙織', '');
    p.nameTr = '沙織';
    return [p, makePara('☆1☆A☆x', '沙織来了')];
  };
  const a = replaceAllInParasDeltas(mk(), '沙織', '早苗', 'trans', false);
  const b = mk();
  const c = replaceAllInParas(b, '沙織', '早苗', 'trans', false);
  assert.deepEqual(a.deltas.map(d => d.i), [1], 'NAME 行不参与译文替换');
  assert.equal(a.total, c.total);
  assert.equal(b[1].translation, '早苗来了');
});

test('空查找串不产生任何 deltas（且不死循环）', () => {
  const paras = [makePara('☆0☆A☆x', '任意译文')];
  const r = replaceAllInParasDeltas(paras, '', 'Y', 'trans', false);
  assert.deepEqual(r.deltas, []);
  assert.equal(r.total, 0);
});

test('区分大小写选项：勾选只命中大小写一致处，不勾选两处都命中', () => {
  const paras = [makePara('☆0☆A☆x', 'Sakura 与 sakura')];
  const cs = replaceAllInParasDeltas(paras, 'sakura', 'SAKURA', 'trans', true);
  assert.equal(cs.deltas[0].count, 1, '区分大小写只命中 1 处');
  const ncs = replaceAllInParasDeltas(paras, 'sakura', 'SAKURA', 'trans', false);
  assert.equal(ncs.deltas[0].count, 2);
});

test('字面替换：$& 没有特殊含义（split/join 语义）', () => {
  const paras = [makePara('☆0☆A☆x', 'a$&b')];
  const r = replaceAllInParasDeltas(paras, '$&', 'X', 'trans', false);
  assert.equal(r.deltas[0].translation, 'aXb', '$& 按字面处理，不做正则展开');
});

test('替换为空串 = 删除命中处', () => {
  const paras = [makePara('☆0☆A☆x', '去掉这仨字')];
  const r = replaceAllInParasDeltas(paras, '这仨字', '', 'trans', false);
  assert.equal(r.deltas[0].translation, '去掉');
});

test('中文与全角标点按字面匹配', () => {
  const paras = [makePara('☆0☆A☆x', '「早上好」他说')];
  const r = replaceAllInParasDeltas(paras, '「早上好」', '“早上好”', 'trans', false);
  assert.equal(r.deltas[0].translation, '“早上好”他说');
});

test('预览计算的 deltas 与原地全量替换结果一致（同一规则两处不向背）', () => {
  const mk = () => [
    makePara('☆0☆A☆あ', '花火爆発。花火大会'),
    makePara('☆1☆A☆い', ''),
    makePara('☆NAME|2☆沙織', ''),
    makePara('☆3☆A☆え', '没有命中'),
  ];
  const preview = mk();
  const inPlace = mk();
  preview[2].nameTr = inPlace[2].nameTr = '沙織';
  const { deltas } = replaceAllInParasDeltas(preview, '花火', '烟火', 'all', false);
  replaceAllInParas(inPlace, '花火', '烟火', 'all', false);
  for (const d of deltas){
    assert.equal(d.translation, inPlace[d.i].translation);
    assert.equal(d.nameTr, inPlace[d.i].nameTr);
  }
});
