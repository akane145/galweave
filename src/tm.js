// tm.js — 翻译记忆（Translation Memory）：纯逻辑 + 极薄 IO
//
// 动机：galgame 文本重复句式极多。机翻已有批次上下文，
// 但**同一句式重复出现仍会重复扣费、风格还不稳**；术语表只做精确替换，不覆盖句级复用。
//
// 做法：
//   1. 已完成行入库（源句轻量规范化 → 译文），随项目存 `<项目目录>/.galweave/tm.json`；
//   2. 未翻行查 TM：**已确认命中**直接套用（零成本、全篇统一），**高相似命中**在行右键菜单里
//      以「套用记忆：<译文>」的形式给出建议，由人决定；
//   3. 批量机翻前先剔除已确认命中行，省 token。
//
// 为什么用 bigram Dice 而不是编辑距离：日文没有词边界，字符二元组对这个语种更稳，
// 且 O(n) 可增量算。阈值见 TM_SIMILARITY（0.75，实测标定）。
//
// ⚠️ 相似命中**只做建议不自动填**：TM 相似 ≠ 语义相同（「おはよう」/「おはようございます」
//    相似度很高但译文该不该一样由人判断）。精确命中才自动套用。
//
// ── 审核分级（draft / confirmed）与角色多变体 ────────────────────────────
// 机翻结果**不经过任何审核门槛**就直接入库，于是后续精确命中会自动套用 ——
// 等于把一次未审的机翻当成"标准答案"扩散到全篇，错了就错成一片。
// 现在：机翻写入的是 draft（草稿），只有人工确认过的才是 confirmed；
// **自动套用只认 confirmed**，草稿仅供人工挑选。
//
// 同时，同一句原文在 galgame 里可能因**说话人不同**而该有不同译法
// （语气、自称、称呼都不一样）。所以条目带 `name`（说话人），
// 同 key 不同 name 的条目**共存**，查询时优先给"当前说话人"那条。

import { isPlaceholderTrans, transValue } from './parsers.js';

export const TM_VERSION = 2;
/**
 * 默认相似阈值（0–1）。
 * 取 0.75 是实测标定：只差一个语气的句子（「…天気ですね」↔「…天気だね」）
 * bigram Dice ≈ 0.82，同句式换主语 ≈ 0.5–0.7，无关句 < 0.2。
 * 定在 0.82 会把"只差一个助词"的句子挡在门外（实测踩过），定在 0.5 又会把
 * 同句式不同内容的句子混进来 —— 相似命中只做建议，所以宁可稍微放宽一点。
 */
export const TM_SIMILARITY = 0.75;
/** 条目上限，超出按最后使用时间裁剪（防止 tm.json 无限膨胀） */
export const TM_LIMIT = 20000;
/** 入记忆的最短源句长度：过短的寒暄（「はい」「ええ」）复用价值低且易误套 */
export const TM_MIN_SRC_LEN = 2;
/**
 * 同一源句最多保留几个**不同说话人**的变体。
 * 超过就说明这句话在这部作品里被反复用在不同角色身上，再留也是噪音；
 * 保留上限而非全部，是为了让 tm.json 不至于被一句口头禅撑爆。
 */
export const TM_MAX_VARIANTS = 6;

/** 条目审核状态。draft = 机翻写入未复核；confirmed = 人工确认（含人工直接输入）。 */
export const TM_STATUS = { DRAFT: 'draft', CONFIRMED: 'confirmed' };

/** 归一化审核状态：不认识的写法一律当草稿（宁可多让人看一眼，不可当标准答案扩散） */
export function normalizeStatus(v){
  return v === TM_STATUS.CONFIRMED || v === 'confirmed' ? TM_STATUS.CONFIRMED : TM_STATUS.DRAFT;
}

/** 条目来源显示文案（建议面板/提示里要能看出这条记忆是哪来的） */
export function entrySourceLabel(entry){
  if (!entry) return '';
  const who = entry.name ? String(entry.name) : '';
  let status;
  if (normalizeStatus(entry.status) === TM_STATUS.CONFIRMED) status = '已确认';
  // 未确认的条目要区分"机翻产物"与"来源不明的旧译文"：
  // 从已有译文（可能来自别人的成品或早期人工翻译）导入的条目不是机翻，
  // 一律叫"机翻草稿"是错的，会让人以为这条译文的质量等于机翻。
  // 注意 `entry.src` 是**原文文本**，来源归因在 `entry.origin`。
  else if (String(entry.origin || '') === 'mt') status = '机翻草稿';
  else status = '未确认';
  return who ? (status + ' · ' + who) : status;
}

/* ---------------- 规范化 ---------------- */

/**
 * 源句轻量规范化：只做"显然等价"的归一，不做激进清洗。
 *   - 去首尾空白、压缩内部空白（全角空格也算）
 *   - 剥掉整体包裹的 「」『』
 *   - 去掉结尾的语气标点 。．！？…‥
 * 有意**不做**：全角/半角字母数字折叠、去内部标点 —— 那些会把不同句子并成一条。
 */
export function normalizeSource(src){
  let s = String(src == null ? '' : src)
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
  // 整体包裹的引号（可能是多层）
  for (let k = 0; k < 2; k++){
    if (s.length >= 2){
      const a = s[0], b = s[s.length - 1];
      if ((a === '「' && b === '」') || (a === '『' && b === '』') || (a === '"' && b === '"')) s = s.slice(1, -1).trim();
      else break;
    }
  }
  s = s.replace(/[。．.!！?？…‥、]+$/, '').trim();
  return s;
}

/** 字符二元组集合（长度 < 2 时退化为单元素集合） */
function bigrams(s){
  const out = new Set();
  if (s.length < 2){ if (s) out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * bigram Dice 相似度，0–1。空串返回 0；完全相等（含规范化后相等）返回 1。
 * 用集合而非多重集：重复二元组不再加权，避免叠词句虚高。
 */
export function similarity(a, b){
  const x = normalizeSource(a);
  const y = normalizeSource(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const denom = A.size + B.size;
  return denom ? (2 * inter) / denom : 0;
}

/* ---------------- 数据 ---------------- */

/** 空记忆库 */
export function emptyTm(){ return { version: TM_VERSION, entries: [] }; }

/**
 * 条目身份键：**同一源句的不同说话人算不同条目**。
 * 这是"同一句原文保留不同角色译法"的实现基础 —— 主键从 key 升级为 key + name。
 * 用不可见分隔符拼接，避免 (「あ」「い」) 与 (「あい」``) 撞成同一个身份。
 */
export function entryId(key, name){
  return String(key || '') + '\u0001' + String(name || '');
}

/** 说话人归一化：去空白，空串表示"未标注说话人" */
function normalizeName(name){
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
}

/**
 * 归一化从磁盘读回的记忆库：丢弃结构不符项、按身份去重、截断。
 * 文件可能被手改或来自旧版本，这里兜住不让坏数据进查询路径。
 *
 * v1 → v2 迁移：v1 条目没有 status/name 字段。
 * **v1 一律迁为 confirmed** —— 那时入库的路径是"人工翻译完成后再收割"，
 * 与现在的机翻自动入库不同；把历史数据降级成草稿会让老用户已有的记忆突然不再
 * 自动套用，属于无谓的倒退。
 */
export function normalizeTm(raw, limit = TM_LIMIT){
  const out = emptyTm();
  const src = (raw && Array.isArray(raw.entries)) ? raw.entries : [];
  const seen = new Set();
  for (const e of src){
    if (!e || typeof e.src !== 'string' || typeof e.dst !== 'string') continue;
    const key = normalizeSource(e.src);
    if (!key || key.length < TM_MIN_SRC_LEN) continue;
    const dst = String(e.dst).trim();
    if (!dst) continue;
    const name = normalizeName(e.name);
    const id = entryId(key, name);
    if (seen.has(id)) continue;
    seen.add(id);
    // 缺 status 字段 = v1 老数据 → confirmed（见上）
    const status = e.status === undefined || e.status === null
      ? TM_STATUS.CONFIRMED
      : normalizeStatus(e.status);
    out.entries.push({
      key,
      src: String(e.src),
      dst,
      name,
      status,
      // 来源归因（译文是谁写的）。v1 老数据没有这个字段 → 空 = "未确认/来源不明"
      origin: typeof e.origin === 'string' ? e.origin : '',
      at: Number.isFinite(Number(e.at)) ? Number(e.at) : 0,
      hits: Number.isFinite(Number(e.hits)) ? Math.max(0, Math.floor(Number(e.hits))) : 0,
    });
  }
  return pruneTm(out, limit);
}

/** 按最后使用时间裁剪到 limit 条（不改原对象） */
export function pruneTm(tm, limit = TM_LIMIT){
  const list = (tm && Array.isArray(tm.entries)) ? tm.entries : [];
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : TM_LIMIT;
  const out = list.slice();
  if (out.length > n){
    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    out.length = n;
  }
  return { version: TM_VERSION, entries: out };
}

/** 当前条目数 */
export function tmSize(tm){
  return (tm && Array.isArray(tm.entries)) ? tm.entries.length : 0;
}

/** 某条记忆是否可直接自动套用（只有人工确认过的才算） */
export function isConfirmed(entry){
  return !!entry && normalizeStatus(entry.status) === TM_STATUS.CONFIRMED;
}

/**
 * 写入一条记忆。同一 (源句, 说话人) 覆盖（更新译文、审核状态与时间），否则新增。
 * 返回新对象（不改原库）。
 *
 * @param {object} tm
 * @param {string} src 原文
 * @param {string} dst 译文
 * @param {number} [at] 时间戳
 * @param {{name?:string, status?:string, src?:string}} [opts] 说话人、审核状态与来源归因
 *        （`opts.src` 是**译文是谁写的**：'mt'/'human'/'tm'/''，只用于来源显示）
 */
export function addEntry(tm, src, dst, at, opts = {}){
  const key = normalizeSource(src);
  const value = String(dst == null ? '' : dst).trim();
  if (!key || key.length < TM_MIN_SRC_LEN || !value) return tm;
  const t = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const name = normalizeName(opts.name);
  const status = normalizeStatus(opts.status);
  const origin = String(opts.src == null ? '' : opts.src);
  const id = entryId(key, name);
  const base = tm && Array.isArray(tm.entries) ? tm.entries : [];
  const entries = base.filter(e => entryId(e.key, e.name) !== id);
  entries.unshift({ key, src: String(src), dst: value, name, status, origin, at: t, hits: 0 });
  return pruneTm({ version: TM_VERSION, entries });
}

/**
 * 把某条记忆标为已确认（人工确认后用）。
 * 按 (key, name) 定位；找不到返回原库。
 */
export function confirmEntry(tm, src, at, name){
  const key = normalizeSource(src);
  const id = entryId(key, normalizeName(name));
  const list = (tm && Array.isArray(tm.entries)) ? tm.entries : [];
  let hit = false;
  const entries = list.map(e => {
    if (entryId(e.key, e.name) !== id) return e;
    hit = true;
    return { ...e, status: TM_STATUS.CONFIRMED, at: Number.isFinite(Number(at)) ? Number(at) : e.at };
  });
  return hit ? { version: TM_VERSION, entries } : tm;
}

/** 某源句的全部变体（不同说话人各一条），按最后使用时间降序 */
export function variantsOf(tm, src){
  const key = normalizeSource(src);
  if (!key) return [];
  const list = (tm && Array.isArray(tm.entries)) ? tm.entries : [];
  return list
    .filter(e => e.key === key)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * 精确命中（按规范键 + 说话人）；未命中返回 null。
 *
 * 说话人匹配规则（决定"同句不同角色"该怎么取）：
 *   1. 指定了说话人 → 优先精确匹配该说话人；
 *   2. 该说话人没有条目 → **退回未标注说话人的通用条目**（同一句话对谁都一样的常见情形）；
 *   3. 指定说话人且只有其他说话人的条目 → 不返回（可能是别人的语气，交给相似命中当建议）。
 * 没指定说话人时只看未标注说话人的条目，不会随便拿某个角色的译法顶上。
 */
export function findExact(tm, src, name){
  const key = normalizeSource(src);
  if (!key) return null;
  const list = (tm && Array.isArray(tm.entries)) ? tm.entries : [];
  const who = normalizeName(name);
  const sameKey = list.filter(e => e.key === key);
  if (!sameKey.length) return null;
  if (who){
    const exact = sameKey.find(e => e.name === who);
    if (exact) return exact;
    return sameKey.find(e => !e.name) || null;
  }
  return sameKey.find(e => !e.name) || null;
}

/**
 * 自动套用用的查询：**只认已确认条目**。
 * 机翻草稿不自动填 —— 未经复核的机翻一旦自动扩散到全篇，错了就是一片。
 */
export function findConfirmed(tm, src, name){
  const hit = findExact(tm, src, name);
  return hit && isConfirmed(hit) ? hit : null;
}

/**
 * 高相似命中列表（按相似度降序）。
 * @param {object} tm
 * @param {string} src
 * @param {{threshold?:number, limit?:number, excludeExact?:boolean, name?:string}} [opts]
 * @returns {Array<{entry:object, score:number}>}
 */
export function findSimilar(tm, src, opts = {}){
  const key = normalizeSource(src);
  if (!key) return [];
  const thr = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : TM_SIMILARITY;
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 5;
  const excludeExact = opts.excludeExact !== false;
  const who = normalizeName(opts.name);
  const list = (tm && Array.isArray(tm.entries)) ? tm.entries : [];
  const out = [];
  for (const e of list){
    if (excludeExact && e.key === key && (!who || e.name === who || !e.name)) continue;
    const score = similarity(key, e.key);
    if (score >= thr) out.push({ entry: e, score });
  }
  // 同分时**已确认优先**：用户已经在别的行确认过这个说法，更值得先看
  out.sort((a, b) => (b.score - a.score) || (Number(isConfirmed(b.entry)) - Number(isConfirmed(a.entry))));
  return out.slice(0, limit);
}

/**
 * 从段落里收割已完成行入记忆（批量入库的入口）。
 *
 * 只收非 NAME、译文非空、且源句够长的行；译文取 `transValue`（剥掉外层「」），
 * 套用时再按目标行类型包回，这样同一条记忆能在「有括号 / 无括号」两种行上复用。
 * 译文与原文相同的占位行（镜像格式未翻译时预填原文）不入记忆 —— 那不是翻译，
 * 收进去会产出「原文→原文」的垃圾条目，污染后续的建议命中。
 *
 * **审核状态与来源**：默认把收割到的条目记为草稿（机翻未复核），
 * 只有 `p.src === 'human'`（人工输入/改写）或该行已通过校对才记为已确认。
 * 这是"机翻草稿不得自动扩散"的关键 —— 收割入口必须知道译文是谁写的。
 *
 * @param {Array} paras
 * @param {object} tm
 * @param {number} [at]
 * @returns {{tm:object, added:number, confirmed:number}}
 *          added = 真正新增或译文发生变化的条数；
 *          confirmed = 其中被记为已确认的条数
 */
export function collectFromParas(paras, tm, at){
  let cur = tm && Array.isArray(tm.entries) ? tm : emptyTm();
  let added = 0;
  let confirmed = 0;
  const t = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  for (const p of (Array.isArray(paras) ? paras : [])){
    if (!p || p.isName) continue;
    const src = String(p.content || '');
    if (normalizeSource(src).length < TM_MIN_SRC_LEN) continue;
    const dst = String(transValue(p) || '').trim();
    if (!dst) continue;
    if (isPlaceholderTrans(p)) continue; // 预填/照抄的原文占位: 不是译文,不入库
    // 说话人来自脚本前缀解析（p.name）；解析不出就是空，退化为通用条目
    const name = normalizeName(p.name);
    const status = isConfirmedRow(p) ? TM_STATUS.CONFIRMED : TM_STATUS.DRAFT;
    const prev = findExact(cur, src, name);
    // 原样记下这条译文的来源归因（'mt' / 'human' / 'tm' / '' ），
    // 供 UI 区分"机翻产物"与"来源不明的旧译文"，不要一律显示成"机翻草稿"
    const origin = String(p.src || '');
    // 已收割过、且译文/审核状态/来源都没变 → 跳过（幂等）。
    // 比来源是必要的：一行从"机翻"被改成"人工"时译文可能一字未动，
    // 但审核状态与显示标签都该跟着更新。
    if (prev && prev.dst === dst && normalizeStatus(prev.status) === status
        && String(prev.origin || '') === origin) continue;
    // 已有的"已确认"条目不该被同句的机翻草稿**降级**回草稿（人工确认过就是定论）
    const keepStatus = prev && isConfirmed(prev) && status === TM_STATUS.DRAFT;
    cur = addEntry(cur, src, dst, t, {
      name,
      status: keepStatus ? TM_STATUS.CONFIRMED : status,
      src: keepStatus ? prev.origin : origin,
    });
    added++;
    if (keepStatus || status === TM_STATUS.CONFIRMED) confirmed++;
  }
  return { tm: cur, added, confirmed };
}

/**
 * 该行译文是否可视为"人工确认过"。
 * 判据是**来源归因**（p.src = human 表示人工输入或人工改写机翻）与**校对状态**
 * （已通过）。两者任一成立即可 —— 用户通过校对就是在确认，不必再另点一次。
 */
function isConfirmedRow(p){
  if (String(p.src || '') === 'human') return true;
  const st = p.pr && p.pr.status;
  return st === 'approved';
}

/** 建议条文案（行菜单 / Toast 用）：截断到 n 个字符 */
export function suggestLabel(dst, n = 18){
  const s = String(dst == null ? '' : dst).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 带来源的建议条文案：`机翻草稿 · 爱丽丝：早上好`（让用户看清这条记忆可不可信） */
export function suggestLabelWithSource(entry, n = 18){
  if (!entry) return '';
  return entrySourceLabel(entry) + '：' + suggestLabel(entry.dst, n);
}

/* ---------------- IO（薄层，不参与单测） ---------------- */

// 浏览器端（IndexedDB）键前缀。桌面端走文件，键名只用于浏览器路径。
// 前缀里的 v2 是**存储格式**版本：条目结构加了 status/name，
// 与 v1 数据不兼容；v1 数据由 normalizeTm 在读取时迁移（缺 status → confirmed），
// 因此这里不需要额外的一次性搬迁代码。
const LS_PREFIX = 'galtrans_tm_v2:';

function storeKey(projectPath){
  return LS_PREFIX + (projectPath || 'global');
}

/**
 * 读记忆库。
 * 桌面版 + 有绝对路径 → `<源目录>/.galweave/tm.json`；
 * 其余（浏览器 / 未保存文件）→ IndexedDB（键 tm:<路径或 global>）。
 * 任何失败都返回空库而不抛错 —— TM 是加速器，不该阻断翻译流程。
 */
export async function loadTm(projectPath){
  if (!projectPath) return emptyTm();
  try {
    const { isTauri, isAbsPath } = await import('./fs.js');
    if (isTauri() && isAbsPath(projectPath)){
      const { readGalweaveFile } = await import('./fs.js');
      const raw = await readGalweaveFile(projectPath, 'tm.json');
      if (raw){
        try { return normalizeTm(JSON.parse(raw)); } catch (e) { return emptyTm(); }
      }
      return emptyTm();
    }
    const { kvGet } = await import('./fs.js');
    const data = await kvGet(storeKey(projectPath));
    return data ? normalizeTm(data) : emptyTm();
  } catch (e) { return emptyTm(); }
}

/** 写记忆库。返回是否成功落盘。 */
export async function saveTm(projectPath, tm){
  if (!projectPath) return false;
  const payload = { version: TM_VERSION, updatedAt: new Date().toISOString(), entries: pruneTm(tm).entries };
  try {
    const { isTauri, isAbsPath } = await import('./fs.js');
    if (isTauri() && isAbsPath(projectPath)){
      const { writeGalweaveFile } = await import('./fs.js');
      return await writeGalweaveFile(projectPath, 'tm.json', JSON.stringify(payload, null, 2));
    }
    const { kvPut } = await import('./fs.js');
    await kvPut(storeKey(projectPath), payload);
    return true;
  } catch (e) { return false; }
}
