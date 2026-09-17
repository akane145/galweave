// dict-history.js — 查词历史（纯逻辑，不依赖 DOM）
//
// 词典有收藏（ds favorites）但一直没有"我刚刚查过什么"。
// 词典面板的「查询」视图里加一条最近查询 chip 行：点击重查，来源标注区分"划词"与"手输"。
//
// 设计取舍：
//   - **按词去重、命中即提前**（而不是追加）。同一句话里反复点同一个词，历史不该被单一词条刷满。
//   - 上限 100 条（ROADMAP P2-5 的规定值），超出丢弃最旧。
//   - 比较用**规范化后的串**（trim + 大小写折叠）：`Sakura` 与 `sakura` 视为同一个词。
//     日文本身不区分大小写，这条只为拉丁词条服务。
//   - 持久化在 settings.dictHistory（与 dictFavorites 同层），不是 .galweave ——
//     查词历史是"人的习惯"而不是"项目的数据"，跟着软件走更合理。

/** 历史上限（条） */
export const HISTORY_LIMIT = 100;

/** 来源标注：划词浮层 / 手动输入 / 从历史里再查 */
export const HISTORY_SOURCES = {
  selection: '划词',
  input: '输入',
  history: '历史',
};

export function describeHistorySource(source){
  return HISTORY_SOURCES[source] || HISTORY_SOURCES.input;
}

/** 规范化：去空白 + 大小写折叠。空串返回 ''（调用方据此拒绝入历史） */
export function normalizeWord(word){
  return String(word == null ? '' : word).trim();
}

/** 历史比较键：在 normalizeWord 基础上再折叠大小写 */
function keyOf(word){
  return normalizeWord(word).toLowerCase();
}

/**
 * 构造一条历史记录。
 * @returns {{word:string, at:number, source:string}|null} word 为空时返回 null（不入历史）
 */
export function makeEntry(word, at, source){
  const w = normalizeWord(word);
  if (!w) return null;
  const t = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  return { word: w, at: t, source: HISTORY_SOURCES[source] ? source : 'input' };
}

/**
 * 把一条记录压入历史：按词去重（保留最新的 at/source），命中则提到最前，最后截断到 limit。
 * 不改原数组，返回新数组。
 * @param {Array} list 现有历史
 * @param {object} entry makeEntry 的产物（null 时原样返回副本）
 * @param {number} [limit]
 */
export function pushHistory(list, entry, limit = HISTORY_LIMIT){
  const src = Array.isArray(list) ? list.filter(x => x && x.word) : [];
  if (!entry || !entry.word) return src.slice();
  const k = keyOf(entry.word);
  const rest = src.filter(x => keyOf(x.word) !== k);
  rest.unshift({ word: normalizeWord(entry.word), at: entry.at, source: entry.source });
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : HISTORY_LIMIT;
  return rest.slice(0, n);
}

/**
 * 归一化从设置里读回的历史：丢弃结构不符的项，按 at 降序（缺 at 的排在后面），截断。
 * 设置文件可能被手改或来自旧版本，这里兜住不让坏数据进 UI。
 */
export function normalizeHistory(list, limit = HISTORY_LIMIT){
  const src = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const it of src){
    const e = makeEntry(it && it.word, it && it.at, it && it.source);
    if (!e) continue;
    const k = keyOf(e.word);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => b.at - a.at);
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : HISTORY_LIMIT;
  return out.slice(0, n);
}

/** 从历史里移除某个词（返回新数组） */
export function removeFromHistory(list, word){
  const k = keyOf(word);
  return (Array.isArray(list) ? list : []).filter(x => x && x.word && keyOf(x.word) !== k);
}
