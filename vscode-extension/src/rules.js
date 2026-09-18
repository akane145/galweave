// rules.js — 规则库与每文档规则选择（纯逻辑，无 DOM、无 vscode 依赖）
//
// 背景：src/parsers.js 的解析配置是模块级状态，同一时刻只有一份生效。
// 而一个工作区里常常混着多种标记体系（实测样本里 ☆/★ 与 ○/● 并存），
// 所以需要"每个文档各用一套规则"。做法是：
//   1. 维护一个规则库（内置若干 + 用户 rulesFile 指定）
//   2. 对每个文档算出哪条规则最能解释它
//   3. 解析时把该规则显式传给 parseLines（同步灌入 + 同步解析，见 lineparse.js）
//
// 本模块不碰文件系统 —— 规则的读取在调用方（extension.cjs / inspect.mjs）完成。

import { DEFAULT_COMMENT_PREFIXES, DEFAULT_NAME_ID_PATTERNS } from '../../src/parsers.js';
import { parseLines } from './lineparse.js';

/** 参与评分的样本行数上限：规则选择只需看开头一段，避免整篇多解析几遍。 */
export const SAMPLE_LINES = 400;

/** 取开头 n 行作为样本。 */
export function sampleOf(text, n = SAMPLE_LINES) {
  return String(text || '').split(/\r?\n/, n).join('\n');
}

/**
 * 把任意来源的规则对象补全成完整配置。
 * 关键：**始终补全**（不从"当前生效配置"继承）。
 * src/parsers.js 的 setParseConf 是按键合并的，传半套配置会静默继承上一套的其余字段，
 * 那会让"每文档独立规则"变得不可预测。
 *
 * 接受两种形态：
 *   { id, label, conf: {...} }   —— 完整规则对象
 *   { open, close, regex, ... }  —— 裸配置（rules/*.json 的写法）
 */
export function normalizeRule(raw, fallbackId) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const conf = src.conf && typeof src.conf === 'object' ? src.conf : src;
  const id = src.id || fallbackId || 'rule';
  return {
    id,
    label: src.label || fallbackId || id,
    conf: {
      // 缺失字段填默认值；**显式给了非法值就原样保留**，交给 validateRule 拦下来。
      // 若在这里把 open:"" 悄悄换成 ☆，用户永远不知道自己写错了。
      open: typeof conf.open === 'string' ? conf.open : '☆',
      close: typeof conf.close === 'string' ? conf.close : '★',
      regex: typeof conf.regex === 'string' ? conf.regex : '',
      commentPrefixes: Array.isArray(conf.commentPrefixes)
        ? conf.commentPrefixes.slice()
        : DEFAULT_COMMENT_PREFIXES.slice(),
      nameIdPatterns: Array.isArray(conf.nameIdPatterns)
        ? conf.nameIdPatterns.slice()
        : DEFAULT_NAME_ID_PATTERNS.slice(),
    },
  };
}

/** 内置规则库。默认 ☆/★ 放最前：评分持平时先到者胜，等于倾向更通用的规则。 */
export const BUILTIN_RULES = [
  normalizeRule({ id: 'default-star', label: '标准 ☆/★' }, 'default-star'),
  normalizeRule({
    id: 'star-bracket-speaker',
    label: '☆/★ + 正文包裹说话人（【名】/[[名]]）',
    conf: {
      open: '☆', close: '★',
      regex: '^[☆★][^☆★]*[☆★]\\s*[【\\[]{1,2}(?<name>[^】\\]]*)[】\\]]{1,2}\\s*(?<content>[\\s\\S]*)$',
    },
  }, 'star-bracket-speaker'),
];

/** 按 id 查规则；查不到返回 null。 */
export function findRule(rules, id) {
  return (rules || []).find(r => r.id === id) || null;
}

/**
 * 校验一条规则，返回错误文案；合法返回 null。
 *
 * 必须显式校验：src/parsers.js 的 getPrefixRe() 在正则编译失败时是**静默回退**到
 * 自动生成的正则，坏规则会"看起来能跑"却实际用了另一套规则。规则库里绝不能
 * 放进一条会让用户误判的规则。
 */
export function validateRule(rule) {
  const conf = rule?.conf;
  if (!conf) return '规则缺少 conf';
  if (!conf.open || !conf.close) return '原文/译文标记不能为空';
  if (conf.open === conf.close) return '原文标记与译文标记不能相同';
  if (conf.regex) {
    try { new RegExp(conf.regex); }
    catch (e) { return `正则无法编译：${e.message}`; }
  }
  for (const p of conf.nameIdPatterns || []) {
    try { new RegExp(p, 'i'); }
    catch (e) { return `名字行正则无法编译：${p}`; }
  }
  return null;
}

/**
 * 一条规则对一段文本的解释力。
 *
 * `marked` 的判据是**正文比原行短**（即规则从行首吃掉了前缀/元信息），
 * 而不是"前缀非空" —— 用命名捕获组的规则没有位置捕获组，
 * parsePrefix 返回的 prefix 会是空串，但它确实解释了这一行。
 *
 * 三个指标按顺序参与比较：能解释的行数 → 取出的说话人数 → 取出的编号数。
 */
export function scoreRule(text, rule) {
  const invalid = validateRule(rule);
  if (invalid) {
    return { marked: 0, speakers: 0, numbered: 0, total: 0, error: invalid };
  }
  let parsed;
  try {
    parsed = parseLines(text, { conf: rule.conf });
  } catch (e) {
    return { marked: 0, speakers: 0, numbered: 0, total: 0, error: e.message };
  }
  let marked = 0, speakers = 0, numbered = 0;
  for (const p of parsed.paras) {
    if (p.orig.length > p.content.length) marked++;
    if (p.name) speakers++;
    if (p.id) numbered++;
  }
  return { marked, speakers, numbered, total: parsed.summary.total };
}

/**
 * 选出最能解释这段文本的规则；没有规则命中时返回 null。
 * 比较是字典序的：marked → speakers → numbered。全等时保留先出现的规则。
 */
export function pickRule(text, rules) {
  const sample = sampleOf(text);
  let best = null;
  for (const rule of rules || []) {
    if (validateRule(rule)) continue; // 坏规则不参与选择
    const score = scoreRule(sample, rule);
    if (!best
      || score.marked > best.score.marked
      || (score.marked === best.score.marked && score.speakers > best.score.speakers)
      || (score.marked === best.score.marked && score.speakers === best.score.speakers
          && score.numbered > best.score.numbered)) {
      best = { rule, score };
    }
  }
  return best && best.score.marked > 0 ? best : null;
}

/**
 * 文本的"标记指纹"：每个规则在样本里能匹配到多少行（含行数）。
 * 用途是廉价地判断"要不要重新选规则" —— 选规则要对每条规则各解析一遍，
 * 而指纹只需逐行 includes，可以在每次编辑后都算。
 */
export function fingerprint(text, rules) {
  const lines = String(text || '').split(/\r?\n/, SAMPLE_LINES);
  const counts = (rules || []).map((r) => {
    const { open, close } = r.conf;
    let n = 0;
    for (const l of lines) {
      if ((open && l.includes(open)) || (close && l.includes(close))) n++;
    }
    return n;
  });
  return [lines.length, ...counts].join('|');
}
