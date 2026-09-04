import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('主题设置提供可预览的主题选择与可访问标签页', () => {
  assert.match(html, /id="themeModal"[\s\S]*?class="theme-choice-grid"/);
  assert.match(html, /id="thTabs"[^>]*role="tablist"/);
  assert.match(html, /data-thpage="0"[^>]*role="tab"[^>]*aria-controls="thPage0"/);
  assert.match(html, /id="thPage0"[^>]*role="tabpanel"/);
  assert.match(html, /class="theme-card-preview theme-card-preview--dark"/);
  assert.match(html, /class="theme-card-preview theme-card-preview--light"/);
  assert.match(html, /class="theme-card-preview theme-card-preview--bw"/);
});

test('解析设置按自动识别与手动规则分区并反馈运行状态', () => {
  assert.match(html, /id="setModal"[\s\S]*?class="settings-section parse-auto-section"/);
  assert.match(html, /class="settings-section parse-manual-section"/);
  assert.match(html, /id="recogOut"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="setTestOut"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('两个设置弹窗都有独立滚动正文和固定操作区', () => {
  for (const id of ['setModal', 'themeModal']) {
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]*?class="settings-scroll"`));
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]*?class="actions settings-actions"`));
  }
});
