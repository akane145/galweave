import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { iconMarkup, rowStatusIcon } from '../src/icons.js';

test('行状态映射保持四种不同形状，未知状态降为未翻译', () => {
  assert.deepEqual(['todo', 'pending', 'issue', 'approved'].map(rowStatusIcon), ['circle', 'pending', 'warning', 'check']);
  assert.equal(rowStatusIcon(null), 'circle');
  assert.equal(rowStatusIcon('unrecognized'), 'circle');
});

test('图标字符串只能引用固定本地 symbol，拒绝注入内容', () => {
  assert.equal(iconMarkup('book'), '<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-book"/></svg>');
  for (const key of ['"/><script>alert(1)</script>', '__proto__', 'toString', '#i-book', '', null]) {
    assert.throws(() => iconMarkup(key), RangeError);
  }
});

test('所有允许图标与必备操作图标在离线 sprite 中定义', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const names = ['import', 'save', 'save-all', 'export', 'undo', 'redo', 'search', 'replace', 'book', 'pen', 'check', 'warning', 'close', 'panel-collapse', 'more', 'plus', 'return-to-editor', 'circle', 'pending'];
  for (const name of names) {
    assert.ok(iconMarkup(name).includes('#i-' + name));
    assert.match(html, new RegExp(`<symbol id="i-${name}" viewBox="0 0 24 24">`));
    assert.equal(html.split(`id="i-${name}"`).length - 1, 1);
  }
});
