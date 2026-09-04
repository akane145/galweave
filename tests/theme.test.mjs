// theme.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/theme.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeThemeMode, nextThemeMode, themeButtonIcon,
  defaultFontSettings, mergeFontSettings, colorForMode,
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
  assert.deepEqual(d.orig, { family: '', size: 17, color: '', colorLight: '', colorBw: '' });
  assert.deepEqual(d.trans, { family: '', size: 17, color: '', colorLight: '', colorBw: '' });
});

test('mergeFontSettings: 缺省/非法字段回退默认,size 钳位', () => {
  const m = mergeFontSettings(null);
  assert.deepEqual(m, defaultFontSettings());

  const m2 = mergeFontSettings({ orig: { family: ' 宋体 ', size: 22, color: '#ff0000' } });
  assert.equal(m2.orig.family, '宋体');
  assert.equal(m2.orig.size, 22);
  assert.equal(m2.orig.color, '#ff0000');
  assert.deepEqual(m2.trans, { family: '', size: 17, color: '', colorLight: '', colorBw: '' });

  // size 越界钳位 + 非数字回退
  assert.equal(mergeFontSettings({ orig: { size: 999 } }).orig.size, 72);
  assert.equal(mergeFontSettings({ orig: { size: 1 } }).orig.size, 8);
  assert.equal(mergeFontSettings({ orig: { size: 'abc' } }).orig.size, 17);

  // 空 family/color 保留为空(跟随主题)
  assert.equal(mergeFontSettings({ orig: { family: '  ' } }).orig.family, '');
});

test('defaultFontSettings: 颜色按主题分槽', () => {
  const d = defaultFontSettings();
  assert.deepEqual(d.orig, { family: '', size: 17, color: '', colorLight: '', colorBw: '' });
  assert.deepEqual(d.trans, { family: '', size: 17, color: '', colorLight: '', colorBw: '' });
});

test('mergeFontSettings: 旧版单 color 数据迁移——只作用于深色槽位', () => {
  const m = mergeFontSettings({ orig: { color: '#aeb9c9' } });
  assert.equal(m.orig.color, '#aeb9c9');        // 深色主题沿用旧色
  assert.equal(m.orig.colorLight, '');          // 浅色回退跟随主题(修复切主题后字色不可读)
  assert.equal(m.orig.colorBw, '');
});

test('mergeFontSettings: 三个颜色槽位独立保存与归一化', () => {
  const m = mergeFontSettings({
    orig: { color: ' #ff0000 ', colorLight: '', colorBw: '#00ff00' },
  });
  assert.equal(m.orig.color, '#ff0000');
  assert.equal(m.orig.colorLight, '');
  assert.equal(m.orig.colorBw, '#00ff00');
  // 非字符串槽位回退空串
  assert.equal(mergeFontSettings({ orig: { colorLight: 42 } }).orig.colorLight, '');
});

test('colorForMode: 按模式取对应槽位,空串/非法回退', () => {
  const g = { color: '#111111', colorLight: '#222222', colorBw: '#333333' };
  assert.equal(colorForMode(g, 'dark'), '#111111');
  assert.equal(colorForMode(g, 'light'), '#222222');
  assert.equal(colorForMode(g, 'bw'), '#333333');
  assert.equal(colorForMode(g, '啥'), '#111111');   // 非法模式回退深色
  assert.equal(colorForMode(g, undefined), '#111111');
  // 缺槽位 → 空串(跟随主题)
  assert.equal(colorForMode({ color: '#111111' }, 'light'), '');
  assert.equal(colorForMode(null, 'dark'), '');
  // 非对象/空值安全
  assert.equal(colorForMode(undefined, 'light'), '');
});
