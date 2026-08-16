// theme.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/theme.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeThemeMode, nextThemeMode, themeButtonIcon,
  defaultFontSettings, mergeFontSettings,
} from '../src/theme.js';

test('normalizeThemeMode: 合法/非法回退', () => {
  assert.equal(normalizeThemeMode('dark'), 'dark');
  assert.equal(normalizeThemeMode('light'), 'light');
  assert.equal(normalizeThemeMode('bw'), 'bw');
  assert.equal(normalizeThemeMode('啥'), 'dark');
  assert.equal(normalizeThemeMode(undefined), 'dark');
  assert.equal(normalizeThemeMode(''), 'dark');
});

test('nextThemeMode: dark→light→bw→dark 循环', () => {
  assert.equal(nextThemeMode('dark'), 'light');
  assert.equal(nextThemeMode('light'), 'bw');
  assert.equal(nextThemeMode('bw'), 'dark');
  assert.equal(nextThemeMode('非法'), 'light'); // 先归一化再循环
});

test('themeButtonIcon: 各模式图标', () => {
  assert.equal(themeButtonIcon('dark'), '🌓');
  assert.equal(themeButtonIcon('light'), '🌞');
  assert.equal(themeButtonIcon('bw'), '⬛');
});

test('defaultFontSettings: 默认值', () => {
  const d = defaultFontSettings();
  assert.deepEqual(d.orig, { family: '', size: 17, color: '' });
  assert.deepEqual(d.trans, { family: '', size: 17, color: '' });
});

test('mergeFontSettings: 缺省/非法字段回退默认,size 钳位', () => {
  const m = mergeFontSettings(null);
  assert.deepEqual(m, defaultFontSettings());

  const m2 = mergeFontSettings({ orig: { family: ' 宋体 ', size: 22, color: '#ff0000' } });
  assert.equal(m2.orig.family, '宋体');
  assert.equal(m2.orig.size, 22);
  assert.equal(m2.orig.color, '#ff0000');
  assert.deepEqual(m2.trans, { family: '', size: 17, color: '' });

  // size 越界钳位 + 非数字回退
  assert.equal(mergeFontSettings({ orig: { size: 999 } }).orig.size, 72);
  assert.equal(mergeFontSettings({ orig: { size: 1 } }).orig.size, 8);
  assert.equal(mergeFontSettings({ orig: { size: 'abc' } }).orig.size, 17);

  // 空 family/color 保留为空(跟随主题)
  assert.equal(mergeFontSettings({ orig: { family: '  ' } }).orig.family, '');
});
