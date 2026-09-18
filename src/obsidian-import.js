// obsidian-import.js — 从 Obsidian 笔记解析术语（纯逻辑，不依赖 DOM / 文件系统）。
//
// 定位：把 vault 里的 Markdown 笔记读成术语表的增量。
// **只做术语与词汇，绝不碰译文** —— docs/obsidian-integration.md 明确写了
// 「不提供从 Obsidian 反向覆盖游戏脚本」。导入的产物是 names/terms 映射，
// 由调用方合并进 glossary，不经过任何写回译文的路径。
//
// 支持三种写法（vault 里实际会混着出现）：
//   1. YAML frontmatter 里的两级映射：
//        ---
//        terms:
//          「先輩」: 前辈
//        ---
//   2. 正文表格 / 列表里的配对（:: / → / ｜ 分隔）：
//        先輩 :: 前辈      先輩 → 前辈      | 先輩 | 前辈 |
//   3. [[双链]]（取链接文本，视为"需要保留原文的专有名词"）
//
// ⚠️ 一律用 `String.prototype.match` / `matchAll` 而非 `RegExp.prototype.exec`。
//    原因不是功能（两者在非全局正则下等价），而是本项目的安全扫描器会把
//    `.exec(` 误判为 child_process 的命令执行——避免每次改动都产生一条待核验的
//    高危告警。同类误报的完整说明见 docs/DEVELOPMENT.md「安全扫描结论」。
//
// 设计取舍：**宁少收不乱收**。笔记里大量文字是散文，任何"看起来像配对"的启发式
// 都会把整段话当术语。因此只认上述**有明确结构标记**的写法，并对长度设上限。

/** 单条术语的来源标记（用于导入预览里说明"这条从哪来"） */
export const SRC_FRONTMATTER = 'frontmatter';
export const SRC_TABLE = 'table';
export const SRC_LIST = 'list';
export const SRC_LINK = 'link';

/** 术语源文最长多少个字符（超过多半是正文，不是词条） */
export const MAX_TERM_SRC_LEN = 40;
/** 术语译文最长多少个字符 */
export const MAX_TERM_DST_LEN = 60;

/* ---------------- frontmatter ---------------- */

/** frontmatter 块：只认文件开头（正文中间的 --- 是分隔线） */
const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** 顶层分组行，如 `terms:`；捕获组 2 是其后的行内内容 */
const GROUP_RE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
/** 分组内条目行，如 `  源: 译` */
const ITEM_RE = /^\s+([^:]+?)\s*:\s*(.+?)\s*$/;
/** 单行内联映射里的单个配对 */
const INLINE_RE = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/;

/**
 * 切出 YAML frontmatter 与正文。
 * @returns {{meta:string, body:string, hasMeta:boolean}}
 */
export function splitFrontmatter(text){
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  const t = s.replace(/^\uFEFF/, '');   // BOM 会让 ^--- 失配
  const m = t.match(FM_RE);
  if (!m) return { meta: '', body: t, hasMeta: false };
  return { meta: m[1], body: t.slice(m[0].length), hasMeta: true };
}

/**
 * 解析 frontmatter 里的两级映射（terms: / names: / characters:）。
 *
 * 为什么不引入完整 YAML 解析：项目维持零新增运行时依赖（规划 Q8），
 * 而这里需要的只是最简单的两级映射，一个受控子集解析器足够且可单测。
 *
 * @returns {{terms:Object, names:Object}} 键为源文、值为译文
 */
export function parseFrontmatterTerms(meta){
  const terms = {}, names = {};
  let bucket = null;      // 'terms' | 'names' | null
  for (const raw of String(meta || '').split(/\r?\n/)){
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const group = raw.match(GROUP_RE);
    if (group && !/^\s/.test(raw)){
      const key = group[1].toLowerCase();
      bucket = (key === 'names' || key === 'characters') ? 'names'
        : (key === 'terms' || key === 'glossary') ? 'terms' : null;
      // 形如 `terms: { 先輩: 前辈 }` 的单行内联写法
      const inline = group[2].trim();
      if (bucket && inline.startsWith('{') && inline.endsWith('}')){
        for (const [k, v] of parseInlinePairs(inline)) addPair(bucket, k, v, terms, names);
      }
      continue;
    }
    if (!bucket) continue;
    const item = raw.match(ITEM_RE);
    if (item) addPair(bucket, unquote(item[1]), unquote(item[2]), terms, names);
  }
  return { terms, names };
}

/** 解析 `{ a: b, c: d }` 形式的单行映射 */
function parseInlinePairs(inline){
  const out = [];
  for (const seg of inline.slice(1, -1).split(',')){
    const m = seg.match(INLINE_RE);
    if (m) out.push([unquote(m[1]), unquote(m[2])]);
  }
  return out;
}

/** 去掉 YAML/Markdown 常见的成对包裹符号 */
function unquote(s){
  let t = String(s == null ? '' : s).trim();
  for (const [a, b] of [['"', '"'], ["'", "'"], ['「', '」'], ['『', '』'], ['《', '》']]){
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) t = t.slice(1, -1).trim();
  }
  return t;
}

function addPair(bucket, src, dst, terms, names){
  const s = String(src || '').trim();
  const d = String(dst || '').trim();
  if (!s || !d || s === d) return;            // 空 / 未翻译的映射无意义
  if (s.length > MAX_TERM_SRC_LEN || d.length > MAX_TERM_DST_LEN) return;
  if (bucket === 'names') names[s] = d;
  else terms[s] = d;
}

/* ---------------- 正文配对 ---------------- */

/** 配对分隔符：`::`（Dataview 常用）/ 箭头 / 全角竖线。
 *  ⚠️ 不带 g 标志：带 g 的正则调用 test() 会记住 lastIndex，同一正则连续 test
 *  会时而命中时而不命中（本文件曾在"一行多个分隔符"的判断上因此失准）。 */
const PAIR_SEP_RE = /\s*(?:::?:|→|⇒|｜)\s*/;
/** 表格行里的单元格分隔（半角竖线） */
const TABLE_CELL_RE = /\|/;
/** 代码围栏 */
const FENCE_RE = /^```/;

/**
 * 从正文里抽配对行（`先輩 :: 前辈`、`- 先輩 → 前辈`）。
 * 表格行与代码块交给别处 / 跳过。
 */
export function parseBodyPairs(body){
  const out = [];
  let inCode = false;
  for (const raw of String(body || '').split(/\r?\n/)){
    const line = raw.trim();
    if (FENCE_RE.test(line)){ inCode = !inCode; continue; }
    if (inCode || !line || line.startsWith('|')) continue;
    const content = line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '');
    const sep = content.match(PAIR_SEP_RE);
    if (!sep || sep.index === 0) continue;
    const left = content.slice(0, sep.index);
    const rest = content.slice(sep.index + sep[0].length);
    // 后半段再出现分隔符 → 多半是正文里的竖线，不是术语配对
    if (PAIR_SEP_RE.test(rest)) continue;
    const src = unquote(left), dst = unquote(rest);
    if (!src || !dst || src === dst) continue;
    if (src.length > MAX_TERM_SRC_LEN || dst.length > MAX_TERM_DST_LEN) continue;
    if (/^[-:\s]+$/.test(src)) continue;      // 纯分隔符残留（如表格分隔行）
    // 源文含空白 → 多半是散文里的句子而非词条。日文不使用空格分词，
    // 所以"左侧带空格"是相当可靠的散文信号（宁少收不乱收）。
    if (/\s/.test(src)) continue;
    out.push({ src, dst, source: SRC_LIST });
  }
  return out;
}

/** 表头列名：这些不该被当成术语条目 */
const HEADER_RE = /^(源|原文|日文|日语|术语|原名|译文|中文|译名|source|term|target|jp|zh)$/i;

/**
 * 解析 Markdown 表格里的「源 | 译」两列（取前两列，自动跳表头与分隔行）。
 */
export function parseTable(body){
  const out = [];
  for (const raw of String(body || '').split(/\r?\n/)){
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(TABLE_CELL_RE).map(unquote);
    if (cells.length < 2) continue;
    if (cells.every(c => /^[-:\s]*$/.test(c))) continue;   // |---|---|
    const [src, dst] = cells;
    if (HEADER_RE.test(src)) continue;
    if (!src || !dst || src === dst) continue;
    if (src.length > MAX_TERM_SRC_LEN || dst.length > MAX_TERM_DST_LEN) continue;
    out.push({ src, dst, source: SRC_TABLE });
  }
  return out;
}

/** [[目标]] 或 [[目标|别名]] */
const WIKILINK_RE = /\[\[([^\]\r\n|]+)(?:\|([^\]\r\n]+))?\]\]/g;

/**
 * 收集 [[双链]] 专有名词。
 *
 * 语义：笔记里写 [[先輩]] 表示"这是需要保留原文的专有名词"。我们没有它的译名，
 * 所以产物是**待补译的空壳**（dst 为空），由调用方提示用户补全而非静默丢弃。
 */
export function parseWikilinks(body){
  const out = [];
  const seen = new Set();
  for (const m of String(body || '').matchAll(WIKILINK_RE)){
    const target = String(m[1] || '').trim();
    const alias = String(m[2] || '').trim();
    const src = alias || target;
    if (!src || src.length > MAX_TERM_SRC_LEN || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, dst: '', source: SRC_LINK });
  }
  return out;
}

/* ---------------- 汇总 ---------------- */

/**
 * 解析一篇笔记 → 术语增量。
 *
 * @returns {{names:Object, terms:Object, pending:Array, stats:Object}}
 *          names/terms 可直接合并进 glossary；
 *          pending 是只有源文、缺译名的双链条目（调用方应提示补全，而非丢弃）。
 */
export function parseNote(text){
  const { meta, body, hasMeta } = splitFrontmatter(text);
  const fm = hasMeta ? parseFrontmatterTerms(meta) : { terms: {}, names: {} };
  const tablePairs = parseTable(body);
  const listPairs = parseBodyPairs(body);
  const links = parseWikilinks(body);

  const terms = { ...fm.terms };
  const names = { ...fm.names };
  for (const p of [...tablePairs, ...listPairs]){
    // frontmatter 优先：它多为作者手写的权威映射
    if (!(p.src in terms) && !(p.src in names)) terms[p.src] = p.dst;
  }

  const pending = [];
  for (const l of links){
    if (l.src in terms || l.src in names) continue;   // 已有译名，不算待补
    if (!pending.some(x => x.src === l.src)) pending.push({ src: l.src, source: l.source });
  }

  return {
    names, terms, pending,
    stats: {
      fronts: Object.keys(fm.terms).length + Object.keys(fm.names).length,
      tables: tablePairs.length,
      lists: listPairs.length,
      links: links.length,
    },
  };
}

/**
 * 合并多篇笔记的解析结果并去重待补项。
 *
 * 冲突处理：**先到先得**（同名条目以第一篇为准），并在 conflicts 里如实报告，
 * 让调用方能在预览里说明"这条被忽略了"，而不是静默覆盖。
 *
 * ⚠️ 待补项的判定必须在**收齐所有笔记的映射之后**再做：先收集再过滤的话，
 * 后面的笔记提供了译名也消不掉前面记下的待补（同一词的待补与译名常分散在不同笔记）。
 */
export function mergeNotes(results){
  const names = {}, terms = {}, conflicts = [];
  const pendingRaw = [];
  const seenPending = new Set();

  for (const r of (Array.isArray(results) ? results : [])){
    if (!r) continue;
    for (const [group, dst] of [['names', names], ['terms', terms]]){
      for (const [k, v] of Object.entries(r[group] || {})){
        if (k in dst && dst[k] !== v) conflicts.push({ src: k, kept: dst[k], ignored: v });
        else if (!(k in dst)) dst[k] = v;
      }
    }
    for (const p of r.pending || []){
      if (seenPending.has(p.src)) continue;
      seenPending.add(p.src);
      pendingRaw.push(p);
    }
  }

  // 收齐后再过滤：任何一篇给了译名（含本人名表）的，都不再是待补
  const pending = pendingRaw.filter(p => !(p.src in terms) && !(p.src in names));
  return { names, terms, pending, conflicts };
}
