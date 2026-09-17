// exporter.js — 导出格式扩展（纯逻辑，不依赖 DOM）
//
// 背景：原 `buildExport`（src/parsers.js）只回写**原格式**，用于"保存原文件 / 导出译文"。
// 本模块补三种**给人和外部工具看**的导出：双语对照 TXT、纯译文 TXT、对照 CSV。
// 它们都是单向产物（不保证能再导回），因此可以带表头、可以按列对齐。
//
// 三条与既有导出语义**对齐**的规则（与 parsers.buildExport 保持一致，改动需同步两处）：
//   1. `NAME` 行始终输出，未改译名时输出原名；
//   2. 普通行**只有译文非空才输出**（纯译文格式下即在源位置上"跳过"该行）；
//   3. 译文取值一律走 `transValue()`（brackets 行会被剥掉外层「」）。
//
// 为什么纯译文格式要跳过空译文行而不是留空行：这是给"贴进引擎"用的产物，
// 留空行会把未译内容从原文里抹掉。要完整对照请用双语或 CSV 格式。

import { isPlaceholderTrans, transValue } from './parsers.js';
import { csvField } from './csv.js';

// 该行是否“真的有译文”:空译文不算,镜像格式预填的原文占位也不算(导出后与原文件一致 = 没译)
function hasRealTranslation(p){
  if (!p) return false;
  if (String(transValue(p) || '').trim() === '') return false;
  return !(p.mirror && isPlaceholderTrans(p));
}

/* ---------------- 格式表 ---------------- */

/** 导出格式清单。`original` 由 parsers.buildExport 处理（本模块返回 null）。 */
export const EXPORT_FORMATS = [
  { id: 'original', label: '原格式（回写引擎文本）' },
  { id: 'bilingual', label: '双语对照 TXT' },
  { id: 'target', label: '纯译文 TXT' },
  { id: 'csv', label: '对照 CSV（Excel 可开）' },
];

/** 归一化格式 id，非法值回退 'original'（最安全：不改变原有行为） */
export function normalizeExportFormat(id){
  const hit = EXPORT_FORMATS.find(f => f.id === id);
  return hit ? hit.id : 'original';
}

/** 中文标签（Toast / 确认框用） */
export function exportFormatLabel(id){
  const hit = EXPORT_FORMATS.find(f => f.id === normalizeExportFormat(id));
  return hit ? hit.label : '原格式（回写引擎文本）';
}

/**
 * 建议文件名。<base> 通常是 model.getFilename()（可能已带 .canonical 痕迹）。
 * 三种新格式都加后缀，避免和原文件同名互相覆盖。
 */
export function suggestExportName(base, format){
  const name = String(base == null ? '' : base).trim() || '译文.txt';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  switch (normalizeExportFormat(format)){
    case 'bilingual': return stem + '.bilingual.txt';
    case 'target': return stem + '.zh.txt';
    case 'csv': return stem + '.csv';
    default: return name;
  }
}

/* ---------------- 行数据 ---------------- */

/**
 * 把 paras 摊平成导出行。所有格式共用同一份行数据，避免各格式各算一遍导致口径分叉。
 * @returns {Array<{index:number,no:string,speaker:string,original:string,translation:string,isName:boolean}>}
 */
export function exportEntries(paras){
  const list = Array.isArray(paras) ? paras : [];
  return list.map((p, i) => {
    const isName = !!(p && p.isName);
    if (!p) return { index: i, no: '', speaker: '', original: '', translation: '', isName: false };
    return {
      index: i,
      no: p.id ? String(p.id) : String(i + 1),
      speaker: isName ? '' : String((p.nameTr || p.name || '')).trim(),
      original: isName ? String(p.name || '') : String(p.content || ''),
      translation: isName ? String((p.nameTr || p.name || '')).trim() : String(transValue(p) || ''),
      isName,
    };
  });
}

/** 行状态文案：有校对记录走三态，否则退回"已译/未译"（与 filestats.js 的双维度一致） */
export function stateLabel(p){
  if (!p) return '未译';
  const st = p.pr && p.pr.status;
  if (st === 'approved') return '已定稿';
  if (st === 'issue') return '有问题';
  if (p.pr) return '待校对';
  return (p.isName ? String((p.nameTr || '')).trim() !== '' : hasRealTranslation(p))
    ? '已译' : '未译';
}

/* ---------------- 各格式构建 ---------------- */

function withNl(lines, nl){ return lines.join(nl) + nl; }

/**
 * 统计：供表头与调用方复用。
 *
 * ⚠️ 这里的「已译」**有意与 model.recalcDone 不一致**：
 * recalcDone 对 NAME 行是"名字框非空即已翻译"（那是为了进度条自动确认的 UX 选择），
 * 但导出摘要要说的是"这行真的有译文吗"——NAME 行的 nameTr 仍等于原名时，
 * 导出的就是原名本身，算"已译"会让摘要虚高。因此 NAME 行要求 nameTr !== name 才算已译。
 * 镜像格式的预填原文占位同理：写回后与原文件逐字节相同，也按"未译"计。
 */
export function countEntries(paras){
  const list = Array.isArray(paras) ? paras : [];
  let total = 0, translated = 0, names = 0;
  for (const p of list){
    total++;
    if (!p) continue;
    if (p.isName){
      names++;
      const tr = String(p.nameTr || '').trim();
      if (tr && tr !== p.name) translated++;
      continue;
    }
    if (hasRealTranslation(p)) translated++;
  }
  return { total, translated, names, pending: total - translated };
}

/**
 * 双语对照 TXT。
 * 结构：注释表头 + 每条一段（`[编号] 说话人` / `原：…` / `译：…`），段间空行。
 * @param {Array} paras
 * @param {{nl?:string, filename?:string, withHeader?:boolean}} [opts]
 */
export function buildBilingualTxt(paras, opts = {}){
  const nl = opts.nl || '\n';
  const withHeader = opts.withHeader !== false;
  const rows = exportEntries(paras);
  const c = countEntries(paras);
  const lines = [];

  if (withHeader){
    lines.push('# 双语对照导出 · ' + (opts.filename || '未命名'));
    lines.push('# 共 ' + c.total + ' 条（已译 ' + c.translated + ' / 未译 ' + c.pending + '）');
    lines.push('');
  }

  for (const r of rows){
    const head = '[' + String(r.index + 1).padStart(4, '0') + ']'
      + (r.no && r.no !== String(r.index + 1) ? ' ' + r.no : '')
      + (r.speaker ? '  ' + r.speaker : '');
    lines.push(head);
    if (r.isName){
      const unchanged = !r.translation || r.translation === r.original;
      lines.push('译名：' + (r.translation || r.original) + (unchanged ? '（未改，导出原名）' : ''));
    } else {
      lines.push('原：' + r.original);
      lines.push('译：' + (r.translation || '（未译）'));
    }
    lines.push('');
  }
  // 去掉末尾多余空行，保留恰好一个换行
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return withNl(lines, nl);
}

/**
 * 纯译文 TXT：只输出有译文的行，用于直接贴进引擎。
 * NAME 行输出译名（未改则原名），与 parsers.buildExport 的 NAME 规则一致。
 */
export function buildTargetTxt(paras, opts = {}){
  const nl = opts.nl || '\n';
  const rows = exportEntries(paras);
  const lines = [];
  for (const r of rows){
    if (r.isName){
      const name = r.translation || r.original;
      if (name) lines.push(name);
      continue;
    }
    if (!r.translation.trim()) continue;      // 未译行跳过：留空行会把原文抹掉
    lines.push(r.translation);
  }
  return lines.length ? withNl(lines, nl) : '';
}

/**
 * 对照 CSV：序号 / 编号 / 说话人 / 原文 / 译文 / 状态。
 * 带 UTF-8 BOM —— Windows Excel 对无 BOM 的 CSV 按 ANSI/GBK 解码会乱码（与 glossary 导出一致）。
 */
export function buildCsvText(paras, opts = {}){
  const nl = opts.nl || '\r\n';
  const rows = exportEntries(paras);
  const list = Array.isArray(paras) ? paras : [];
  const out = [['序号', '编号', '说话人', '原文', '译文', '状态'].join(',')];
  rows.forEach((r) => {
    out.push([
      String(r.index + 1),
      csvField(r.no),
      csvField(r.speaker),
      csvField(r.original),
      csvField(r.translation),
      csvField(stateLabel(list[r.index])),
    ].join(','));
  });
  return '\uFEFF' + withNl(out, nl);
}

/**
 * 按格式 id 构建导出文本。
 * @returns {string|null} 'original' 返回 null（由 parsers.buildExport 处理），格式非法同样返回 null
 */
export function buildExportText(format, paras, opts = {}){
  switch (normalizeExportFormat(format)){
    case 'bilingual': return buildBilingualTxt(paras, opts);
    case 'target': return buildTargetTxt(paras, opts);
    case 'csv': return buildCsvText(paras, opts);
    default: return null;
  }
}
