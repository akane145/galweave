// recognize.worker.js — 识别 Off-main-thread 执行器
// 接管 detect / canonicalize / restore / analyzeWithParsers(后者在 worker 内 import parsers 模块,
// 不再接收注入对象,因为函数无法跨 worker 边界传递)。
import { detect as recogDetect, canonicalize, restore, renderReport, analyzeWithParsers } from '../recognize.js';
import { parseFile, setParseConf, buildExport } from '../parsers.js';

const parsers = { parseFile, setParseConf, buildExport };

export function handleMessage(msg){
  if (msg.type === 'detect') return recogDetect(msg.text, msg.file || '');
  if (msg.type === 'canonicalize') return canonicalize(msg.profile);
  if (msg.type === 'restore') return restore(msg.profile, msg.canonicalText);
  if (msg.type === 'renderReport') return renderReport(msg.profile);
  if (msg.type === 'analyzeWithParsers'){
    // 直接复用 recognize.analyzeWithParsers;worker 内已 import parsers,
    // 不跨边界传函数。返回与 recognize 原始同构的 { paras, withId, named, roundTrip }。
    return analyzeWithParsers(parsers, msg.text, msg.config || {}, msg.label || '');
  }
  return { error: 'unknown message: ' + (msg && msg.type) };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof self.addEventListener === 'function'){
  self.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') return;
    try {
      const result = handleMessage(msg.payload || msg);
      self.postMessage({ id: msg.id, result });
    } catch (err){
      self.postMessage({ id: msg.id, error: String((err && err.message) || err) });
    }
  });
}