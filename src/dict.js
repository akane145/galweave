// dict.js — 词典 Provider 框架(统一查询接口,镜像 mt.js 注册模式)
//
// Provider 接口: { id, name, isConfigured(), lookup(word) → Promise<DictResult[]> }
// DictResult = {
//   headword: string,                 // 词条
//   reading?: string,                 // 读音(假名)
//   senses: [{ pos?, gloss, examples?: [{src, dst}] }],  // 释义(词性/释义/例句)
//   source: string,                   // 来源词典名
// }
//
// 内置适配器:
//   JsonDictProvider — 本地 JSON 词典文件(galtrans-dict-v1 格式,懒加载+缓存)
//   HttpDictProvider — 自定义 HTTP 词典(URL 模板 + 点路径字段映射)
//   (MDX 适配器见 src/mdx.js)
// 运行: node --test tests/dict.test.mjs

/* ================= 纯逻辑(可单测) ================= */

/** 单条释义归一化: 字符串 → {gloss};对象取 pos/gloss/examples */
function normalizeSense(s){
  if (typeof s === 'string') return { gloss: s };
  if (s && typeof s === 'object'){
    const gloss = String(s.gloss || '').trim();
    if (!gloss) return null;
    const out = { gloss };
    if (s.pos) out.pos = String(s.pos);
    if (Array.isArray(s.examples) && s.examples.length){
      out.examples = s.examples
        .map(ex => (ex && typeof ex === 'object') ? { src: String(ex.src || ''), dst: String(ex.dst || '') } : null)
        .filter(ex => ex && (ex.src || ex.dst));
    }
    return out;
  }
  return null;
}

/** 词条值归一化: '简单释义' | {reading, senses:[...]} → {reading, senses} */
export function normalizeEntry(v){
  if (typeof v === 'string'){
    const t = v.trim();
    return t ? { reading: '', senses: [{ gloss: t }] } : null;
  }
  if (v && typeof v === 'object'){
    const senses = (Array.isArray(v.senses) ? v.senses : []).map(normalizeSense).filter(Boolean);
    if (!senses.length) return null;
    return { reading: v.reading ? String(v.reading) : '', senses };
  }
  return null;
}

/**
 * 解析词典 JSON 文本(galtrans-dict-v1):
 * { format:'galtrans-dict-v1', name, entries: { 词: '释义' | {reading, senses:[...]} } }
 * 不合法返回 null。
 */
export function parseDictJson(text){
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object' || !obj.entries || typeof obj.entries !== 'object') return null;
  const entries = {};
  for (const [k, v] of Object.entries(obj.entries)){
    const ent = normalizeEntry(v);
    if (k && ent) entries[k] = ent;
  }
  return { name: obj.name ? String(obj.name) : '未命名词典', entries };
}

/**
 * 在词条表中查词: 词条/读音精确命中优先;无精确命中时返回词条或读音前缀补全(≤20 条)。
 * 返回(不含 source 字段,由 Provider 补上)。
 */
export function matchEntries(entries, word){
  const out = [];
  const norm = String(word || '').trim();
  if (!norm || !entries) return out;
  for (const [head, ent] of Object.entries(entries)){
    if (head === norm || (ent.reading && ent.reading === norm)) out.push({ headword: head, ...ent });
  }
  if (out.length) return out;
  const pref = [];
  for (const [head, ent] of Object.entries(entries)){
    if (head.startsWith(norm) || (ent.reading && ent.reading.startsWith(norm))){
      pref.push({ headword: head, ...ent });
      if (pref.length >= 20) break;
    }
  }
  return pref;
}

/** '$.a.b.0.c' 点路径取值('$' = 根);路径不合法或找不到返回 undefined */
export function extractPath(obj, path){
  if (path === undefined || path === null || path === '' || path === '$') return obj;
  if (typeof path !== 'string' || !path.startsWith('$.') || path.length < 3) return undefined;
  let cur = obj;
  for (const seg of path.slice(2).split('.')){
    if (cur == null || seg === '') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 释义原始值 → senses 数组: string | string[] | {pos,gloss} | [{pos,gloss|translation|text}] */
function toSenses(g){
  if (g === undefined || g === null) return [];
  if (typeof g === 'string'){
    const t = g.trim();
    return t ? [{ gloss: t }] : [];
  }
  if (Array.isArray(g)){
    return g.map(x => {
      if (typeof x === 'string') return x.trim() ? { gloss: x.trim() } : null;
      if (x && typeof x === 'object'){
        const gloss = String(x.gloss || x.translation || x.text || '').trim();
        if (!gloss) return null;
        return x.pos ? { pos: String(x.pos), gloss } : { gloss };
      }
      return null;
    }).filter(Boolean);
  }
  if (typeof g === 'object'){
    const gloss = String(g.gloss || g.translation || g.text || '').trim();
    return gloss ? [g.pos ? { pos: String(g.pos), gloss } : { gloss }] : [];
  }
  return [];
}

/**
 * HTTP 响应 → DictResult[](纯函数)。
 * map: { root?, headword?, reading?, gloss? } — 均为 '$.a.b' 点路径;
 * gloss 可指向字符串/字符串数组/{pos,gloss} 数组;root 指向条目数组(单条也兼容)。
 */
export function httpToResults(data, map, sourceName, word){
  const m = map || {};
  const root = m.root !== undefined ? extractPath(data, m.root) : data;
  const items = Array.isArray(root) ? root : [root];
  const out = [];
  for (const it of items){
    if (it === null || it === undefined) continue;
    if (typeof it === 'string'){
      const senses = toSenses(it);
      if (senses.length) out.push({ headword: String(word), reading: '', senses, source: sourceName });
      continue;
    }
    if (typeof it !== 'object') continue;
    const glossRaw = m.gloss !== undefined ? extractPath(it, m.gloss) : undefined;
    const senses = toSenses(glossRaw);
    if (!senses.length) continue;
    out.push({
      headword: String((m.headword !== undefined ? extractPath(it, m.headword) : undefined) || word),
      reading: String((m.reading !== undefined ? extractPath(it, m.reading) : undefined) || ''),
      senses,
      source: sourceName,
    });
  }
  return out;
}

/* ================= Provider 注册表(镜像 mt.js) ================= */

const providers = [];

export function registerProvider(p){
  if (p && p.id && typeof p.lookup === 'function' && !providers.some(x => x.id === p.id)) providers.push(p);
}
export function getProviders(){ return providers.slice(); }
export function getProvider(id){ return providers.find(p => p.id === id) || null; }
export function clearProviders(){ providers.length = 0; } // 测试用

/** 并发查询所有已配置 Provider;单个失败不影响其余。返回 { word, results, errors } */
export async function lookupAll(word, list){
  const active = (list || getProviders()).filter(p => p.isConfigured());
  const rs = await Promise.allSettled(active.map(p => p.lookup(word)));
  const results = [], errors = [];
  rs.forEach((r, i) => {
    if (r.status === 'fulfilled') results.push(...r.value);
    else errors.push({ source: active[i].name, message: String((r.reason && r.reason.message) || r.reason || '查询失败') });
  });
  return { word: String(word || ''), results, errors };
}

/* ================= 内置适配器 ================= */

/** 本地 JSON 词典适配器。
 * cfg: { id?, name, path?, entries?, loadFile? }
 * 桌面版传 path(首次查询时经 fs.readTextFileSource 懒加载并缓存);
 * 浏览器版/测试传 entries(已解析的词条对象)或注入 loadFile。 */
/** 原始词条对象 → 归一化词条表(字符串简写也接受) */
function normalizeEntries(raw){
  const entries = {};
  for (const [k, v] of Object.entries(raw || {})){
    const ent = normalizeEntry(v);
    if (k && ent) entries[k] = ent;
  }
  return entries;
}

export function createJsonDictProvider(cfg){
  let entries = cfg.entries ? normalizeEntries(cfg.entries) : null;
  let failedErr = null;
  const name = cfg.name || '本地词典';
  const id = cfg.id || 'json:' + (cfg.path || name);
  async function defaultLoadFile(path){
    const { readTextFileSource } = await import('./fs.js');
    return readTextFileSource(path);
  }
  return {
    id, name,
    isConfigured(){ return !!(entries || (cfg.path && !failedErr)); },
    async lookup(word){
      if (failedErr) throw failedErr; // 加载失败后持续报错,便于 UI 展示原因
      if (!entries && cfg.path){
        try {
          const raw = await (cfg.loadFile || defaultLoadFile)(cfg.path);
          const parsed = raw ? parseDictJson(raw) : null;
          if (!parsed) throw new Error('词典文件不存在或格式不合法: ' + (cfg.path || name));
          entries = parsed.entries;
        } catch (e){
          failedErr = e;
          throw e;
        }
      }
      if (!entries) return [];
      return matchEntries(entries, word).map(e => ({ ...e, source: name }));
    },
  };
}

/** HTTP 词典适配器。
 * cfg: { id?, name, urlTemplate('含{word}占位'), method?, headers?, timeoutMs?, map?, fetchImpl? }
 * map 同 httpToResults;headers 可携带 API Key;timeoutMs 默认 8000。 */
export function createHttpDictProvider(cfg){
  const name = cfg.name || 'HTTP 词典';
  const id = cfg.id || 'http:' + (cfg.urlTemplate || name);
  const fetchImpl = cfg.fetchImpl || ((u, o) => fetch(u, o));
  return {
    id, name,
    isConfigured(){ return !!cfg.urlTemplate && String(cfg.urlTemplate).includes('{word}'); },
    async lookup(word){
      if (!this.isConfigured()) throw new Error('HTTP 词典未配置含 {word} 的 URL 模板');
      const url = String(cfg.urlTemplate).replace(/\{word\}/g, encodeURIComponent(word));
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), cfg.timeoutMs || 8000) : null;
      let resp;
      try {
        resp = await fetchImpl(url, {
          method: cfg.method || 'GET',
          headers: cfg.headers || {},
          signal: ctrl ? ctrl.signal : undefined,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!resp || !resp.ok) throw new Error('HTTP ' + (resp ? resp.status : '无响应'));
      let data;
      try { data = await resp.json(); }
      catch (e){ throw new Error('响应不是合法 JSON'); }
      return httpToResults(data, cfg.map, name, word);
    },
  };
}

