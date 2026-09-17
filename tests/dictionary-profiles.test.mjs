import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryCssCandidates } from '../src/dictionary-profiles.js';

test('dictionary profiles: 大辞林使用非同名 CSS', () => {
  const out = dictionaryCssCandidates('E:/JPdict/大辞林3.0/スーパー大辞林 3.0.mdx');
  assert.equal(out.profile.id, 'daijirin3');
  assert.ok(out.candidates.includes('DAIJIRIN3.css'));
});

test('dictionary profiles: Jitendex 与明鏡支持多 CSS', () => {
  const jit = dictionaryCssCandidates('E:/JPdict/jitendex/jitendex.mdx');
  assert.deepEqual(jit.candidates, ['jitendex.css', 'common.css']);
  const mk = dictionaryCssCandidates('E:/JPdict/（大修館）明鏡国語辞典［第三版］/（大修館）明鏡国語辞典［第三版］.mdx');
  assert.equal(mk.profile.id, 'meikyo3');
  assert.ok(mk.candidates.includes('MK3.css'));
  assert.ok(mk.candidates.includes('MK3-appendix.css'));
});

test('dictionary profiles: 新增词典(大词泉/研究社/古語大辞典)各自有档案', () => {
  // 大词泉: 按「大词泉」目录名与 DJS 文件名都能命中
  assert.equal(dictionaryCssCandidates('E:/JPdict/大词泉/DJS.mdx').profile.id, 'dajici');
  // 研究社 日本語口語表現辞典 第2版: 目录名带「研究社」,文件名 kougo
  assert.equal(dictionaryCssCandidates('E:/JPdict/研究社 日本語口語表現辞典 第2版/kougo.mdx').profile.id, 'kougo-kenkyusha');
  // （角川）古語大辞典: 目录名与 gaiji 字体名都能命中
  assert.equal(dictionaryCssCandidates('E:/JPdict/（角川）古語大辞典/（角川）古語大辞典.mdx').profile.id, 'kogo-kadokawa');
  // 各自的同名 CSS 仍由 stem 候选兜住
  assert.ok(dictionaryCssCandidates('E:/JPdict/大词泉/DJS.mdx').candidates.includes('DJS.css'));
  assert.ok(dictionaryCssCandidates('E:/JPdict/（角川）古語大辞典/（角川）古語大辞典.mdx').candidates.includes('（角川）古語大辞典.css'));
  // 既有词典不受影响
  assert.equal(dictionaryCssCandidates('E:/JPdict/新明解日汉双解词典/XMJRH.mdx').profile.id, 'xmjrh');
});
