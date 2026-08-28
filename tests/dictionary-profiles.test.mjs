import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileForDictionary, dictionaryCssCandidates } from '../src/dictionary-profiles.js';

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
