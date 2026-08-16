// workers-client.js — Worker 调度器(主线程侧)
// 为 search/recognize 两个 worker 提供统一调用接口;
// 生产/测试都能用(node 下 useRealWorker=false 走同步 in-process 处理器)。
import * as fsx from './fs.js';

let searchW = null, recogW = null;
let nextId = 1;
const pending = new Map();

function ensureSearch(){
  if (searchW) return searchW;
  // 浏览器:构造真正的 Worker(vite 支持 new Worker(new URL(...)))
  // 单文件 HTML(file:// 协议)下独立 worker 文件无法加载,new Worker 会抛错 →
  // 返回 null 由 callWorker 走 in-process 同步降级(与旧版行为一致)。
  if (typeof Worker !== 'undefined' && typeof window !== 'undefined'){
    try {
      searchW = new Worker(new URL('./workers/search.worker.js', import.meta.url), { type: 'module' });
      searchW.addEventListener('message', (e) => {
        const m = e.data;
        const p = m && pending.get(m.id);
        if (p){ pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result); }
      });
      return searchW;
    } catch (e){
      console.warn('[workers] search worker 创建失败,降级为同步:', e.message);
      return null;
    }
  }
  return null;
}

function ensureRecog(){
  if (recogW) return recogW;
  if (typeof Worker !== 'undefined' && typeof window !== 'undefined'){
    try {
      recogW = new Worker(new URL('./workers/recognize.worker.js', import.meta.url), { type: 'module' });
      recogW.addEventListener('message', (e) => {
        const m = e.data;
        const p = m && pending.get(m.id);
        if (p){ pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result); }
      });
      return recogW;
    } catch (e){
      console.warn('[workers] recognize worker 创建失败,降级为同步:', e.message);
      return null;
    }
  }
  return null;
}

async function callWorker(which, payload){
  const w = which === 'search' ? ensureSearch() : ensureRecog();
  if (!w){
    // node/不支持 Worker 的环境 → 走同步 in-process 处理器(便于单测)
    const mod = which === 'search'
      ? await import('./workers/search.worker.js')
      : await import('./workers/recognize.worker.js');
    return mod.handleMessage(payload);
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, payload });
  });
}

export async function searchComputeMatches(paras, q, scope, cs){
  return callWorker('search', { type: 'computeMatches', q, scope, cs });
}
export async function searchCountMatches(q, scope, cs){
  return callWorker('search', { type: 'countMatches', q, scope, cs });
}
export async function searchReplaceAll(q, rep, scope, cs){
  return callWorker('search', { type: 'replaceAllInParas', q, rep, scope, cs });
}
export async function searchJumpToIndex(v){
  return callWorker('search', { type: 'jumpToIndex', v });
}
export async function recogDetect(text, file){
  return callWorker('recog', { type: 'detect', text, file });
}
export async function recogCanonicalize(profile){
  return callWorker('recog', { type: 'canonicalize', profile });
}
export async function recogRestore(profile, canonicalText){
  return callWorker('recog', { type: 'restore', profile, canonicalText });
}
export async function recogAnalyzeWithParsers(text, config, label){
  return callWorker('recog', { type: 'analyzeWithParsers', text, config, label });
}

/** 用 paras 影子副本同步给 search worker(打开文件时全量,编辑时发 delta) */
export function syncSearchShadow(delta){
  if (delta.full && ensureSearch()){
    // 拷贝一份避免 worker 侧改 model 对象
    const snapshot = delta.full.map(p => ({
      content: p.content, translation: p.translation, nameTr: p.nameTr,
      isName: !!p.isName, id: p.id || '',
    }));
    ensureSearch().postMessage({ type: 'sync', delta: { full: snapshot } });
    return;
  }
  if (ensureSearch()){
    let safe = { changes: [] };
    for (const c of (delta.changes || [])){
      safe.changes.push({ i: c.i, translation: c.translation, nameTr: c.nameTr });
    }
    ensureSearch().postMessage({ type: 'sync', delta: safe });
  }
}

export function _dispose(){
  if (searchW){ searchW.terminate(); searchW = null; }
  if (recogW){ recogW.terminate(); recogW = null; }
  pending.clear();
}