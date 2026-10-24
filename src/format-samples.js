// format-samples.js — 多样例标注 → 片段骨架归纳（纯逻辑，不依赖 DOM）。
//
// 定位：用户在样例文本上选中若干区间并标为「编号 / 角色名 / 正文」，
// 本模块把**已标注的区间**翻译成 offline-formats 的片段骨架，并比较同布局的
// 多组样例是否证明"同一个布局"。
//
// 核心设计：**多样例用于证明，而不是猜**（维护契约见 docs/DEVELOPMENT.md）。
// 程序不依赖单例启发式去推测字段边界 —— 边界完全由用户标注给出；
// 多组样例的作用是**互相印证**：若两组样例归纳出的骨架不一致，说明它们
// 其实不是同一种布局（或标注错了），此时必须报错并指出冲突位置。
//
// 因此本模块只有两个动作：
//   1. buildSkeleton(text, marks) —— 单组样例 + 标注 → 片段骨架
//   2. inferLayout(samples)       —— 多组骨架 → 一致的布局 或 冲突详情

import { FIELD_NAMES, FIELD_LABEL, MAX_TEMPLATE_LEN, MAX_FRAGMENTS, cloneFragments } from './offline-formats.js';

/** 至少需要几组样例才允许归纳出一个布局（plan.md 硬要求） */
export const MIN_SAMPLES = 2;

/* ---------------- 标注校验 ---------------- */

/**
 * 把用户标注归一化并校验。
 *
 * @param {string} text 样例文本
 * @param {Array<{start:number,end:number,field:string}>} marks 标注区间（半开区间）
 * @returns {{ok:boolean, marks:Array, error:string}} marks 按 start 升序
 */
export function normalizeMarks(text, marks){
 const s = typeof text === 'string' ? text : '';
 const list = Array.isArray(marks) ? marks : [];
 const seen = new Set();
 const out = [];
 for (const m of list){
  if (!m || typeof m !== 'object') return { ok:false, marks:[], error:'标注格式不正确' };
  const start = Number(m.start), end = Number(m.end);
  const field = String(m.field||'');
  if (!Number.isInteger(start) || !Number.isInteger(end)) return { ok:false, marks:[], error:'标注位置必须是整数' };
  if (start < 0 || end > s.length) return { ok:false, marks:[], error:'标注超出了样例文本范围' };
  if (start >= end) return { ok:false, marks:[], error:'标注区间不能为空' };
  if (!FIELD_NAMES.includes(field)) return { ok:false, marks:[], error:'只能标注为'+FIELD_NAMES.map(f=>FIELD_LABEL[f]).join('、') };
  if (seen.has(field)) return { ok:false, marks:[], error:`「${FIELD_LABEL[field]}」在同一组样例里只能标注一次` };
  seen.add(field);
  out.push({ start, end, field });
 }
 out.sort((a,b)=>a.start-b.start);
 // 重叠检测（排序后相邻比较即可）
 for (let i=1;i<out.length;i++){
  if (out[i].start < out[i-1].end){
   return { ok:false, marks:[], error:`「${FIELD_LABEL[out[i-1].field]}」与「${FIELD_LABEL[out[i].field]}」的标注区间重叠了` };
  }
 }
 if (!seen.has('text')) return { ok:false, marks:[], error:'每组样例都必须标注一处「正文」' };
 return { ok:true, marks:out, error:'' };
}

/* ---------------- 单组样例 → 骨架 ---------------- */

/**
 * 由一组样例与标注归纳出片段骨架。
 *
 * 未标注的字符一律成为 `literal`（固定文字）—— 这是 plan.md 的明确约定：
 * 前后缀不暴露为可编辑字段，它们原样保留。
 *
 * @returns {{ok:boolean, fragments:Array, error:string}}
 */
export function buildSkeleton(text, marks){
 const s = typeof text === 'string' ? text : '';
 const norm = normalizeMarks(s, marks);
 if (!norm.ok) return { ok:false, fragments:[], error:norm.error };

 const fragments = [];
 let cursor = 0;
 for (const m of norm.marks){
  if (m.start > cursor) fragments.push({ type:'literal', value:s.slice(cursor, m.start) });
  fragments.push({ type:'field', field:m.field });
  cursor = m.end;
 }
 if (cursor < s.length) fragments.push({ type:'literal', value:s.slice(cursor) });

 // 与 validateFormatV2 同源的结构约束，提前在这一层报错（错误信息更贴近"你标错了什么"）
 if (fragments[0].type !== 'literal' || !fragments[0].value){
  return { ok:false, fragments:[], error:'样例必须以未标注的固定文字开头（不能一上来就是字段）' };
 }
 const fields = fragments.filter(f=>f.type==='field');
 if (fields.length !== norm.marks.length) return { ok:false, fragments:[], error:'归纳骨架时字段数量对不上' };
 const litLen = fragments.filter(f=>f.type==='literal').reduce((n,f)=>n+f.value.length,0);
 if (litLen > MAX_TEMPLATE_LEN) return { ok:false, fragments:[], error:`固定文字超过 ${MAX_TEMPLATE_LEN} 字符` };
 if (fragments.length > MAX_FRAGMENTS) return { ok:false, fragments:[], error:'片段过多' };
 return { ok:true, fragments, error:'' };
}

/* ---------------- 多组样例 → 布局 ---------------- */

/**
 * 骨架结构是否同形：**只比字段序列与片段类型**，不比 literal 的具体文字。
 *
 * 为何不比文字：两组对话样例的正文内容必然不同，固定文字也会随之不同。
 * 若把文字差异当结构差异，报错就会落在"第 N 段结构不同"这种没用的位置；
 * 真正的文字差异应交给 firstLiteralDiff 报成"固定文字不一致"，
 * 那才对应用户实际要修的东西（漏标了一段内容）。
 *
 * 但**换行必须比**：literal 里有没有 \n 决定正文是单行还是跨行匹配，
 * 属于结构属性而非内容差异。
 */
function sameShape(a, b){
 if (a.length !== b.length) return false;
 return a.every((f,i)=>{
  const g = b[i];
  if (!f || !g || f.type !== g.type) return false;
  if (f.type === 'literal') return f.value.includes('\n') === g.value.includes('\n');
  return f.field === g.field;
 });
}

/**
 * 定位首个差异片段，产出人能读懂的冲突说明。
 *
 * 错误措辞刻意用「第几组样例 / 哪一段固定文字 / 哪个字段」，
 * 不暴露内部数据结构（plan.md Task 7 要求：不暴露正则与内部模板语法）。
 */
export function describeConflict(a, b, indexA, indexB){
 const n = Math.max(a.length, b.length);
 for (let i=0;i<n;i++){
  const f = a[i], g = b[i];
  // 片段数不同：最可能的原因是**有一组的某段内容没被标注**，于是它成了额外的固定文字。
  // 措辞要指向"漏标"而不是干巴巴地说"多一段"，否则用户不知道该改哪里。
  if (!f && g){
   const what = g.type==='literal' ? `「${clip(g.value)}」` : `「${FIELD_LABEL[g.field]}」`;
   return `第 ${indexB+1} 组样例末尾多出一段未被标注的${g.type==='literal'?'固定文字':'字段'}${what}`
     + `；第 ${indexA+1} 组没有对应的部分。请检查是否有一处内容忘记标注。`;
  }
  if (f && !g){
   const what = f.type==='literal' ? `「${clip(f.value)}」` : `「${FIELD_LABEL[f.field]}」`;
   return `第 ${indexA+1} 组样例末尾多出一段未被标注的${f.type==='literal'?'固定文字':'字段'}${what}`
     + `；第 ${indexB+1} 组没有对应的部分。请检查是否有一处内容忘记标注。`;
  }
  if (!f || !g) continue;
  if (f.type !== g.type){
   const fa = f.type==='literal' ? `固定文字「${clip(f.value)}」` : `「${FIELD_LABEL[f.field]}」`;
   const ga = g.type==='literal' ? `固定文字「${clip(g.value)}」` : `「${FIELD_LABEL[g.field]}」`;
   return `第 ${i+1} 处不一致：第 ${indexA+1} 组是${fa}，第 ${indexB+1} 组是${ga}`;
  }
  if (f.type === 'field' && f.field !== g.field){
   return `第 ${i+1} 处字段不一致：第 ${indexA+1} 组标为「${FIELD_LABEL[f.field]}」，第 ${indexB+1} 组标为「${FIELD_LABEL[g.field]}」`;
  }
  // 换行是结构属性：literal 里有没有 \n 决定正文按单行还是跨行匹配
  if (f.type === 'literal' && (f.value.includes('\n') !== g.value.includes('\n'))){
   return `第 ${i+1} 处固定文字的换行不一致：第 ${indexA+1} 组${f.value.includes('\n')?'有换行':'没有换行'}，第 ${indexB+1} 组${g.value.includes('\n')?'有换行':'没有换行'}`;
  }
 }
 return '';
}

function clip(s){ const t = String(s||'').replace(/\n/g,'⏎'); return t.length>14 ? t.slice(0,14)+'…' : t; }

/**
 * 由多组样例归纳出一个布局。
 *
 * @param {Array<{text:string, marks:Array}>} samples 同一布局的多组样例
 * @returns {{ok:boolean, fragments:Array, error:string, conflicts:Array}}
 *   - 少于 MIN_SAMPLES 组 → 明确拒绝（单个样例不能证明布局）
 *   - 骨架结构不一致 → 失败并给出冲突定位
 *   - 固定文字不一致 → 失败（**不猜测、不合并**，见下）
 */
export function inferLayout(samples){
 const list = Array.isArray(samples) ? samples : [];
 if (list.length < MIN_SAMPLES){
  return { ok:false, fragments:[], conflicts:[], error:`至少需要 ${MIN_SAMPLES} 组样例才能归纳一个布局（单个样例无法证明它是稳定的格式）` };
 }
 const skeletons = [];
 for (let i=0;i<list.length;i++){
  const s = list[i] || {};
  const r = buildSkeleton(s.text, s.marks);
  if (!r.ok) return { ok:false, fragments:[], conflicts:[], error:`第 ${i+1} 组样例：${r.error}` };
  skeletons.push(r.fragments);
 }
 // 1) 结构必须同形（字段顺序、数量、换行位置）
 for (let i=1;i<skeletons.length;i++){
  if (!sameShape(skeletons[0], skeletons[i])){
   const detail = describeConflict(skeletons[0], skeletons[i], 0, i);
   return { ok:false, fragments:[], conflicts:[{ a:0, b:i, detail, reason:'shape' }],
    error:`第 1 组与第 ${i+1} 组样例不是同一种布局。${detail}` };
  }
 }
 // 2) 固定文字必须**逐字相同**。
 //    这里刻意不做"取公共前后缀"的合并：固定文字不同，说明用户漏标了某段内容
 //    （那段内容在两组样例里必然不同）。若悄悄合并，会生成一个看似可用、
 //    实则丢失了结构的布局 —— 违反"多样例用于证明而不是猜"的原则（plan.md 决策 2）。
 for (let i=1;i<skeletons.length;i++){
  const diff = firstLiteralDiff(skeletons[0], skeletons[i]);
  if (diff){
   return { ok:false, fragments:[], conflicts:[{ a:0, b:i, detail:diff, reason:'literal' }],
    error:`第 1 组与第 ${i+1} 组样例的固定文字不一致。${diff}\n`
      + '这通常意味着有一段内容没有标注（它会被当成固定文字）。请把那处也标成字段，或确认两组样例是否属于同一种布局。' };
  }
 }
 return { ok:true, fragments:skeletons[0].map(f=>({...f})), conflicts:[], error:'' };
}

/** 首个固定文字差异（返回可读说明；无差异返回 ''） */
export function firstLiteralDiff(a, b){
 let k = 0;
 for (let i=0;i<a.length;i++){
  const f = a[i], g = b[i];
  if (!f || !g || f.type !== 'literal' || g.type !== 'literal') continue;
  k++;
  if (f.value !== g.value){
   return `第 ${k} 段固定文字不同：第 1 组是「${clip(f.value)}」，另一组是「${clip(g.value)}」`;
  }
 }
 return '';
}

/* ---------------- 组装成 v2 pattern ---------------- */

/**
 * 把归纳结果包装成 v2 档案里的一个原文布局。
 * @param {Array} fragments
 * @param {{id:string, kind:'dialogue'|'narration', target:string}} meta
 */
export function toSourcePattern(fragments, meta){
 const m = meta || {};
 return {
  id: String(m.id||'s1'),
  kind: m.kind === 'narration' ? 'narration' : 'dialogue',
  target: String(m.target||'t1'),
  fragments: cloneFragments(fragments),
 };
}

/** 把归纳结果包装成 v2 档案里的一个译文布局 */
export function toTargetPattern(fragments, id){
 return {
  id: String(id||'t1'),
  fragments: cloneFragments(fragments),
 };
}

/**
 * 一组样例的"标注覆盖率"自检：返回未被任何标注覆盖的字符区间。
 * UI 用它把"你还没标的部分"高亮出来 —— 那些会自动变成固定文字，
 * 用户应当确认这是有意的。
 */
export function uncoveredRanges(text, marks){
 const s = typeof text==='string'?text:'';
 const norm = normalizeMarks(s, marks);
 const list = norm.ok ? norm.marks : (Array.isArray(marks)?marks:[])
  .filter(m=>m&&Number.isInteger(m.start)&&Number.isInteger(m.end)&&m.start<m.end&&m.end<=s.length)
  .sort((a,b)=>a.start-b.start);
 const out = [];
 let cursor = 0;
 for (const m of list){
  if (m.start > cursor) out.push({ start:cursor, end:m.start });
  cursor = Math.max(cursor, m.end);
 }
 if (cursor < s.length) out.push({ start:cursor, end:s.length });
 return out;
}
