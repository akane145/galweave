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
 * 在词条表中查词: 词条/读音精确命中优先;无精确命中时返回词条或读音前缀补全(≤20 条);
 * opts.fuzzy 且精确/前缀均无结果时,再尝试包含匹配(≤20 条)。
 * 返回(不含 source 字段,由 Provider 补上)。
 */
export function matchEntries(entries, word, opts){
  const out = [];
  const norm = String(word || '').trim();
  const fuzzy = !!(opts && opts.fuzzy);
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
  if (pref.length) return pref;
  // 模糊: 包含匹配
  if (fuzzy){
    const inc = [];
    for (const [head, ent] of Object.entries(entries)){
      if (head.includes(norm) || (ent.reading && ent.reading.includes(norm))){
        inc.push({ headword: head, ...ent });
        if (inc.length >= 20) break;
      }
    }
    return inc;
  }
  return out;
}

/**
 * 把多个 Provider 的查询结果按 词头(+读音) 分组: 同一词条在多个词典命中 → 并入一张卡片,
 * 组内按来源分段。保持查询返回顺序(精确/前缀优先,模糊在后)。
 * group: { headword, reading, sources:[{ source, senses }] }
 */
export function groupDictResults(results){
  const groups = new Map();
  for (const r of results || []){
    if (!r || r.headword === undefined || r.headword === null) continue;
    const key = r.headword + '\u0000' + (r.reading || '');
    if (!groups.has(key)) groups.set(key, { headword: r.headword, reading: r.reading || '', sources: [] });
    groups.get(key).sources.push({ source: r.source, sourceId: r.sourceId || r.source, senses: r.senses || [] });
  }
  return [...groups.values()];
}

/* ---------------- 收藏(纯逻辑) ---------------- */

/**
 * 按 (source, headword, reading) 去重查询结果，保留首次出现。不改原数组。
 * 用于：①变形还原命中与主查询(MDX 前缀补全)合并时，同一词头可能来自两路；
 *      ②Provider 自身返回重复条目的兜底。分组键与 groupDictResults 对齐(词头+读音)。
 */
export function dedupeResults(results){
  const seen = new Set();
  const out = [];
  for (const r of results || []){
    if (!r) continue;
    const k = (r.source || '') + '\u0000' + r.headword + '\u0000' + (r.reading || '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** 收藏条目唯一键: word|reading|source */
export function favoriteKey(f){
  return (f && f.word || '') + '\u0000' + (f && f.reading || '') + '\u0000' + (f && f.source || '');
}

/** 是否已收藏 */
export function isFavorite(list, f){
  const k = favoriteKey(f);
  return (list || []).some(x => favoriteKey(x) === k);
}

/** 切换收藏,返回新列表。fav={word,reading,source} */
export function toggleFavorite(list, fav){
  const k = favoriteKey(fav);
  if ((list || []).some(x => favoriteKey(x) === k)){
    return (list || []).filter(x => favoriteKey(x) !== k);
  }
  return [...(list || []), { word: fav.word, reading: fav.reading || '', source: fav.source || '', at: Date.now() }];
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

/** 单 Provider 模糊查询: 优先 lookupFuzzy(JSON);有 search(词头)的(MDX)先搜词头再逐词查;否则回退精确 lookup */
async function fuzzyLookup(p, word){
  if (typeof p.lookupFuzzy === 'function') return p.lookupFuzzy(word);
  if (typeof p.search === 'function'){
    const heads = await p.search(word, 20);
    const out = [];
    const seen = new Set();
    for (const h of heads){
      // 词头去重:MDX 词表里同一 key_text 可能登记多次(同义词组/@@@LINK 变体),
      // 不去重会对同一个词发起多次 lookup 并把同一条目重复并入结果(Rust 侧已去重,此处兜底)。
      const k = String(h == null ? '' : h).trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      try { const hits = await p.lookup(k); out.push(...(hits || [])); } catch (e) { /* 单条失败跳过 */ }
    }
    return out;
  }
  if (typeof p.lookup === 'function') return p.lookup(word);
  return [];
}

/** 模糊(包含)并发查询所有已配置 Provider */
export async function lookupAllFuzzy(word, list){
  const active = (list || getProviders()).filter(p => p.isConfigured());
  const rs = await Promise.allSettled(active.map(p => fuzzyLookup(p, word)));
  const results = [], errors = [];
  rs.forEach((r, i) => {
    if (r.status === 'fulfilled') results.push(...r.value);
    else errors.push({ source: active[i].name, message: String((r.reason && r.reason.message) || r.reason || '查询失败') });
  });
  return { word: String(word || ''), results, errors };
}

/**
 * 是否有**直接命中**（词头或读音精确等于查询词）。
 *
 * ⚠️ 为什么不能用「results 非空」代替：
 *    MDX provider 在精确未命中时会返回**前缀补全**（`src/mdx.js:535-544`，最多 6 条）。
 *    于是「查 食べた 得到 食べすぎ/食べる/食べ物…」这种情况 results 非空，
 *    但**没有一条是 食べた**。若按非空判断，变形还原因误以为"查到了"而永不生效。
 *
 * JSON/HTTP provider 只返回精确或前缀命中，同样适用：只有 headword/reading 全等于
 * 查询词才算直接命中。
 *
 * @param {Array} results lookupAll 的 results
 * @param {string} word 查询词
 */
export function hasDirectHit(results, word){
  const want = String(word == null ? '' : word).trim();
  if (!want) return false;
  return (Array.isArray(results) ? results : []).some(r => {
    if (!r) return false;
    const head = String(r.headword == null ? '' : r.headword).trim();
    const reading = String(r.reading == null ? '' : r.reading).trim();
    return head === want || reading === want;
  });
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
    // 模糊(包含)查询: 复用同一加载缓存
    async lookupFuzzy(word){
      if (failedErr) throw failedErr;
      if (!entries && cfg.path){
        try {
          const raw = await (cfg.loadFile || defaultLoadFile)(cfg.path);
          const parsed = raw ? parseDictJson(raw) : null;
          if (!parsed) throw new Error('词典文件不存在或格式不合法: ' + (cfg.path || name));
          entries = parsed.entries;
        } catch (e){ failedErr = e; throw e; }
      }
      if (!entries) return [];
      return matchEntries(entries, word, { fuzzy: true }).map(e => ({ ...e, source: name }));
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

