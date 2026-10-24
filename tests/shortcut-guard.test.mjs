// 全局命令键判定测试 — node:test + node:assert（纯逻辑，无 DOM）
//
// 用途：模态浮层期间隔离背景命令（R2）。这里锁定"哪些按键算全局命令"
// 与"哪些控件算可编辑"，避免实现漂移后模态又被穿透。
//
// 运行: node --test tests/shortcut-guard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isGlobalCommandKey, isEditableElement } from '../src/shortcut-guard.js';

/* ---------------- 全局命令键 ---------------- */

test('Ctrl/Cmd + S/F/G/Z/Y 是全局命令', () => {
  for (const key of ['s', 'f', 'g', 'z', 'y']){
    assert.equal(isGlobalCommandKey({ key, ctrlKey: true }), true, 'Ctrl+' + key);
    assert.equal(isGlobalCommandKey({ key, metaKey: true }), true, 'Cmd+' + key);
    assert.equal(isGlobalCommandKey({ key: key.toUpperCase(), ctrlKey: true }), true, 'Shift 状态下 key 可能大写');
  }
});

test('F2 / F3 是全局命令', () => {
  assert.equal(isGlobalCommandKey({ key: 'F2' }), true);
  assert.equal(isGlobalCommandKey({ key: 'F3' }), true);
  assert.equal(isGlobalCommandKey({ key: 'F3', shiftKey: true }), true, 'Shift+F3 是上一个匹配');
});

test('Ctrl+Enter 是全局命令（替换当前/机翻当前行）', () => {
  assert.equal(isGlobalCommandKey({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(isGlobalCommandKey({ key: 'Enter', ctrlKey: true, shiftKey: true }), false, 'Shift 变体不在主键表里');
  assert.equal(isGlobalCommandKey({ key: 'Enter', ctrlKey: true, altKey: true }), false);
});

test('普通文本输入与导航键不算全局命令', () => {
  assert.equal(isGlobalCommandKey({ key: 'a' }), false);
  assert.equal(isGlobalCommandKey({ key: 'Enter' }), false);
  assert.equal(isGlobalCommandKey({ key: 'Escape' }), false, 'Esc 交给模态自己处理');
  assert.equal(isGlobalCommandKey({ key: 'Tab' }), false, 'Tab 保留给模态焦点循环');
  assert.equal(isGlobalCommandKey({ key: 'F1' }), false);
  assert.equal(isGlobalCommandKey({ key: 'ArrowDown' }), false);
});

test('容错：空事件与缺字段不抛错', () => {
  assert.equal(isGlobalCommandKey(null), false);
  assert.equal(isGlobalCommandKey(undefined), false);
  assert.equal(isGlobalCommandKey({}), false);
  assert.equal(isGlobalCommandKey({ key: null, ctrlKey: true }), false);
});

/* ---------------- 可编辑控件判定 ---------------- */

test('文本类控件视为可编辑（保留原生行为，含控件内 Ctrl+Z）', () => {
  assert.equal(isEditableElement({ nodeType: 1, tagName: 'TEXTAREA' }), true);
  assert.equal(isEditableElement({ nodeType: 1, tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isEditableElement({ nodeType: 1, tagName: 'INPUT', type: 'number' }), true);
  assert.equal(isEditableElement({ nodeType: 1, tagName: 'INPUT' }), true, '缺 type 按文本处理');
  assert.equal(isEditableElement({ nodeType: 1, tagName: 'SELECT' }), true);
  assert.equal(isEditableElement({ nodeType: 1, tagName: 'DIV', isContentEditable: true }), true);
});

test('按钮/勾选/文件等无文本编辑语义的控件不算可编辑', () => {
  for (const type of ['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color', 'hidden']){
    assert.equal(isEditableElement({ nodeType: 1, tagName: 'INPUT', type }), false, type);
  }
  assert.equal(isEditableElement({ nodeType: 1, tagName: 'BUTTON' }), false);
});

test('容错：非元素节点不算可编辑', () => {
  assert.equal(isEditableElement(null), false);
  assert.equal(isEditableElement(undefined), false);
  assert.equal(isEditableElement({ nodeType: 3 }), false, '文本节点');
});
