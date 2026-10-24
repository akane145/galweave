import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorKeyAction, selectionFor, reviewQueue, nextInQueue, issueCategoryCounts, ISSUE_CATEGORIES } from '../src/editor-navigation.js';

test('IME confirmation and modified Enter never navigate rows', () => {
  for (const extra of [{isComposing:true}, {keyCode:229}, {ctrlKey:true}, {metaKey:true}, {altKey:true}, {shiftKey:true}]) {
    assert.equal(editorKeyAction({key:'Enter', ...extra}), null);
  }
  assert.equal(editorKeyAction({key:'Enter'}), 'next');
  assert.equal(editorKeyAction({key:'Tab', shiftKey:true}, true), 'previous');
  assert.equal(editorKeyAction({key:'Tab'}, true), 'suggest');
});

test('restored selection is clamped after the text changes', () => {
  assert.deepEqual(selectionFor({start:3,end:30,direction:'backward'}, 8), {start:3,end:8,direction:'backward'});
  assert.deepEqual(selectionFor(null, 8), {start:8,end:8,direction:'none'});
});

test('review queues preserve row order, deduplicate diagnostics and exclude approved from pending', () => {
  const paras = [{pr:{status:'approved'}}, {}, {pr:{status:'issue',annotations:[{resolved:false}]}}, {pr:{annotations:[{resolved:true}]}}];
  assert.deepEqual(reviewQueue(paras, 'pending'), [1,3]);
  assert.deepEqual(reviewQueue(paras, 'issues', [0,0,2,99]), [0,2]);
  assert.deepEqual(reviewQueue(paras, 'annotations'), [2]);
  assert.deepEqual(nextInQueue([1,3,5], 3, 1), 5);
  assert.equal(nextInQueue([1,3,5], 1, -1), 5);
  assert.equal(nextInQueue([1,5], 3, -1), 1);
  assert.equal(nextInQueue([], 3), -1);
});

const CAT_PARAS = [
  {},
  {pr:{status:'issue'}},
  {pr:{annotations:[{resolved:false}]}},
  {},
  {pr:{status:'approved'}},
  {pr:{status:'issue',annotations:[{resolved:false}]}},
];
const CAT_DIAG = [
  {i:0,kind:'missing'}, {i:0,kind:'term'}, {i:3,kind:'term'}, {i:3,kind:'term'},
  {i:4,kind:'punct'}, {i:5,kind:'token'},
];

test('issue category filters diagnostics by kind and dedupes rows', () => {
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', CAT_DIAG, 'term'), [0,3]);
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', CAT_DIAG, 'missing'), [0]);
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', CAT_DIAG, 'punct'), [4]);
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', CAT_DIAG, 'ratio'), []);
});

test('manual and annotation categories are independent of automatic diagnostics', () => {
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', CAT_DIAG, 'manual'), [1,5]);
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', CAT_DIAG, 'annotation'), [2,5]);
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', [], 'manual'), [1,5]);
});

test('category all keeps the union and unknown categories fall back to all', () => {
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', CAT_DIAG), [0,1,2,3,4,5]);
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', CAT_DIAG, 'all'), [0,1,2,3,4,5]);
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', CAT_DIAG, 'nope'), [0,1,2,3,4,5]);
});

test('category is ignored outside the issues queue', () => {
  assert.deepEqual(reviewQueue(CAT_PARAS, 'pending', CAT_DIAG, 'term'), [0,2,3]);
  assert.deepEqual(reviewQueue(CAT_PARAS, 'annotations', CAT_DIAG, 'term'), [2,5]);
});

test('legacy row-number diagnostics still work and only count toward all', () => {
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', [0,3], 'all'), [0,1,2,3,5]);
  assert.deepEqual(reviewQueue(CAT_PARAS, 'issues', [0,3], 'term'), []);
});

test('issueCategoryCounts matches queue length for every category', () => {
  const counts = issueCategoryCounts(CAT_PARAS, CAT_DIAG);
  for (const c of ISSUE_CATEGORIES) assert.equal(counts[c], reviewQueue(CAT_PARAS, 'issues', CAT_DIAG, c).length, c);
  assert.equal(counts.all, 6);
  assert.equal(counts.term, 2);
  assert.equal(counts.ratio, 0);
});
