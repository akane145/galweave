// format-editor-state.js — 多样例布局编辑器的状态模型（纯逻辑，无 DOM）。
//
// 为什么单独抽出来：Task 6 的验收要求"为 DOM 独立的 UI 状态转换补纯逻辑测试"。
// 编辑器的状态机（布局的增删、样例对的增删、标注的增删、从 v2 档案回填）
// 都是纯数据变换，把它们从 DOM 里分离出来才能真正被测到 ——
// 否则只能靠手点，而手点覆盖不到"取消选择后状态是否一致"这类边界。
//
// 状态形状：
//   {
//     name: string,
//     pairing: 'id'|'order',
//     ignore: string[],
//     layouts: [{
//       id: string,                 // 稳定标识，重命名不影响
//       title: string,
//       kind: 'dialogue'|'narration',
//       source: { samples: [ sample ] },
//       target: { samples: [ sample ] },
//     }]
//   }
//   sample = { text: string, marks: [{start,end,field}] }
//
// 译文侧没有 kind（它是原文布局的属性）——与 offline-formats 的 v2 契约一致。

import { FIELD_NAMES, FIELD_LABEL, MAX_FRAGMENTS } from './offline-formats.js';

/** 新建布局时的默认标题 */
export const DEFAULT_TITLES = { dialogue: '对话', narration: '旁白' };

const SAMPLE_VALUES = [
 { id:'1', name:'角色甲', text:'样例甲' },
 { id:'2', name:'角色乙', text:'样例乙' },
];

let _seq = 0;
/** 生成稳定 id（不用随机数：便于测试复现，也避免不必要的熵） */
export function nextId(prefix){
 _seq += 1;
 return (prefix||'x') + _seq;
}
/** 测试用：重置 id 序号 */
export function resetIdSeq(){ _seq = 0; }

/* ---------------- 构造 ---------------- */

/** 新建一个空布局（各带一组空样例，方便用户直接粘贴） */
export function createLayout(kind){
 const k = kind === 'narration' ? 'narration' : 'dialogue';
 return {
  id: nextId('L'),
  title: DEFAULT_TITLES[k],
  kind: k,
  source: { samples: [createSample()] },
  target: { samples: [createSample()] },
 };
}

export function createSample(){
 return { text: '', marks: [] };
}

/** 新建编辑器状态（默认一个对话布局） */
export function createEditorState(){
 return {
  name: '',
  pairing: 'order',
  ignore: [],
  layouts: [createLayout('dialogue')],
 };
}

/* ---------------- 布局操作 ---------------- */

export function addLayout(state, kind){
 const s = cloneState(state);
 s.layouts.push(createLayout(kind));
 return s;
}

export function removeLayout(state, layoutId){
 const s = cloneState(state);
 s.layouts = s.layouts.filter(l => l.id !== layoutId);
 return s;
}

export function setLayoutKind(state, layoutId, kind){
 const s = cloneState(state);
 const L = s.layouts.find(l => l.id === layoutId);
 if (L) L.kind = kind === 'narration' ? 'narration' : 'dialogue';
 return s;
}

export function setLayoutTitle(state, layoutId, title){
 const s = cloneState(state);
 const L = s.layouts.find(l => l.id === layoutId);
 if (L) L.title = String(title == null ? '' : title).slice(0, 60);
 return s;
}

/* ---------------- 样例操作 ---------------- */

/**
 * 加一组样例。**同时给原文与译文两侧加** —— 一组样例天然是原译文成对的，
 * 分开加会让两侧数量不齐，而配对本身要求两侧一一对应。
 */
export function addSample(state, layoutId){
 const s = cloneState(state);
 const L = s.layouts.find(l => l.id === layoutId);
 if (L){ L.source.samples.push(createSample()); L.target.samples.push(createSample()); }
 return s;
}

export function removeSample(state, layoutId, index){
 const s = cloneState(state);
 const L = s.layouts.find(l => l.id === layoutId);
 if (!L) return s;
 if (index >= 0 && index < L.source.samples.length) L.source.samples.splice(index, 1);
 if (index >= 0 && index < L.target.samples.length) L.target.samples.splice(index, 1);
 // 允许清空到 0 组：由 inferLayout 在生成时明确报"至少 2 组"，
 // 而不是在这里静默补一组（那样用户删不掉最后一组，很困惑）
 return s;
}

export function setSampleText(state, layoutId, side, index, text){
 const s = cloneState(state);
 const L = s.layouts.find(l => l.id === layoutId);
 if (!L) return s;
 const box = L[side === 'target' ? 'target' : 'source'];
 const sample = box.samples[index];
 if (!sample) return s;
 const next = String(text == null ? '' : text);
 if (sample.text === next) return s;
 sample.text = next;
 // ⚠️ 文本变了 → **清空该样例的标注**。
 //    标注是"字符区间"，文本一改区间就指向别处：若保留，UI 会把 A 处标成 B 处的内容，
 //    且用户看不出错在哪（显示的是真文本，只是标错了位置）。
 //    清空是"可预测的正确"：用户粘完样例再标注，改完文本重标即可。
 //    曾因为保留旧坐标导致首次打开面板（用内置模板回填）后覆盖样例时标注全错位。
 sample.marks = [];
 return s;
}

/* ---------------- 标注操作 ---------------- */

/**
 * 在一组样例上加标注。
 * 与已有标注重叠、或同字段已存在时**返回原状态**（不改动），由调用方提示原因。
 * @returns {{state:object, ok:boolean, error:string}}
 */
export function addMark(state, layoutId, side, index, mark){
 const s = cloneState(state);
 const L = s.layouts.find(l => l.id === layoutId);
 if (!L) return { state: s, ok:false, error:'找不到该布局' };
 const box = L[side === 'target' ? 'target' : 'source'];
 const sample = box.samples[index];
 if (!sample) return { state: s, ok:false, error:'找不到该样例' };
 const { start, end, field } = mark || {};
 if (!FIELD_NAMES.includes(field)) return { state: s, ok:false, error:'只能标注为编号、角色名或正文' };
 if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) return { state: s, ok:false, error:'请先选中要标注的文字' };
 if (start < 0 || end > sample.text.length) return { state: s, ok:false, error:'标注超出了样例文本范围' };
 if (sample.marks.some(m => m.field === field)) return { state: s, ok:false, error:'这一组里已经有「' + fieldLabel(field) + '」了' };
 if (sample.marks.some(m => start < m.end && m.start < end)) return { state: s, ok:false, error:'与已有标注重叠了' };
 if (sample.marks.length >= MAX_FRAGMENTS) return { state: s, ok:false, error:'标注数量过多' };
 sample.marks.push({ start, end, field });
 sample.marks.sort((a,b) => a.start - b.start);
 return { state: s, ok:true, error:'' };
}

/** 撤销一处标注：按字段名（UI 上每处标注都显示字段名，点它即可撤销） */
export function removeMark(state, layoutId, side, index, field){
 const s = cloneState(state);
 const L = s.layouts.find(l => l.id === layoutId);
 if (!L) return s;
 const box = L[side === 'target' ? 'target' : 'source'];
 const sample = box.samples[index];
 if (!sample) return s;
 sample.marks = sample.marks.filter(m => m.field !== field);
 return s;
}

export function fieldLabel(field){
 return FIELD_LABEL[field] || field;
}

/* ---------------- v2 档案 → 编辑器状态 ---------------- */

/**
 * 把已有 v2 档案回填进编辑器（"使用档案"按钮）。
 * v1 档案先迁移成 v2 再回填，用户看到的是统一的多样例界面。
 *
 * 标注区间由片段反推：把片段拼成模板串，再定位每个字段在串中的区间。
 * 样例文本用模板串本身 —— 模板里的 `{text}` 就是"未填内容的样例"，
 * 用户下次编辑时直接覆盖即可。
 */
export function stateFromRule(rule){
 const v2 = rule && rule.version === 2 ? rule : null;
 if (!v2) return null;
 const layouts = [];
 for (const sp of v2.sourcePatterns || []){
  const tp = (v2.targetPatterns || []).find(t => t.id === sp.target);
  if (!tp) continue;
  layouts.push({
   id: nextId('L'),
   title: '',
   kind: sp.kind === 'narration' ? 'narration' : 'dialogue',
   source: { samples: [sampleFromFragments(sp.fragments,0),sampleFromFragments(sp.fragments,1)] },
   target: { samples: [sampleFromFragments(tp.fragments,0),sampleFromFragments(tp.fragments,1)] },
  });
 }
 const out = {
  name: v2.name || '',
  pairing: v2.pairing === 'id' ? 'id' : 'order',
  ignore: Array.isArray(v2.ignore) ? [...v2.ignore] : [],
  layouts,
 };
 // 标题用图案标识回填不方便（档案里没存），统一给默认名
 out.layouts.forEach(l => { l.title = DEFAULT_TITLES[l.kind]; });
 return out;
}

/**
 * 从片段生成一组可直接归纳的示例文本与精确标注区间。
 *
 * 档案只保存结构，不保存用户原始脚本文本，因此这里使用明确的合成值。
 * 两组不同的值既能让多样例归纳立即通过，也避免把 `{text}` 这种模板语法
 * 当成真实样例后产生错位标注。
 */
export function sampleFromFragments(fragments, sampleIndex=0){
 const values=SAMPLE_VALUES[sampleIndex===1?1:0];
 let text='';
 const marks = [];
 for (const f of Array.isArray(fragments) ? fragments : []){
  if (f.type === 'literal'){ text+=String(f.value||''); continue; }
  const value=values[f.field]||String(f.field||'字段');
  const start=text.length;
  text+=value;
  marks.push({start,end:text.length,field:f.field});
 }
 return {text,marks};
}

/* ---------------- 状态 → v2 档案 ---------------- */

/**
 * 由编辑器状态生成 v2 档案。
 *
 * @param {object} state
 * @param {(samples:Array)=>object} infer 归纳函数（注入 format-samples.inferLayout，
 *        便于单测替换；也避免本模块直接依赖归纳实现）
 * @returns {{ok:boolean, rule:object|null, errors:Array<{layout:string, side:string, message:string}>}}
 */
export function buildRule(state, infer){
 const s = state || {};
 const errors = [];
 const sourcePatterns = [];
 const targetPatterns = [];
 const targetByKey = new Map();   // 片段指纹 → 已生成的译文 pattern id（去重）

 (s.layouts || []).forEach((L, li) => {
  const title = L.title || ('布局 ' + (li+1));
  const src = infer((L.source?.samples) || []);
  if (!src.ok){ errors.push({ layout: title, side:'source', message: src.error }); return; }
  const tgt = infer((L.target?.samples) || []);
  if (!tgt.ok){ errors.push({ layout: title, side:'target', message: tgt.error }); return; }

  // 译文布局去重：相同则复用同一个 id（与 validateFormatV2 的去重一致）
  const key = JSON.stringify(tgt.fragments);
  let tid = targetByKey.get(key);
  if (!tid){
   tid = 't' + (targetPatterns.length + 1);
   targetByKey.set(key, tid);
   targetPatterns.push({ id:tid, fragments:tgt.fragments });
  }
  sourcePatterns.push({
   id: 's' + (sourcePatterns.length + 1),
   kind: L.kind === 'narration' ? 'narration' : 'dialogue',
   target: tid,
   fragments: src.fragments,
  });
 });

 if (!sourcePatterns.length){
  return { ok:false, rule:null, errors: errors.length ? errors
   : [{ layout:'', side:'', message:'还没有可用的布局。每个布局需要至少两组已标注的样例。' }] };
 }
 return {
  ok:true,
  rule: {
   version:2,
   name: String(s.name || '').trim(),
   pairing: s.pairing === 'id' ? 'id' : 'order',
   ignore: Array.isArray(s.ignore) ? [...s.ignore] : [],
   sourcePatterns, targetPatterns,
  },
  errors,
 };
}

/* ---------------- 工具 ---------------- */

/** 深拷贝状态（所有变更函数都返回新对象，避免 UI 侧意外共享引用） */
export function cloneState(state){
 const s = state || createEditorState();
 return {
  name: String(s.name || ''),
  pairing: s.pairing === 'id' ? 'id' : 'order',
  ignore: Array.isArray(s.ignore) ? [...s.ignore] : [],
  layouts: (Array.isArray(s.layouts) ? s.layouts : []).map(L => ({
   id: L.id,
   title: String(L.title || ''),
   kind: L.kind === 'narration' ? 'narration' : 'dialogue',
   source: { samples: cloneSamples(L.source) },
   target: { samples: cloneSamples(L.target) },
  })),
 };
}

function cloneSamples(box){
 return ((box && box.samples) || []).map(x => ({
  text: String(x && x.text != null ? x.text : ''),
  marks: ((x && x.marks) || []).map(m => ({ start:m.start, end:m.end, field:m.field })),
 }));
}
