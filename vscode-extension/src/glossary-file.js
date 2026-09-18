// glossary-file.js — 术语表文件的解析与归一（纯逻辑，不碰文件系统）
//
// 术语表结构沿用桌面版（src/glossary.js）：{ names: { 原名: 译名 }, terms: { 原词: 译词 } }
// 文件位置：<项目目录>/glossary.json。IO 在 vscode/core.cjs 里做，本模块只管数据。

/** 空术语表 */
export function emptyGlossary() {
  return { names: {}, terms: {} };
}

/**
 * 归一化任意输入成合法术语表。
 * 非法/缺失字段一律退化成空表，绝不抛错 —— 术语表读坏不该让整个扩展崩掉。
 */
export function normalizeGlossary(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (v) => {
    if (!v || typeof v !== 'object') return {};
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof k === 'string' && k && typeof val === 'string' && val) out[k] = val;
    }
    return out;
  };
  return { names: pick(src.names), terms: pick(src.terms) };
}

/** 解析术语表 JSON 文本；坏 JSON 返回空表并带上错误信息。 */
export function parseGlossaryText(text) {
  try {
    return { gloss: normalizeGlossary(JSON.parse(text)), error: null };
  } catch (e) {
    return { gloss: emptyGlossary(), error: e.message };
  }
}

/** 术语表文件路径（纯字符串拼接，统一用 / 分隔）。 */
export function glossaryPathFor(dir) {
  if (!dir || typeof dir !== 'string') return '';
  return String(dir).replace(/\\/g, '/').replace(/\/+$/, '') + '/glossary.json';
}

/** 术语表统计，供状态显示。 */
export function glossaryStats(gloss) {
  const g = normalizeGlossary(gloss);
  return { names: Object.keys(g.names).length, terms: Object.keys(g.terms).length };
}
