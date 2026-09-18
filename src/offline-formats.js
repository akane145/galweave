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
export function exportFormat(document,edits){
 if(document.errors.length||edits.length!==document.records.length)throw new Error('格式记录不完整，不能安全导出');
 const replacements=[];
 document.records.forEach((r,i)=>{
  const edit=edits[i];
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
 const check=parseFormat(output,document.rule);
 if(check.errors.length||check.records.length!==document.records.length||JSON.stringify(check.unmatched.map(x=>x.text))!==JSON.stringify(document.unmatched.map(x=>x.text)))throw new Error('编辑内容改变了文件结构，请检查换行、编号和结束标记');
 for(let i=0;i<check.records.length;i++){
  const a=document.records[i],b=check.records[i];
  const nameChanged = a.target.spans.name && b.target.values.name !== (edits[i].nameTr ?? a.target.values.name);
  if(a.key!==b.key||JSON.stringify(a.source.values)!==JSON.stringify(b.source.values)||b.target.values.text!==(edits[i].translation??a.target.values.text)||nameChanged) throw new Error('回写校验失败，原文或字段边界发生变化');
 }
 return output;
}
export function formatParas(doc){
 if(doc.errors.length)throw new Error(doc.errors.join('\n'));
 return doc.records.map((r,i)=>{
  const name=r.source.values.name||'',translation=r.target.values.text;
  return {orig:`☆offline:${r.key}☆☆${r.source.values.text}`,prefix:'',content:r.source.values.text,id:r.key,name,nameTr:r.target.values.name??name,segs:[r.key,''],isName:false,brackets:false,translation,done:!!translation.trim(),offlineKey:r.key,...(i===0?{offlineDocument:doc}:{})};
 });
}
