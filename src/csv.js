// csv.js — 极小 CSV 解析与术语表互转(纯逻辑,可单测)
// 支持: 引号字段、"" 转义、字段内换行、CRLF、BOM。零依赖,不处理 Excel 二进制
// (需要 Excel 数据请先另存为 CSV)。
// 运行: node --test tests/dict.test.mjs

/** 解析 CSV 文本为二维数组(过滤全空行) */
export function parseCsv(text){
  if (!text) return [];
  let s = String(text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // BOM
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++){
    const c = s[i];
    if (inQuotes){
      if (c === '"'){
        if (s[i + 1] === '"'){ field += '"'; i++; } // "" → 字面引号
        else inQuotes = false;
      } else field += c; // 引号内的逗号/换行都是内容
    } else {
      if (c === '"' && field === '') inQuotes = true;
      else if (c === ','){ row.push(field); field = ''; }
      else if (c === '\r'){ /* CRLF 由 \n 结算 */ }
      else if (c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => String(f).trim() !== ''));
}

const NAME_KINDS = ['name', 'names', '名词', '人名'];
const HEADER_HINTS = ['原文', '译文', 'src', 'dst', 'source', 'target', 'kind', '类型', '名词', '术语', 'term', 'name', 'headword', '释义', '展开'];

/** 疑似表头行: ≥2 个单元格是常见列名 */
function isHeaderRow(cells){
  const norm = cells.map(c => String(c).trim().toLowerCase());
  return norm.filter(c => HEADER_HINTS.includes(c)).length >= 2;
}

/**
 * CSV 行 → 术语表 {names, terms}。
 * 2 列 = 原文,译文(进词条); 3 列 = 类型,原文,译文(名词/人名 → names,其余 → terms);
 * 首行是表头时自动跳过。空单元格行忽略。
 */
export function toGlossary(rows){
  const out = { names: {}, terms: {} };
  let skippedHeader = false;
  for (const r of rows){
    const cells = (r || []).map(c => String(c).trim());
    if (!skippedHeader && isHeaderRow(cells)){ skippedHeader = true; continue; }
    if (cells.length >= 3){
      const kind = cells[0].toLowerCase();
      if (!cells[1] || !cells[2]) continue;
      if (NAME_KINDS.includes(kind)) out.names[cells[1]] = cells[2];
      else out.terms[cells[1]] = cells[2];
    } else if (cells.length === 2){
      if (!cells[0] || !cells[1]) continue;
      out.terms[cells[0]] = cells[1];
    }
  }
  return out;
}

/** 字段转义: 含逗号/引号/换行时加引号并把 " 翻倍 */
function csvField(s){
  s = String(s == null ? '' : s);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 术语表 → CSV 文本(3 列: 类型,原文,译文;带表头,便于 Excel 直接打开)。
 *  开头带 UTF-8 BOM: Windows Excel 对无 BOM 的 CSV 按 ANSI/GBK 解码会乱码;
 *  parseCsv 导入时会自动剥掉 BOM,往返不受影响。 */
export function fromGlossary(gloss, nl = '\r\n'){
  const lines = ['类型,原文,译文'];
  for (const [k, v] of Object.entries((gloss && gloss.names) || {})) lines.push('名词,' + csvField(k) + ',' + csvField(v));
  for (const [k, v] of Object.entries((gloss && gloss.terms) || {})) lines.push('术语,' + csvField(k) + ',' + csvField(v));
  return '\uFEFF' + lines.join(nl) + nl;
}
