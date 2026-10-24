// 单文档可携带记录；不序列化应用设置、文件句柄或设备路径。
import { parseFile, getParseConf, setParseConf, validateParseConf, computeDone } from './parsers.js';
import { parseFormatAny, formatParas, normalizeFormat } from './offline-formats.js';
import { sanitizePersona } from './glossary.js';
import { normalizeTm } from './tm.js';
import { normalizeBaseline } from './mtbaseline.js';
import { parseSnapshot, HISTORY_MAX } from './history.js';
import { normalizeStore } from './stats.js';
import { normalizeRuleIds, validateCustomRules } from './textnorm.js';

export const RECORD_PACK_MAX_BYTES = 64 * 1024 * 1024;
const text = value => typeof value === 'string' ? value : '';
const number = value => Number.isFinite(value) ? value : 0;
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
function stringMap(value){
  return Object.fromEntries(Object.entries(value || {}).filter(([,v]) => typeof v === 'string'));
}
function annotation(a){
  if (!a || !['issue','question','suggestion','note'].includes(a.type) || typeof a.text !== 'string') throw new Error('批注格式错误');
  return { id:text(a.id),type:a.type,text:a.text,resolved:!!a.resolved,created:number(a.created),updated:number(a.updated),resolvedAt:a.resolvedAt == null ? null : number(a.resolvedAt) };
}
function row(p){
  if (!p || typeof p.orig !== 'string' || typeof p.translation !== 'string') throw new Error('译文记录格式错误');
  const pr = p.pr || {};
  return { orig:p.orig,translation:p.translation,nameTr:text(p.nameTr),src:['human','tm','mt'].includes(p.src) ? p.src : '',
    pr:{ status:['pending','issue','approved'].includes(pr.status) ? pr.status : 'pending',annotations:(pr.annotations || []).map(annotation) } };
}

/** 对可携带字段做白名单拷贝；也用于导出，防止把运行时配置混进包。 */
export function createRecordPack(data){
  const d = data.document || {};
  const conf = pick(d.parseConf || getParseConf(), ['open','close','regex','commentPrefixes','nameIdPatterns']);
  const rule = d.offlineRule || d.paras?.[0]?.offlineDocument?.rule || null;
  const glossary = data.glossary || {};
  const histories = (data.history || []).slice(0, HISTORY_MAX).map(s => {
    const result = parseSnapshot(s);
    if (!result) throw new Error('历史快照损坏，无法制作完整记录包');
    return result;
  });
  return {
    type:'galweave-record-pack',version:1,exportedAt:number(data.exportedAt) || Date.now(),
    document:{ name:text(d.name).split(/[\\/]/).pop() || '译文.txt',rawText:text(d.rawText),
      encoding:text(d.encoding),canonical:!!d.canonical,parseConf:conf,
      offlineRule:rule ? normalizeFormat(rule) : null,
      rows:(d.paras || d.rows || []).map(row) },
    glossary:{names:stringMap(glossary.names),terms:stringMap(glossary.terms),personas:Object.fromEntries(
      Object.entries(glossary.personas || {}).map(([k,v]) => [k,sanitizePersona(v)]).filter(([,v]) => v))},
    tm:normalizeTm(data.tm),baseline:normalizeBaseline(data.baseline, (d.paras || d.rows || []).length),
    snippets:stringMap(data.snippets),history:histories,
    normRules:{ids:normalizeRuleIds(data.normRules?.ids),customRules:validateCustomRules(data.normRules?.customRules)},
    statistics:normalizeStore({docs:{document:data.statistics || {}}}).docs.document,
    changes:(data.changes || []).map(c => ({id:text(c.id),paraId:text(c.paraId),line:number(c.line),field:text(c.field),before:text(c.before),after:text(c.after),at:number(c.at),source:text(c.source)})),
    editor:{index:Number.isInteger(data.editor?.index) ? data.editor.index : 0},
  };
}

/** 在任何应用状态改变前验证并重建段落。解析规则只在同步调用内临时生效。 */
export function readRecordPack(raw){
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > RECORD_PACK_MAX_BYTES) throw new Error('记录包不能超过 64 MiB');
  let data;
  try {
    data = JSON.parse(raw, (key, value) => {
      if (['__proto__','constructor','prototype'].includes(key)) throw new Error('记录包含不安全字段');
      return value;
    });
  } catch (e){ throw new Error('无法读取记录包：' + e.message); }
  if (data?.type !== 'galweave-record-pack' || data.version !== 1) throw new Error('不支持的记录包类型或版本');
  if (!data.document || typeof data.document.rawText !== 'string' || !Array.isArray(data.document.rows)) throw new Error('记录包缺少脚本或译文记录');
  const pack = createRecordPack(data);
  if (validateParseConf(pack.document.parseConf).length) throw new Error('记录包的解析规则无效');
  const old = getParseConf();
  let parsed;
  try {
    setParseConf(pack.document.parseConf);
    if (pack.document.offlineRule){
      const doc = parseFormatAny(pack.document.rawText, pack.document.offlineRule);
      parsed = {paras:formatParas(doc),nl:pack.document.rawText.includes('\r\n') ? '\r\n' : '\n',trailingBlank:false};
    } else parsed = parseFile(pack.document.rawText);
  } finally { setParseConf(old); }
  if (!parsed.paras.length || parsed.paras.length !== pack.document.rows.length) throw new Error('脚本行数与记录不一致，已取消导入');
  parsed.paras.forEach((p,i) => {
    const saved = pack.document.rows[i];
    if (p.orig !== saved.orig) throw new Error('第 ' + (i+1) + ' 行原文与记录不一致，已取消导入');
    Object.assign(p,saved);
    p.done = computeDone(p);
  });
  for (const c of pack.changes){
    if (!Number.isInteger(c.line) || !parsed.paras[c.line-1] || parsed.paras[c.line-1].orig !== c.paraId || !['translation','nameTr'].includes(c.field)) throw new Error('修改记录与脚本不匹配');
  }
  return {pack,parsed};
}
