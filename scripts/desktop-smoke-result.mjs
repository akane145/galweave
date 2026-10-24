// 桌面冒烟的结果判定（纯逻辑，无 DOM / 无网络）
//
// 从 scripts/verify-desktop.mjs 抽出，便于单测锁定三档判定（R4）：
//   verified      → pass
//   failed        → fail（取到新包但内容无效：确定失败，不能被"待确认"吞掉）
//   undetermined  → partial（没取到新包：无法判定，明确为部分验收）
// 旧实现把 failed 与 undetermined 都算"待确认"并当通过使用，脚本因此无法捕获导出失败。

/** 导出单项结论：verified / failed / undetermined / not-required */
export function classifyExportOutcome(exportResult, exportDirSet = true){
  if (!exportDirSet) return 'not-required';
  if (!exportResult) return 'undetermined';
  if (exportResult.outcome === 'verified' || exportResult.valid === true) return 'verified';
  if (exportResult.outcome === 'failed' || exportResult.valid === false) return 'failed';
  return 'undetermined';
}

/**
 * 整体结论。
 * @param {Object} o
 * @param {object} o.ui           `#editCommand` 检查结果
 * @param {object} o.open         打开文件检查结果
 * @param {object} o.save         保存回写检查结果
 * @param {object} o.modalGuard   模态隔离检查结果
 * @param {object|null} o.exportResult 导出检查结果
 * @param {boolean} [o.exportDirSet=false] 是否要求导出项
 * @param {string[]} [o.pageErrors=[]]
 * @returns {{status:'pass'|'partial'|'fail', failed:string[], exportOutcome:string}}
 */
export function classifyRun({ ui, open, save, modalGuard, exportResult = null, exportDirSet = false, pageErrors = [] } = {}){
  const exportOutcome = classifyExportOutcome(exportResult, exportDirSet);
  const hardChecks = {
    sharedEditGroup: !!(ui && ui.saveIdCount === 1 && Object.values(ui.modes || {}).every(Boolean)),
    openFile: !!(open && !open.error),
    saveToDisk: !!(save && save.inFile),
    modalGuard: !!(modalGuard && modalGuard.afterZ?.focusInside && modalGuard.afterF?.focusInside && modalGuard.closed),
    // 导出只把"确定失败"计入硬失败；"没取到文件"单独进 partial
    exportNotFailed: exportOutcome !== 'failed',
    noPageErrors: (pageErrors || []).length === 0,
  };
  const failed = Object.entries(hardChecks).filter(([, v]) => !v).map(([k]) => k);
  const status = failed.length ? 'fail' : (exportOutcome === 'undetermined' ? 'partial' : 'pass');
  return { status, failed, exportOutcome, checks: hardChecks };
}
