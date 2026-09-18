// textnorm.js — 中日文标点规范化与避头尾检测 —— 纯逻辑，不依赖 DOM。
//
// 解决的问题：日文原文里 `...` `~` `--` 这类半角写法，译成中文后按中文排印规范
// 应写作 `……` `——`。稿子里混着两三种写法时，同一句话在游戏里会显得忽长忽短、基线不齐。
//
// ⚠️ **只作用于译文**。原文是日文，`…`/`〜`/`--` 是它的原貌，动了就是破坏原文。
//    所有接口都要求调用方只在译文上调用；模块本身不做"这是原文吗"的判断。
//
// ⚠️ 避头尾**只检测、不自动改**。断行由目标引擎决定，工作台无法替引擎排版，
//    能做的只是报出"这里会出现行首禁则字符"。
//
// 规则取舍沿用 qa.js 的纪律：**宁漏报不误报**。只收「明确无歧义」的替换：
//   ✅ `...`（连续 ASCII 点）→ `……` —— dialogue 里几乎不可能有别的意思
//   ❌ `。。` / `・・` 不收 —— 可能是有意为之（`・・` 在日文里根本不是省略号），
//      转换会篡改译文。这类留给人工判断，工具不替他决定。

/* ---------------- 规范化 ---------------- */

/**
 * 一条规范化规则。`re` 必须是 /g（replace 与 matchAll 都要求）。
 * `id` 是稳定标识，设置项与报告里用它，不要用下标。
 */
export const NORM_RULES = [
  { id: 'ellipsis', re: /\.{2,}/g, to: '……', label: '省略号：连续半角点统一为「……」' },
  // 注意字符集：U+2014「—」/ U+2015「―」/ U+2500「─」是破折号类；
  // U+30FC「ー」是片假名长音符（表音），**绝不能**卷进来，故不在集合内。
  { id: 'emdash', re: /-{2,}|—+|―+|─+/g, to: '——', label: '破折号：统一为「——」' },
  { id: 'tilde', re: /[~〜]/g, to: '～', label: '波浪号：半角与日文形式统一为全角「～」' },
];

/** 全部规则 id（设置项顺序） */
export const NORM_IDS = NORM_RULES.map(r => r.id);

/**
 * 归一化规则选择：只保留已知 id，顺序按 NORM_RULES。
 * 传入 null/undefined → 全部启用（默认行为，用户不改设置时的预期）。
 * 传入空数组 → 全部关闭（用户显式清空的语义）。
 */
export function normalizeRuleIds(ids){
  if (ids === null || ids === undefined) return NORM_IDS.slice();
  const want = new Set(Array.isArray(ids) ? ids : []);
  return NORM_IDS.filter(id => want.has(id));
}

/**
 * 规范化一段译文。规则按 NORM_RULES 顺序**依次**应用（顺序有意义：
 * 先把 `...` 变 `……`，破折号规则就不会再去动它）。
 *
 * @param {string} text 译文
 * @param {string[]} [ids] 启用的规则 id，缺省全部
 * @returns {string} 规范化结果；无改动时返回原串
 */
export function normalizeText(text, ids){
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (!s) return s;
  const enabled = new Set(normalizeRuleIds(ids));
  let out = s;
  for (const rule of NORM_RULES){
    if (!enabled.has(rule.id)) continue;
    out = out.replace(rule.re, rule.to);
  }
  return out;
}

/**
 * 逐行比对，只返回**确实会变**的那些行。
 *
 * 批量应用前用这个做预览：未改动的行不进列表，用户看到的就是真正要动的地方。
 * @returns {Array<{i:number, from:string, to:string}>} 仅含变化项
 */
export function collectNormalizable(paras, ids){
  const list = Array.isArray(paras) ? paras : [];
  const out = [];
  list.forEach((p, i) => {
    if (!p || p.isName) return;                 // NAME 行是名字，不套标点规范化
    const from = typeof p.translation === 'string' ? p.translation : '';
    if (!from) return;                           // 未翻译的行不参与
    const to = normalizeText(from, ids);
    if (to !== from) out.push({ i, from, to });
  });
  return out;
}

/* ---------------- 避头尾（禁則処理） ---------------- */

/** 行首禁则：这些字符不能出现在一行开头（该挤回上一行行末）。 */
export const NO_LINE_START = new Set('、。，．！？：；）」』】》〉〕］｝·―—…‥〜～ー々〆ゝゞ.,!?:;)]}'.split(''));

/** 行末禁则：这些字符不能出现在一行末尾（该推到下一行行首）。 */
export const NO_LINE_END = new Set('（「『【《〈〔［｛([{'.split(''));

/**
 * 检测译文里会触发行首/行末禁则的位置。
 *
 * 只在**显式换行**处判断（`\n` 与引擎换行标签）—— 自动折行的位置由引擎决定，
 * 工作台看不到也管不着，报出来只会是噪音。所以这里查的是"译者自己按的换行"。
 *
 * @returns {Array<{at:number, ch:string, kind:'no-start'|'no-end'}>}
 *          at 为出问题字符的下标
 */
export function checkKinjiru(text){
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  const out = [];
  if (!s) return out;

  // 换行位置：字面换行（含 \r\n）与常见脚本换行标签 [r] / <r> / 转义 \n
  const nlRe = /\r\n|\n|\[r\]|\\n/gi;
  for (const m of s.matchAll(nlRe)){
    const end = m.index + m[0].length;
    const before = s[m.index - 1];
    if (before && NO_LINE_END.has(before)) out.push({ at: m.index - 1, ch: before, kind: 'no-end' });
    const after = s[end];
    if (after && NO_LINE_START.has(after)) out.push({ at: end, ch: after, kind: 'no-start' });
  }
  return out;
}

/** 判定文案（清单/胶囊里用，与 qa.js 的说法风格一致） */
export function kinjiruLabel(issue){
  if (!issue) return '';
  return issue.kind === 'no-start'
    ? `行首不应出现「${issue.ch}」`
    : `行末不应出现「${issue.ch}」`;
}
