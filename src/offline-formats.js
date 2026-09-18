// Offline, declarative text templates. No user code, dynamic evaluation or network.
import { tokenizeInline } from './universal-parser.js';
export const BUILTIN_FORMATS = [
 {version:1,name:'原文 / 译文前缀',source:'原文：{text}',target:'译文：{text}',pairing:'order',ignore:['#',';']},
 {version:1,name:'JP / CN 编号分区',source:'JP[{id}] {text}',target:'CN[{id}] {text}',pairing:'id',ignore:['#',';']},
 {version:1,name:'多行标签块',source:'<jp {id}>\n{text}\n</jp>',target:'<cn {id}>\n{text}\n</cn>',pairing:'id',ignore:['#']},
];
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\n/g,'\\r?\\n');
function compile(template){
 if(typeof template!=='string'||template.length>4096) throw new Error('模板不能为空或超过 4096 字符');
 const parts=template.replace(/\r\n/g,'\n').split(/(\{(?:text|id|name)\})/);
 const fields=[]; let pattern='';
 for(let i=0;i<parts.length;i++){
  const p=parts[i];
  if(i%2){
   const key=p.slice(1,-1);
   if(fields.includes(key)) throw new Error('每个字段在同一模板中只能标注一次');
   if(i>1&&!parts[i-1]) throw new Error('两个字段之间需要固定分隔文字');
   fields.push(key);
   pattern+=key==='text'&&template.includes('\n')?'([\\s\\S]*?)':'([^\\r\\n]*?)';
  }else{
   if(/\{[^}]*\}/.test(p)) throw new Error('只支持 {text}、{id}、{name} 字段');
   pattern+=escape(p);
  }
 }
 if(!fields.includes('text')||!parts[0]) throw new Error('模板需含正文，并以固定文字开头');
 return {re:new RegExp(pattern+'(?=\\r?\\n|$)','dy'),fields};
}
export function validateFormat(value){
 if(!value||value.version!==1) throw new Error('不支持的格式档案版本');
 if(typeof value.name!=='string'||!value.name.trim()||value.name.length>100) throw new Error('请填写 1–100 字符的档案名称');
 if(!['id','order'].includes(value.pairing)) throw new Error('配对方式必须是编号或顺序');
 const source=compile(value.source),target=compile(value.target);
 if(value.source===value.target) throw new Error('原文与译文模板不能相同');
 if(value.pairing==='id'&&(!source.fields.includes('id')||!target.fields.includes('id'))) throw new Error('编号配对要求两侧均标注编号');
 if(!Array.isArray(value.ignore)||value.ignore.length>20||value.ignore.some(s=>typeof s!=='string'||!s.trim()||s.length>100)) throw new Error('忽略前缀格式不正确');
 return {version:1,name:value.name.trim(),source:value.source.replace(/\r\n/g,'\n'),target:value.target.replace(/\r\n/g,'\n'),pairing:value.pairing,ignore:[...value.ignore]};
}
function match(compiled,text,start){
 compiled.re.lastIndex=start;const m=compiled.re.exec(text);if(!m)return null;
 const values={},spans={};compiled.fields.forEach((key,i)=>{values[key]=m[i+1];spans[key]=m.indices[i+1];});
 return {start,end:start+m[0].length,values,spans};
}
export function parseFormat(text,value){
 let rule;try{rule=validateFormat(value);}catch(e){return {text,rule:value,records:[],unmatched:[],errors:[e.message]};}
 const source=compile(rule.source),target=compile(rule.target),sources=[],targets=[],unmatched=[],errors=[];
 let pos=text.charCodeAt(0)===0xfeff?1:0,line=1;
 while(pos<text.length){
  const a=match(source,text,pos),b=match(target,text,pos);
  const endLine=text.indexOf('\n',pos);let end=endLine<0?text.length:endLine+1;
  if(a&&b) errors.push(`第 ${line} 行同时匹配原文和译文`);
  else if(a||b){const m=a||b;m.line=line;(a?sources:targets).push(m);end=m.end;if(text[end]==='\r')end++;if(text[end]==='\n')end++;}
  else{const raw=text.slice(pos,end).replace(/[\r\n]+$/,'');if(raw.trim()&&!rule.ignore.some(p=>raw.trimStart().startsWith(p)))unmatched.push({line,text:raw});}
  line+=(text.slice(pos,end).match(/\n/g)||[]).length;pos=end;
 }
 const records=[];
 if(rule.pairing==='id'){
  const sm=new Map(),tm=new Map();
  for(const [list,map] of [[sources,sm],[targets,tm]])for(const m of list){const id=m.values.id;if(!id||map.has(id))errors.push(`第 ${m.line} 行编号为空或重复：${id}`);map.set(id,m);}
  for(const a of sources){const b=tm.get(a.values.id);if(!b)errors.push(`第 ${a.line} 行找不到配对译文`);else records.push({key:a.values.id,source:a,target:b});}
  for(const b of targets)if(!sm.has(b.values.id))errors.push(`第 ${b.line} 行是孤立译文`);
 }else{
  if(sources.length!==targets.length)errors.push(`原文 ${sources.length} 条，译文 ${targets.length} 条，数量不一致`);
  for(let i=0;i<Math.min(sources.length,targets.length);i++)records.push({key:String(i+1),source:sources[i],target:targets[i]});
 }
 if(!records.length)errors.push('没有完整的原译文记录');
 return {text,rule,records,unmatched,errors};
}
export function chooseFormat(text,rules){return rules.map(rule=>parseFormat(text,rule)).filter(d=>!d.errors.length&&!d.unmatched.length);}
/**
 * 按原格式回写。
 *
 * ⚠️ 版本无关：`document.rule` 是 v1 就用 v1 解析器复验，是 v2 就用 v2 ——
 * 这样 v2 档案自动继承既有**全部**安全门禁（控制符禁改、记录顺序、再次解析一致性），
 * 不必也不能重写一套平行的校验（两套门禁必然会随时间分叉）。
 */
export function exportFormat(document,edits){
 if(document.errors.length||edits.length!==document.records.length)throw new Error('格式记录不完整，不能安全导出');
 const replacements=[];
 document.records.forEach((r,i)=>{
  const edit=edits[i];
  if(!edit) throw new Error('编辑数据不完整');
  if(!r.target.spans.name&&edit.nameTr&&edit.nameTr!==(r.source.values.name||''))throw new Error('此档案未配置译名写回位置');
  for(const [field,value] of [['text',edit.translation],['name',edit.nameTr]]){
   if(value===undefined||!r.target.spans[field]||value===r.target.values[field])continue;
   if(typeof value!=='string')throw new Error('译文必须是文本');
   if(field==='text'){
    const protectedTokens = text => tokenizeInline(text).filter(t => t.protected).map(t => t.value);
    const baseline = r.target.values.text || r.source.values.text;
    if(JSON.stringify(protectedTokens(baseline))!==JSON.stringify(protectedTokens(value))) throw new Error('译文中的控制标记被删除、新增或重排，已阻止回写');
   }
   replacements.push({span:r.target.spans[field],value});
  }
 });
 let output=document.text;
 replacements.sort((a,b)=>b.span[0]-a.span[0]);
 for(const {span,value} of replacements)output=output.slice(0,span[0])+value+output.slice(span[1]);
 const check=parseFormatAny(output,document.rule);
 if(check.errors.length||check.records.length!==document.records.length||JSON.stringify(check.unmatched.map(x=>x.text))!==JSON.stringify(document.unmatched.map(x=>x.text)))throw new Error('编辑内容改变了文件结构，请检查换行、编号和结束标记');
 for(let i=0;i<check.records.length;i++){
  const a=document.records[i],b=check.records[i];
  const nameChanged = a.target.spans.name && b.target.values.name !== (edits[i].nameTr ?? a.target.values.name);
  if(a.key!==b.key||JSON.stringify(a.source.values)!==JSON.stringify(b.source.values)||b.target.values.text!==(edits[i].translation??a.target.values.text)||nameChanged) throw new Error('回写校验失败，原文或字段边界发生变化');
 }
 return output;
}
/**
 * 解析结果 → 编辑器段落模型。
 *
 * 旁白（kind==='narration'）**不伪造角色名** —— plan.md Task 4 的明确要求：
 * 旁白本就没有说话人，给它塞一个空 role 会让人以为"这里应该填角色名"。
 * 译文侧没配 name 槽时也不写 nameTr（写了也无处回写，exportFormat 会拒绝）。
 */
export function formatParas(doc){
 if(doc.errors.length)throw new Error(doc.errors.join('\n'));
 return doc.records.map((r,i)=>{
  const narration = r.kind === 'narration';
  const name = narration ? '' : (r.source.values.name||'');
  const translation = r.target.values.text;
  const hasNameSlot = !!r.target.spans.name;
  return {
   orig:`☆offline:${r.key}☆☆${r.source.values.text}`,
   prefix:'',content:r.source.values.text,id:r.key,name,
   nameTr: hasNameSlot ? (r.target.values.name ?? name) : name,
   segs:[r.key,''],isName:false,brackets:false,translation,
   done:!!translation.trim(),offlineKey:r.key,
   // 布局溯源：UI 用它显示"这条命中哪个布局、是对话还是旁白"
   offlineKind: r.kind || 'dialogue',
   offlineSourcePattern: r.sourcePattern,
   offlineTargetPattern: r.targetPattern,
   ...(i===0?{offlineDocument:doc}:{}),
  };
 });
}

/* ============================================================
   v2 — 片段化多布局档案
   ============================================================
   v1 的单个 source/target 模板在内部就是"一条布局"。v2 把布局拆成片段数组，
   使一个档案可同时表达多种原文布局（如"带角色名的对话"与"不带角色名的旁白"）
   共用或各自的译文布局。

   为什么用片段而不是直接存正则：片段是**纯数据**，可严格校验、可比较、
   可由 UI 增删字段而不需要用户理解正则。编译成正则只发生在内部。

   Fragment =
     | { type:'literal', value:string }     // 固定文字（含换行）
     | { type:'field', field:'id'|'name'|'text' }
   ============================================================ */

export const FIELD_NAMES = ['id', 'name', 'text'];
export const SOURCE_KINDS = ['dialogue', 'narration'];
export const KIND_LABEL = { dialogue: '对话', narration: '旁白' };
/** 单个 pattern 的片段数上限与模板长度上限（与 v1 的 4096 字符约束同源） */
export const MAX_TEMPLATE_LEN = 4096;
export const MAX_FRAGMENTS = 64;

function checkFragments(fragments){
 if(!Array.isArray(fragments)||!fragments.length) throw new Error('布局片段不能为空');
 if(fragments.length>MAX_FRAGMENTS) throw new Error('布局片段过多');
 let len=0; const seen=new Set(); let hasText=false; let started=false;
 fragments.forEach((f,i)=>{
  if(!f||typeof f!=='object') throw new Error('布局片段格式不正确');
  if(f.type==='literal'){
   if(typeof f.value!=='string') throw new Error('固定文字必须是文本');
   len+=f.value.length;
   if(i===0){ if(!f.value) throw new Error('布局必须以固定文字开头'); started=true; }
  }else if(f.type==='field'){
   if(!FIELD_NAMES.includes(f.field)) throw new Error('只支持编号、角色名、正文三种字段');
   if(seen.has(f.field)) throw new Error('同一字段在一个布局中只能标注一次');
   const prev=fragments[i-1];
   if(prev&&prev.type==='field') throw new Error('两个字段之间需要固定分隔文字');
   seen.add(f.field);
   if(f.field==='text') hasText=true;
  }else throw new Error('布局片段类型不正确：'+String(f.type));
 });
 if(len>MAX_TEMPLATE_LEN) throw new Error('布局超过 '+MAX_TEMPLATE_LEN+' 字符');
 if(!started) throw new Error('布局必须以固定文字开头');
 if(!hasText) throw new Error('布局需包含正文');
 return {fields:[...seen]};
}

/** 该布局的正文是否跨行（有固定换行文字）——决定正文匹配用 .*? 还是 [\s\S]*? */
export function isMultiline(fragments){
 return (Array.isArray(fragments)?fragments:[]).some(f=>f&&f.type==='literal'&&typeof f.value==='string'&&f.value.includes('\n'));
}

/** 片段 → 正则。与 v1 compile 的产物逐字等价（用 v1 迁移来的片段验证）。 */
export function compileFragments(fragments){
 checkFragments(fragments);
 const multi=isMultiline(fragments);
 const fields=[];
 let pattern='';
 for(const f of fragments){
  if(f.type==='literal'){ pattern+=escape(f.value); continue; }
  fields.push(f.field);
  pattern+=f.field==='text'&&multi?'([\\s\\S]*?)':'([^\\r\\n]*?)';
 }
 return {re:new RegExp(pattern+'(?=\\r?\\n|$)','dy'),fields};
}

/** v1 模板 → 片段。抛出与 compile 相同的错误，保证迁移期行为一致。 */
export function fragmentsFromTemplate(template){
 if(typeof template!=='string') throw new Error('模板不能为空或超过 4096 字符');
 const norm=template.replace(/\r\n/g,'\n');
 if(norm.length>MAX_TEMPLATE_LEN) throw new Error('模板不能为空或超过 4096 字符');
 const parts=norm.split(/(\{(?:text|id|name)\})/);
 const frags=[]; const seen=new Set();
 for(let i=0;i<parts.length;i++){
  const p=parts[i];
  if(i%2){
   const key=p.slice(1,-1);
   if(seen.has(key)) throw new Error('每个字段在同一模板中只能标注一次');
   if(i>1&&!parts[i-1]) throw new Error('两个字段之间需要固定分隔文字');
   seen.add(key);
   frags.push({type:'field',field:key});
  }else{
   if(/\{[^}]*\}/.test(p)) throw new Error('只支持 {text}、{id}、{name} 字段');
   if(p) frags.push({type:'literal',value:p});
  }
 }
 if(!seen.has('text')||!parts[0]) throw new Error('模板需含正文，并以固定文字开头');
 return frags;
}

/** 片段 → v1 模板字符串（用于回显与 v1 兼容导出） */
export function templateFromFragments(fragments){
 checkFragments(fragments);
 return fragments.map(f=>f.type==='literal'?f.value:('{'+f.field+'}')).join('');
}

/** 片段是否完全一致（用于译文布局去重与"原文/译文不得同形"的判定） */
export function sameFragments(a,b){
 const x=Array.isArray(a)?a:[], y=Array.isArray(b)?b:[];
 if(x.length!==y.length) return false;
 return x.every((f,i)=>{
  const g=y[i];
  if(!f||!g||f.type!==g.type) return false;
  return f.type==='literal'?f.value===g.value:f.field===g.field;
 });
}

/** 深拷贝片段（避免调用方改到档案内部结构） */
export function cloneFragments(fragments){
 return (Array.isArray(fragments)?fragments:[]).map(f=>f.type==='literal'
  ?{type:'literal',value:f.value}
  :{type:'field',field:f.field});
}

/* ---------------- v1 → v2 迁移 ---------------- */

/**
 * v1 档案 → v2。无损：单模板变成各一条 pattern，原文语义默认按"对话"。
 * 旧档案无需用户重建；调用方只在**写出**新档案时用 v2。
 */
export function migrateV1ToV2(value){
 if(!value||value.version!==1) throw new Error('不支持的格式档案版本');
 if(typeof value.name!=='string'||!value.name.trim()||value.name.length>100) throw new Error('请填写 1–100 字符的档案名称');
 if(!['id','order'].includes(value.pairing)) throw new Error('配对方式必须是编号或顺序');
 if(!Array.isArray(value.ignore)||value.ignore.length>20||value.ignore.some(s=>typeof s!=='string'||!s.trim()||s.length>100)) throw new Error('忽略前缀格式不正确');
 const src=fragmentsFromTemplate(value.source), tgt=fragmentsFromTemplate(value.target);
 if(value.source===value.target) throw new Error('原文与译文模板不能相同');
 const srcHas=(k)=>src.some(f=>f.type==='field'&&f.field===k);
 const tgtHas=(k)=>tgt.some(f=>f.type==='field'&&f.field===k);
 if(value.pairing==='id'&&(!srcHas('id')||!tgtHas('id'))) throw new Error('编号配对要求两侧均标注编号');
 return {
  version:2, name:value.name.trim(),
  pairing:value.pairing, ignore:[...value.ignore],
  sourcePatterns:[{id:'s1',kind:'dialogue',target:'t1',fragments:src}],
  targetPatterns:[{id:'t1',fragments:tgt}],
 };
}

/* ---------------- v2 校验 ---------------- */

const ID_RE=/^[A-Za-z0-9_-]{1,40}$/;

/** 严格校验 v2 档案，返回深拷贝后的规范化对象。 */
export function validateFormatV2(value){
 if(!value||value.version!==2) throw new Error('不支持的格式档案版本');
 if(typeof value.name!=='string'||!value.name.trim()||value.name.length>100) throw new Error('请填写 1–100 字符的档案名称');
 if(!['id','order'].includes(value.pairing)) throw new Error('配对方式必须是编号或顺序');
 if(!Array.isArray(value.ignore)||value.ignore.length>20||value.ignore.some(s=>typeof s!=='string'||!s.trim()||s.length>100)) throw new Error('忽略前缀格式不正确');

 if(!Array.isArray(value.targetPatterns)||!value.targetPatterns.length) throw new Error('至少需要一个译文布局');
 if(!Array.isArray(value.sourcePatterns)||!value.sourcePatterns.length) throw new Error('至少需要一个原文布局');

 const tids=new Set();
 const targets=value.targetPatterns.map(t=>{
  if(!t||typeof t!=='object') throw new Error('译文布局格式不正确');
  if(!ID_RE.test(String(t.id||''))) throw new Error('译文布局标识不合法');
  if(tids.has(t.id)) throw new Error('译文布局标识重复：'+t.id);
  tids.add(t.id);
  const frags=cloneFragments(t.fragments);
  checkFragments(frags);
  return {id:t.id,fragments:frags};
 });

 const sids=new Set();
 const sources=value.sourcePatterns.map(s=>{
  if(!s||typeof s!=='object') throw new Error('原文布局格式不正确');
  if(!ID_RE.test(String(s.id||''))) throw new Error('原文布局标识不合法');
  if(sids.has(s.id)) throw new Error('原文布局标识重复：'+s.id);
  sids.add(s.id);
  if(!SOURCE_KINDS.includes(s.kind)) throw new Error('原文布局的语义类型必须是对话或旁白');
  if(!tids.has(s.target)) throw new Error('原文布局引用了不存在的译文布局：'+String(s.target));
  const frags=cloneFragments(s.fragments);
  checkFragments(frags);
  return {id:s.id,kind:s.kind,target:s.target,fragments:frags};
 });

 // 同一档案里原文与译文同形 → 任何一行都会同时匹配两侧，属真歧义，直接拒绝
 for(const s of sources)for(const t of targets){
  if(sameFragments(s.fragments,t.fragments)) throw new Error('原文布局与译文布局不能相同：'+s.id);
 }

 if(value.pairing==='id'){
  const srcHasId=sources.some(s=>s.fragments.some(f=>f.type==='field'&&f.field==='id'));
  const tgtHasId=targets.some(t=>t.fragments.some(f=>f.type==='field'&&f.field==='id'));
  if(!srcHasId||!tgtHasId) throw new Error('编号配对要求原文与译文布局均标注编号');
 }

 // 译文布局去重：相同片段只保留一份，sourcePatterns 的引用相应改写。
 // 目的：避免"两种原文共用同一种译文"被当成两种布局而产生伪歧义。
 const dedup=[]; const remap=new Map();
 for(const t of targets){
  const hit=dedup.find(d=>sameFragments(d.fragments,t.fragments));
  if(hit){ remap.set(t.id,hit.id); continue; }
  dedup.push(t); remap.set(t.id,t.id);
 }
 const finalSources=sources.map(s=>({...s,target:remap.get(s.target)}));

 return {
  version:2, name:value.name.trim(),
  pairing:value.pairing, ignore:[...value.ignore],
  sourcePatterns:finalSources, targetPatterns:dedup,
 };
}

/**
 * 统一入口：v1 自动迁移，v2 严格校验。
 * ⚠️ v1 的**返回值形状不变**（仍是 version:1），以免破坏既有调用方与测试。
 *    需要 v2 形状时显式调用 migrateV1ToV2。
 */
export function normalizeFormat(value){
 if(value&&value.version===2) return validateFormatV2(value);
 return validateFormat(value);
}

/* ============================================================
   v2 解析器 —— 多布局共存
   ============================================================
   与 v1 parseFormat 的关键差别：
     - 每行要依次试**所有**原文布局与**所有**译文布局；
     - 同时命中多个不同布局 = 真歧义 → 报错（**不按优先级猜**，见 plan.md 风险表）；
     - 多个原文布局可共用同一译文布局（validateFormatV2 已去重）。

   返回结构与 v1 **完全同形**（text/rule/records/unmatched/errors），
   记录额外带 sourcePattern / targetPattern / kind，便于 UI 显示命中布局。
   ============================================================ */

/**
 * 与 v1 的 match 同构，但接受预编译对象。
 * ⚠️ 用 `String.prototype.match` 而非 `RegExp.prototype.exec`：sticky 正则下两者
 *    行为等价（都从 lastIndex 起匹配），但本项目的安全扫描器会把 `.exec(` 误判为
 *    命令执行（`RegExp.exec` vs `child_process.exec`）。同类误报的完整说明见
 *    docs/DEVELOPMENT.md「安全扫描结论」。v1 的 match 保持原样不动 —— 那是经回归
 *    验证的既有行为。
 */
function matchAt(compiled,text,start){
 compiled.re.lastIndex=start;const m=text.match(compiled.re);if(!m)return null;
 const values={},spans={};compiled.fields.forEach((key,i)=>{values[key]=m[i+1];spans[key]=m.indices[i+1];});
 return {start,end:start+m[0].length,values,spans};
}

/** 在 start 处对一组 layout 逐个试匹配，返回全部命中 */
function matchAny(layouts,text,start){
 const hits=[];
 for(const L of layouts){
  const m=matchAt(L.compiled,text,start);
  if(m) hits.push({layout:L,m});
 }
 return hits;
}

/**
 * 用 v2 档案解析全文。
 * @returns {{text,rule,records,unmatched,errors}} 与 v1 parseFormat 同形
 */
export function parseFormatV2(text,value){
 let rule;
 try{ rule=validateFormatV2(value); }
 catch(e){ return {text,rule:value,records:[],unmatched:[],errors:[e.message]}; }

 const sources=rule.sourcePatterns.map(p=>({...p,compiled:compileFragments(p.fragments)}));
 const targets=rule.targetPatterns.map(p=>({...p,compiled:compileFragments(p.fragments)}));

 const srcHits=[],tgtHits=[],unmatched=[],errors=[];
 let pos=text.charCodeAt(0)===0xfeff?1:0,line=1;

 while(pos<text.length){
  const aHits=matchAny(sources,text,pos), bHits=matchAny(targets,text,pos);
  const endLine=text.indexOf('\n',pos);let end=endLine<0?text.length:endLine+1;

  // 歧义判定：同一侧命中多个不同布局时保守失败（不按顺序优先猜）
  if(aHits.length>1){
   errors.push(`第 ${line} 行同时匹配多个原文布局：${aHits.map(h=>h.layout.id).join('、')}。请补充固定文字以区分。`);
  } else if(bHits.length>1){
   errors.push(`第 ${line} 行同时匹配多个译文布局：${bHits.map(h=>h.layout.id).join('、')}。请补充固定文字以区分。`);
  }

  if(aHits.length&&bHits.length){
   errors.push(`第 ${line} 行同时匹配原文和译文`);
  } else if(aHits.length===1||bHits.length===1){
   const hit=aHits.length===1?aHits[0]:bHits[0];
   const rec={...hit.m,line,layout:hit.layout};
   (aHits.length===1?srcHits:tgtHits).push(rec);
   end=hit.m.end;if(text[end]==='\r')end++;if(text[end]==='\n')end++;
  } else {
   const raw=text.slice(pos,end).replace(/[\r\n]+$/,'');
   if(raw.trim()&&!rule.ignore.some(p=>raw.trimStart().startsWith(p)))unmatched.push({line,text:raw});
  }
  line+=(text.slice(pos,end).match(/\n/g)||[]).length;pos=end;
 }

 const records=[];
 if(rule.pairing==='id'){
  const sm=new Map(),tm=new Map();
  for(const [list,map,side] of [[srcHits,sm,'原文'],[tgtHits,tm,'译文']]){
   for(const m of list){
    const id=m.values.id;
    if(!id||map.has(id))errors.push(`第 ${m.line} 行编号为空或重复：${id}（${side}）`);
    map.set(id,m);
   }
  }
  for(const a of srcHits){
   const b=tm.get(a.values.id);
   if(!b)errors.push(`第 ${a.line} 行找不到配对译文`);
   else records.push({key:a.values.id,source:a,target:b,sourcePattern:a.layout.id,targetPattern:b.layout.id,kind:a.layout.kind});
  }
  for(const b of tgtHits)if(!sm.has(b.values.id))errors.push(`第 ${b.line} 行是孤立译文`);
 } else {
 /**
  * order 配对：按各自出现顺序一一对应。
  *
  * ⚠️ 这里**不检查原文与译文布局的语义类型是否一致** —— kind 是原文布局的属性
  *    （对话/旁白只描述原文），译文布局本就没有这个字段。曾误加过这个检查，
  *    结果每次 order 配对都因 `b.layout.kind === undefined` 而报假错。
  *    顺序错位的真正后果是后续字段取值对不上，由回写校验兜底。
  */
 if(srcHits.length!==tgtHits.length)errors.push(`原文 ${srcHits.length} 条，译文 ${tgtHits.length} 条，数量不一致`);
 for(let i=0;i<Math.min(srcHits.length,tgtHits.length);i++){
  const a=srcHits[i],b=tgtHits[i];
  records.push({key:String(i+1),source:a,target:b,sourcePattern:a.layout.id,targetPattern:b.layout.id,kind:a.layout.kind});
 }
 }
 if(!records.length&&!errors.length)errors.push('没有完整的原译文记录');
 return {text,rule,records,unmatched,errors};
}

/** 统一解析入口：按版本分派，让调用方不必自己判版本 */
export function parseFormatAny(text,rule){
 return (rule&&rule.version===2)?parseFormatV2(text,rule):parseFormat(text,rule);
}

/** 统一自动匹配入口：v1/v2 混在一批里也能工作 */
export function chooseFormatAny(text,rules){
 return (Array.isArray(rules)?rules:[]).map(r=>{
  try{ return parseFormatAny(text,r); }catch(e){ return null; }
 }).filter(d=>d&&!d.errors.length&&!d.unmatched.length);
}
