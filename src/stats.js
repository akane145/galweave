// stats.js — 翻译进度统计（纯逻辑 + thin IO）
//
// 动机（docs/ROADMAP.md P2-4）：现状只有「已译字符 / 总字符（百分比）」一个数。
// 译者真正想知道的是**还有多久能做完**，这需要两个当前代码里不存在的东西：
//   1. 进度的**时间序列**（只有"现在多少"，没有"昨天多少"就推不出速度）；
//   2. 译文来源的**归因**（多少是机翻、多少是人工、多少是记忆复用）。
// 本模块负责这两块的数据结构与推算，UI 只负责展示。
//
// 速度口径（有意选择，改动需同步单测）：
//   - 以「天」为最小粒度，只记当天**最后一次**的累计已译行数（覆盖写，不是累加）。
//   - 两天的差值按**日历天间隔**摊平：隔了 3 天涨了 90 行 → 90/3 = 30 行/天。
//     不做摊平的话，"周末没开工"会被算成"周一暴涨"，ETA 会严重失真。
//   - 负增长（清空翻译 / 撤回）按 0 计，不让它把历史速度拉负。
//   - 估算速度时**排除今天**：今天还没过完，拿它算会系统性低估。

export const STATS_VERSION = 1;
/** 进度时间序列保留天数（超出裁剪，避免文件无限膨胀） */
export const STATS_KEEP_DAYS = 120;
/** 速度与 ETA 的估算窗口（天） */
export const SPEED_WINDOW_DAYS = 14;
/** 面板里柱状图展示的天数 */
export const CHART_DAYS = 14;

/* ---------------- 时间 ---------------- */

/** 本地日期键 'YYYY-MM-DD' */
export function dayKey(at){
  const d = new Date(Number.isFinite(Number(at)) ? Number(at) : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 'YYYY-MM-DD' → 'MM-DD'（图例用） */
export function dayLabel(key){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? (m[2] + '-' + m[3]) : String(key || '');
}

function dayToUTC(key){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

/** 两个日期键的日历天差（b - a）；任一非法返回 0 */
export function dayGap(a, b){
  const x = dayToUTC(a), y = dayToUTC(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return Math.round((y - x) / 86400000);
}

/* ---------------- 存储结构 ---------------- */

export function emptyStore(){ return { version: STATS_VERSION, docs: {} }; }

/** 归一化从磁盘读回的统计库：丢坏数据、裁剪每篇的天数 */
export function normalizeStore(raw, keepDays = STATS_KEEP_DAYS){
  const out = emptyStore();
  if (!raw || typeof raw !== 'object') return out;
  const docs = (raw.docs && typeof raw.docs === 'object') ? raw.docs : {};
  for (const key of Object.keys(docs)){
    const d = docs[key];
    if (!d || typeof d !== 'object') continue;
    const days = {};
    const rawDays = (d.days && typeof d.days === 'object') ? d.days : {};
    for (const date of Object.keys(rawDays)){
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const v = rawDays[date];
      if (!v || typeof v !== 'object') continue;
      days[date] = {
        done: Math.max(0, Math.floor(Number(v.done) || 0)),
        byMt: Math.max(0, Math.floor(Number(v.byMt) || 0)),
        byTm: Math.max(0, Math.floor(Number(v.byTm) || 0)),
        byHuman: Math.max(0, Math.floor(Number(v.byHuman) || 0)),
      };
    }
    out.docs[key] = {
      name: String(d.name || ''),
      total: Math.max(0, Math.floor(Number(d.total) || 0)),
      days: trimDays(days, keepDays),
    };
  }
  return out;
}

/** 只保留最近 keepDays 个日期键 */
export function trimDays(days, keepDays = STATS_KEEP_DAYS){
  const keys = Object.keys(days || {}).sort();
  if (keys.length <= keepDays) return { ...(days || {}) };
  const keep = keys.slice(-keepDays);
  const out = {};
  for (const k of keep) out[k] = days[k];
  return out;
}

/**
 * 记录当天进度（覆盖写，不是累加）。返回新库（不改原对象）。
 * @param {object} store
 * @param {string} docKey 文档键（用 model.getStateKey()，保证同目录同名文件不串）
 * @param {{name?:string,at?:number,done?:number,total?:number,byMt?:number,byTm?:number,byHuman?:number}} o
 */
export function recordDay(store, docKey, o = {}){
  const base = normalizeStore(store);
  const key = String(docKey || '');
  if (!key) return base;
  const date = dayKey(o.at);
  const prev = base.docs[key] || { name: '', total: 0, days: {} };
  const days = { ...prev.days };
  days[date] = {
    done: Math.max(0, Math.floor(Number(o.done) || 0)),
    byMt: Math.max(0, Math.floor(Number(o.byMt) || 0)),
    byTm: Math.max(0, Math.floor(Number(o.byTm) || 0)),
    byHuman: Math.max(0, Math.floor(Number(o.byHuman) || 0)),
  };
  base.docs[key] = {
    name: String(o.name || prev.name || ''),
    total: Math.max(0, Math.floor(Number(o.total) || prev.total || 0)),
    days: trimDays(days),
  };
  return base;
}

/* ---------------- 推算 ---------------- */

/** 某文档的时间序列（升序） */
export function historyOf(store, docKey){
  const d = store && store.docs ? store.docs[String(docKey || '')] : null;
  if (!d || !d.days) return [];
  return Object.keys(d.days).sort().map(date => ({
    date,
    done: d.days[date].done,
    byMt: d.days[date].byMt,
    byTm: d.days[date].byTm,
    byHuman: d.days[date].byHuman,
  }));
}

/**
 * 每日速度（行/天）。相邻两天差值按日历天间隔摊平；负增长按 0 计。
 * @returns {Array<{date:string, rate:number}>}
 */
export function dailyRates(history){
  const list = Array.isArray(history) ? history : [];
  const out = [];
  for (let i = 1; i < list.length; i++){
    const gap = dayGap(list[i - 1].date, list[i].date);
    if (gap <= 0) continue;
    const delta = (Number(list[i].done) || 0) - (Number(list[i - 1].done) || 0);
    out.push({ date: list[i].date, rate: Math.max(0, delta) / gap });
  }
  return out;
}

/**
 * 按译文来源归因已译行。
 *
 * ⚠️ 「已译」必须用 `p.done`（model.recalcDone 写入的），不要自己重算 ——
 * 否则会和 filestats.countStates 的口径分叉（NAME 行的 done 规则尤其容易踩），
 * 面板上就会出现"总进度 300 行、来源合计 298 行"这种对不上的数。
 *
 * @returns {{mt:number, tm:number, human:number, done:number, total:number}}
 */
export function countBySource(paras){
  const list = Array.isArray(paras) ? paras : [];
  let mt = 0, tm = 0, human = 0;
  for (const p of list){
    if (!p || !p.done) continue;
    if (p.src === 'mt') mt++;
    else if (p.src === 'tm') tm++;
    else human++;
  }
  return { mt, tm, human, done: mt + tm + human, total: list.length };
}

/**
 * 面板用的汇总。
 * @param {object} o
 * @param {Array} o.history historyOf() 的产物
 * @param {number} o.done 当前已译行数
 * @param {number} o.total 总行数
 * @param {{mt:number,tm:number,human:number}} o.bySrc
 * @param {number} [o.now]
 * @param {number} [o.window] 速度窗口天数
 */
export function summarize(o = {}){
  const history = Array.isArray(o.history) ? o.history : [];
  const total = Math.max(0, Math.floor(Number(o.total) || 0));
  const done = Math.max(0, Math.floor(Number(o.done) || 0));
  const remaining = Math.max(0, total - done);
  const percent = total ? Math.round(done / total * 1000) / 10 : 0;
  const bySrc = o.bySrc || { mt: 0, tm: 0, human: 0 };

  const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
  const windowDays = Number.isFinite(Number(o.window)) && Number(o.window) > 0 ? Math.floor(Number(o.window)) : SPEED_WINDOW_DAYS;
  const today = dayKey(now);
  // 先裁到窗口内**再**算差值，顺序不能反：否则窗口外那条记录会成为窗口内首条的"前一条"，
  // 把跨越几十天的暴涨摊成窗口内的低速（实测踩过 —— 7 月涨了 900 行，9 月的"日速度"被算成 0.1/天）。
  // 窗口内的首条没有窗口内的前一条 → 不产生速率，这是有意的。
  const since = dayKey(now - (windowDays - 1) * 86400000);
  const inWindow = history.filter(h => h.date >= since);
  // 再排除今天：今天还没过完，纳入会系统性低估速度
  const usable = dailyRates(inWindow).filter(r => r.date !== today);
  const speedPerDay = usable.length
    ? Math.round(usable.reduce((a, r) => a + r.rate, 0) / usable.length * 10) / 10
    : 0;

  let etaDays = null;
  let etaDate = null;
  if (remaining === 0){ etaDays = 0; etaDate = today; }
  else if (speedPerDay > 0){
    etaDays = Math.ceil(remaining / speedPerDay);
    etaDate = dayKey(now + etaDays * 86400000);
  }

  const chart = history.slice(-CHART_DAYS).map((h, i, arr) => {
    const prev = i > 0 ? arr[i - 1] : null;
    return { date: h.date, label: dayLabel(h.date), done: h.done, delta: prev ? Math.max(0, h.done - prev.done) : 0 };
  });

  const srcTotal = (Number(bySrc.mt) || 0) + (Number(bySrc.tm) || 0) + (Number(bySrc.human) || 0);
  return {
    total, done, remaining, percent,
    speedPerDay,
    etaDays, etaDate,
    etaUnknown: remaining > 0 && speedPerDay <= 0,
    hasSpeed: usable.length > 0,
    sampleDays: usable.length,
    bySrc: { mt: Number(bySrc.mt) || 0, tm: Number(bySrc.tm) || 0, human: Number(bySrc.human) || 0 },
    mtRatio: srcTotal ? Math.round((Number(bySrc.mt) || 0) / srcTotal * 1000) / 10 : 0,
    chart,
    today,
  };
}

/** ETA 文案（UI 直接贴） */
export function etaText(s){
  if (!s) return '—';
  if (s.remaining === 0) return '已完成';
  if (s.etaUnknown) return '按现有数据推不出速度（至少需要两天的记录）';
  return '约 ' + s.etaDays + ' 天（' + (s.etaDate || '') + '）';
}

/* ---------------- IO（薄层，不参与单测） ---------------- */

const LS_PREFIX = 'galtrans_stats_v1:';
const FILE = 'stats.json';

/** 读统计库；桌面版 `<源目录>/.galweave/stats.json`，浏览器 IndexedDB。失败返回空库。 */
export async function loadStats(docPath){
  if (!docPath) return emptyStore();
  try {
    const fsx = await import('./fs.js');
    if (fsx.isTauri()){
      const raw = await fsx.readGalweaveFile(docPath, FILE);
      if (raw){ try { return normalizeStore(JSON.parse(raw)); } catch (e) { return emptyStore(); } }
      return emptyStore();
    }
    const data = await fsx.kvGet(LS_PREFIX + docPath);
    return data ? normalizeStore(data) : emptyStore();
  } catch (e) { return emptyStore(); }
}

/** 写统计库；返回是否落盘成功 */
export async function saveStats(docPath, store){
  if (!docPath) return false;
  const payload = { version: STATS_VERSION, updatedAt: new Date().toISOString(), ...normalizeStore(store) };
  try {
    const fsx = await import('./fs.js');
    if (fsx.isTauri()){
      return await fsx.writeGalweaveFile(docPath, FILE, JSON.stringify(payload, null, 2));
    }
    await fsx.kvPut(LS_PREFIX + docPath, payload);
    return true;
  } catch (e) { return false; }
}
