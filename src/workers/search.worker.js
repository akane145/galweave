// search.worker.js — 搜索 Off-main-thread 执行器
// 接管 computeMatches / countMatches / replaceAllInParasDeltas / jumpToIndex 这几个重活。
// 主线程维护 paras 影子副本:打开文件时全量 post,编辑时发增量 delta。
// 纯逻辑,所有函数也可在 node 下直接 import(便于测试消息协议)。

import * as s from '../search.js';
import { replaceAllInParasDeltas } from '../search-remote.js';

let shadow = []; // 影子 paras: { content, translation, nameTr, isName, id }

function applyDelta(delta){
  if (delta.full){
    shadow = delta.full;
    return;
  }
  for (const d of (delta.changes || [])){
    const p = shadow[d.i];
    if (p){
      if ('translation' in d) p.translation = d.translation;
      if ('nameTr' in d) p.nameTr = d.nameTr;
    }
  }
}

// node:not a real Worker; 导出消息处理器供单测
export function handleMessage(msg){
  if (msg.type === 'sync') { applyDelta(msg.delta); return { ok: true }; }
  if (msg.type === 'computeMatches'){
    return s.computeMatches(shadow, msg.q, msg.scope, msg.cs);
  }
  if (msg.type === 'countMatches'){
    return s.countMatches(shadow, msg.q, msg.scope, msg.cs);
  }
  if (msg.type === 'replaceAllInParas'){
    const r = replaceAllInParasDeltas(shadow, msg.q, msg.rep, msg.scope, msg.cs);
    // 同步把 deltas 应用回 shadow,保持 worker 影子与主线程一致
    for (const d of r.deltas){ const p = shadow[d.i]; if (p){ p.translation = d.translation; p.nameTr = d.nameTr; } }
    return r;
  }
  if (msg.type === 'jumpToIndex'){
    return s.jumpToIndex(shadow, msg.v);
  }
  return { error: 'unknown message: ' + (msg && msg.type) };
}

// 浏览器 Worker 环境自动接通
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.addEventListener === 'function'){
  self.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    // 影子同步消息无 id,无需回包 → 直接处理
    if (msg.type === 'sync'){ handleMessage(msg); return; }
    if (typeof msg.id !== 'number') return;
    try {
      const result = handleMessage(msg.payload || msg);
      self.postMessage({ id: msg.id, result });
    } catch (err){
      self.postMessage({ id: msg.id, error: String((err && err.message) || err) });
    }
  });
}