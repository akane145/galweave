import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = await readFile(new URL('../src/offline-formats-ui.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('格式档案使用统一的零正则主流程，不再并列高级模板编辑器', () => {
  assert.doesNotMatch(source, /id="of-mode"/);
  assert.doesNotMatch(source, /id="of-adv-(?:source|target)"/);
  assert.doesNotMatch(source, /直接编辑模板（高级）/);
  assert.match(source, /settings-section-index">02</);
  assert.match(source, /settings-badge settings-badge--muted">自定义</);
});

test('解析弹窗三个功能区编号连续，格式档案控件复用设置面板样式', () => {
  assert.match(html, /id="parseManualTitle">兼容解析规则/);
  assert.match(html, /settings-section-index">03</);
  assert.match(source, /class="field of-profile-field"/);
  assert.match(source, /class="toolbtn secondary" id="of-use"/);
  assert.match(source, /class="toolbtn settings-primary" id="of-preview"/);
});
