// stats-ui.js — 翻译进度统计的编排层（从 main.js 拆出）
//
// 职责边界：本模块负责"什么时候记、记什么、什么时候落盘、怎么开面板"，
// 纯数据推算留在 stats.js（无 DOM、无 IO），面板渲染留在 modals.showStatsPanel。
//
// 为什么值得单独拆：原先这段混在 main.js 里，但它对 main.js 的依赖只有 model（取段落/文件名/状态键）
// 与 countStates（现成的纯函数），既没有 DOM 操作也不碰其它 UI 状态 —— 是 main.js 里
// 少数几个可以整体搬走而不牵一发的区块。
//
// 依赖注入：model 由 initStatsUI 传入，避免本模块反向 import main.js 造成循环。

import * as stats from '../stats.js';
import { countStates } from '../filestats.js';

let model = null;
let showStatsPanel = null;
let toastError = null;

/** 由 main.js 在启动时注入依赖 */
export function initStatsUI(deps){
  model = deps.model;
  showStatsPanel = deps.showStatsPanel;
  toastError = deps.toastError;
}

let statsStore = null;          // 当前项目的统计库（懒加载）
let statsProjectPath = null;    // 落盘位置（源文件绝对路径；浏览器为 null）
let statsWriteTimer = null;

/** 切换项目：加载该文件对应的统计库（随项目 .galweave/stats.json） */
export async function loadStatsForProject(sourcePath){
  statsProjectPath = sourcePath || null;
  statsStore = await stats.loadStats(statsProjectPath);
}

/**
 * 把当前进度写进"当天"记录（覆盖写，不是累加）。
 * 口径说明：done/total 用 filestats.countStates（与进度条、场景树同一来源），
 * 来源构成用 stats.countBySource（内部同样以 p.done 为准），两者不会分叉。
 */
export function recordStatsNow(){
  if (!statsProjectPath || !statsStore) return false;
  const paras = model.getParas();
  const counts = countStates(paras);
  if (!counts.total) return false;
  const bySrc = stats.countBySource(paras);
  statsStore = stats.recordDay(statsStore, model.getStateKey(), {
    name: model.getFilename() || '',
    at: Date.now(),
    done: counts.done,
    total: counts.total,
    byMt: bySrc.mt, byTm: bySrc.tm, byHuman: bySrc.human,
  });
  return true;
}

/** 落盘节流：连续保存/批量机翻之间不反复写盘 */
function saveStatsSoon(){
  if (statsWriteTimer || !statsProjectPath) return;
  statsWriteTimer = setTimeout(async () => {
    statsWriteTimer = null;
    try { await stats.saveStats(statsProjectPath, statsStore); } catch (e) { /* 统计写不进不阻塞业务 */ }
  }, 15000);
}

/** 记录一次进度（改内存 + 排一次落盘） */
export function touchStats(){
  if (recordStatsNow()) saveStatsSoon();
}

/** 立刻落盘（开面板前 / 关窗前） */
export async function flushStats(){
  if (statsWriteTimer){ clearTimeout(statsWriteTimer); statsWriteTimer = null; }
  if (!statsProjectPath || !statsStore) return;
  try { await stats.saveStats(statsProjectPath, statsStore); } catch (e) { /* 忽略 */ }
}

/** 打开统计面板：先落定当天进度，再推算汇总 */
export async function openStats(){
  if (!model.getParas().length){ toastError('请先导入文本文件'); return; }
  recordStatsNow();
  await flushStats();
  const paras = model.getParas();
  const counts = countStates(paras);
  const summary = stats.summarize({
    history: stats.historyOf(statsStore, model.getStateKey()),
    done: counts.done,
    total: counts.total,
    bySrc: stats.countBySource(paras),
  });
  await showStatsPanel({ docName: model.getFilename() || '', summary });
}
