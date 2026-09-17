// Galweave → 译间 / Obsidian 经验卡。纯逻辑，无 DOM、文件系统或模型状态依赖。
import { transValue } from './parsers.js';

export const DEFAULT_VAULT = 'E:/Codex/Obsidian/汉化校对积累';
export const CASE_FOLDER = '校对案例';
const META = ['id', 'type', 'title', 'project', 'route', 'character', 'location', 'tags', 'status', 'archived', 'createdAt', 'updatedAt'];
const SECTIONS = { original: '日文原文', before: '原来的译文', after: '采用译文', context: '前后文与场景', note: '我的心得', ai: 'AI 建议（仅供参考）' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normalizeSource(path){
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}
export function resolveChangeRow(change, paras){
  const i = Number(change.line) - 1;
  if (Number.isInteger(i) && paras[i]?.orig === change.paraId) return i;
  const matches = paras.map((p, idx) => p.orig === change.paraId ? idx : -1).filter(idx => idx >= 0);
  if (matches.length > 1) throw new Error('这条原文在当前文档中出现多处，无法确定修改来源，请先核对段落。');
  if (!matches.length) throw new Error('这条修改对应的原文已不在当前文档中，无法可靠收藏。');
  return matches[0];
}
export function snapshotChange(paras, change){
  const index = resolveChangeRow(change, paras), start = Math.max(0, index-2);
  return { paras: structuredClone(paras.slice(start,index+3)), change: { ...change, line:index-start+1 }, offset:start };
}
async function recordId(document, project, change){
  const source = normalizeSource(document);
  // 桌面绝对路径独立标识文档；HTML 同名文件额外用作品隔离。
  const scope = /^(?:[a-z]:\/|\/)/i.test(source) ? source : `${project}\n${source}`;
  const bytes = new TextEncoder().encode(JSON.stringify(['galweave-case-v1', scope, change.id, change.paraId, change.field, change.before, change.after]));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  digest[6] = (digest[6] & 0x0f) | 0x80; digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0,16)].map(x => x.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function buildCase({ paras, change, document, filename, project, route = '', note = '', tags = [], offset = 0 }){
  if (!change?.id || !['translation','nameTr'].includes(change.field)) throw new Error('修改记录格式不正确。');
  const index = resolveChangeRow(change, paras); const p = paras[index];
  const named = change.field === 'nameTr';
  const original = String(named || p.isName ? p.name || '' : p.content || '');
  if (!original.trim() || !String(change.after || '').trim()) throw new Error('原文或本次修改后的译文为空，无法生成完整经验卡。');
  const annotations = (p.pr?.annotations || []).map(a => `[${({ issue:'问题', suggestion:'建议', question:'疑问', note:'备注' })[a.type] || '批注'} / ${a.resolved ? '已解决' : '未解决'}] ${a.text}`).join('\n');
  const context = paras.slice(Math.max(0,index-2), index+3).map((row, relative) => {
    const localIndex = Math.max(0,index-2) + relative;
    return `${localIndex === index ? '【当前段落】' : '【相邻段落】'} 第 ${localIndex+offset+1} 段 · ${row.nameTr || row.name || '旁白'}\n原：${row.isName ? row.name : row.content}\n现译：${row.isName ? row.nameTr || row.name : transValue(row)}`;
  }).join('\n\n');
  const now = new Date().toISOString();
  // 在 await 哈希前冻结数据；预览期间切文档或后续编辑不改变选定历史。
  const record = {
    type: 'case', title: original.replace(/\s+/g,' ').slice(0,45), project: String(project || '').trim(), route,
    character: String(p.nameTr || p.name || ''), location: `${filename || document} · 编辑器第 ${index+offset+1} 段`,
    original, before: String(change.before ?? ''), after: String(change.after ?? ''),
    context: `【Galweave 来源】\n文档：${document}\n修改 ID：${change.id}\n原始条目标识：${change.paraId}\n修改字段：${named ? '译名' : '译文'}\n修改时间：${Number.isFinite(change.at) ? new Date(change.at).toISOString() : '未知'}\n位置为编辑器段落序号，不是源脚本物理行号。\n以下上下文及批注取自收藏时的文档；“修改前后”取自选中的历史记录，可能与现译不同。\n\n${context}\n\n【原有校对批注（不等于改译理由）】\n${annotations || '无'}`,
    note, ai: '', tags, status: 'pending', archived: false, createdAt: now, updatedAt: now,
  };
  const identity = { ...change };
  record.id = await recordId(document, record.project, identity);
  caseMarkdown(record); // 边界校验，保持与译间 v1 的限制一致。
  return record;
}
export function caseMarkdown(record){
  if (!UUID.test(record.id) || record.type !== 'case') throw new Error('经验卡标识不正确。');
  if (!String(record.project || '').trim()) throw new Error('请填写作品名。');
  if (!String(record.original || '').trim() || !String(record.after || '').trim()) throw new Error('原文和采用译文不能为空。');
  for (const key of ['title','project','route','character','location', ...Object.keys(SECTIONS)]) {
    const limit = Object.hasOwn(SECTIONS,key) ? 30000 : 200;
    if (typeof record[key] !== 'string' || record[key].length > limit) throw new Error(`${key} 格式不正确或超过 ${limit} 字符，请缩短后再保存。`);
  }
  if (!Array.isArray(record.tags) || record.tags.length > 20 || record.tags.some(t => typeof t !== 'string' || t.length > 40)) throw new Error('标签最多 20 个，每个最多 40 字。');
  if (!['pending','confirmed'].includes(record.status) || typeof record.archived !== 'boolean') throw new Error('经验卡状态不正确。');
  let text = '---\ngalnote: 1\n' + META.map(key => `${key}: ${JSON.stringify(record[key])}`).join('\n') + '\n---\n';
  for (const [key,label] of Object.entries(SECTIONS)) {
    const value = record[key]; const fence = '`'.repeat(Math.max(2, ...(value.match(/`+/g) || []).map(x => x.length)) + 1);
    text += `\n## ${label}\n\n${fence}text\n${value}\n${fence}\n`;
  }
  return text;
}
export function obsidianUri(path){ return 'obsidian://open?path=' + encodeURIComponent(path) + '&paneType=tab'; }
