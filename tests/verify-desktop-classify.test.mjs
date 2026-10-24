// 桌面冒烟脚本的结果判定测试 — node:test + node:assert
//
// 背景（R4）：`scripts/verify-desktop.mjs` 曾把"取到新包但内容无效"（确定失败）
// 与"没取到新包"（无法判定）都归为待确认，并当 exportOk 使用 —— 脚本于是无法
// 捕获导出的真实失败，还会以 0 退出。本测试把三档判定固定下来：
//   verified → pass，invalid→ fail，undetermined → partial（不是 pass 也不是 fail）。
//
// 由于脚本本身是"驱动真实窗口"的可执行文件，判定逻辑抽在
// `scripts/desktop-smoke-result.mjs`（纯逻辑），本测试直接锁定它。
//
// 运行: node --test tests/verify-desktop-classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyExportOutcome, classifyRun } from '../scripts/desktop-smoke-result.mjs';

test('导出三档判定：无效包是确定失败，不能当待确认', () => {
  // 旧缺陷的最小复现：取到文件但 JSON/结构无效
  assert.equal(classifyExportOutcome({ outcome: 'failed', valid: false, fresh: ['a.galweave.json'] }), 'failed');
  assert.equal(classifyExportOutcome({ outcome: 'verified', valid: true }), 'verified');
  // 没取到文件 = 无法判定
  assert.equal(classifyExportOutcome({ outcome: 'undetermined', fresh: [] }), 'undetermined');
});

test('整体判定：确定失败必须 fail，undetermined 是 partial', () => {
  const base = {
    ui: { saveIdCount: 1, modes: { project: true, translate: true, glossary: true, search: true } },
    open: {},
    save: { inFile: true },
    modalGuard: { afterZ: { focusInside: true }, afterF: { focusInside: true }, closed: true },
  };
  const noErrors = [];
  // 导出成功 → pass
  assert.equal(classifyRun({ ...base, exportResult: { outcome: 'verified' }, pageErrors: noErrors, exportDirSet: true }).status, 'pass');
  // 取到文件但无效 → fail（即使其他检查全过）
  assert.equal(classifyRun({ ...base, exportResult: { outcome: 'failed' }, pageErrors: noErrors, exportDirSet: true }).status, 'fail');
  // 没取到文件 → partial（不谎报通过，也不当成失败）
  assert.equal(classifyRun({ ...base, exportResult: { outcome: 'undetermined' }, pageErrors: noErrors, exportDirSet: true }).status, 'partial');
  // 页面错误 → fail
  assert.equal(classifyRun({ ...base, exportResult: { outcome: 'verified' }, pageErrors: ['boom'], exportDirSet: true }).status, 'fail');
  // 保存未落盘 → fail
  assert.equal(classifyRun({ ...base, save: { inFile: false }, exportResult: { outcome: 'verified' }, pageErrors: noErrors, exportDirSet: true }).status, 'fail');
  // 未要求导出目录 → 只看其余检查
  assert.equal(classifyRun({ ...base, exportResult: null, pageErrors: noErrors, exportDirSet: false }).status, 'pass');
});
