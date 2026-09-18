// validate.js — 结构校验与原文基线比对（纯逻辑，无 DOM、无 vscode 依赖）
//
// 两类检查：
//   1. validateStructure —— 段落内部/之间的结构问题（编号不匹配、段内多余行、编号重复…）
//   2. diffBaseline     —— 原文行与基线快照的差异
//
// 为什么第 2 类重要：VS Code 没有行级只读 API（microsoft/vscode#88885 至今 Backlog），
// 拦不住用户在原生编辑器里改原文。"原文永不修改"这条不变量只能靠
//   写入层不改原文（见 PLAN §10）+ 基线比对把误改**报出来** + git/撤销兜底。
//
// 所有判定都是**启发式**，宁漏报不误报 —— 诊断清单一旦刷噪音就会被无视。

/** 严重级别；vscode 层再映射成 DiagnosticSeverity */
export const SEVERITY = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
  HINT: 'hint',
};

/** 问题码 → 人读文案前缀。放入 message 便于在「问题」面板里一眼分类。 */
export const CODE_LABEL = {
  'id-mismatch': '编号不匹配',
  'extra-lines': '段内多余行',
  'duplicate-id': '编号重复',
  'orphan-trans': '译文行缺少编号',
  'name-untranslated': '人名未译',
  'untranslated': '未翻译',
  'baseline-line': '原文与基线不一致',
  'baseline-count': '原文段落数变化',
};

const preview = (s, n = 32) => {
  const x = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n) + '…' : x;
};

/**
 * 从编号里拆出「数字部分 + 后缀」。前缀原样留着，进制由 analyzeOffset 决定。
 * 用于识别**编号系统性偏移**的引擎约定：实测样本 `新建 文本文档 (11).txt`
 * 全部 33 对都是 `★ 编号 = ☆ 编号 + 1`（`☆000009T☆` 配 `★000010T★`）——
 * 那是约定不是错误，逐行报"编号不匹配"会刷 33 条假警报，把诊断面板变成噪音源。
 */
function splitId(id) {
  const m = String(id == null ? '' : id).match(/^([0-9A-Fa-f]+)(.*)$/);
  return m ? { raw: m[1], suffix: m[2] } : null;
}

/**
 * 判断本文件的编号偏移约定。
 *
 * **进制不能假定**：同一份文件的编号可能是十进制计数器（`000009 → 000010`，差 1），
 * 也可能是十六进制地址（`00000E → 00000F`）。按错进制算会得到一堆假的"偏移不一致"——
 * 实测把十进制计数器当十六进制读，`000009→000010` 会被算成差 7。
 * 所以两种进制各算一遍，取"符合偏移的行数更多"的那套。
 */
function analyzeOffset(pairs) {
  let best = null;
  for (const base of [10, 16]) {
    const counts = new Map();
    for (const { a, b } of pairs) {
      if (!a || !b || a.suffix !== b.suffix) continue;
      const d = parseInt(b.raw, base) - parseInt(a.raw, base);
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    if (!counts.size) continue;
    const [offset, matched] = [...counts.entries()]
      .sort((x, y) => (y[1] - x[1]) || (Math.abs(x[0]) - Math.abs(y[0])))[0];
    if (!best || matched > best.matched) best = { offset, base, matched };
  }
  return best || { offset: 0, base: 10, matched: 0 };
}

/**
 * 段落结构校验。
 * @param {{paras: Array}} parsed parseLines 的结果
 * @param {{reportUntranslated?: boolean}} [opts]
 * @returns {Array<{line:number,endLine:number,severity:string,code:string,message:string}>}
 */
export function validateStructure(parsed, opts = {}) {
  const paras = Array.isArray(parsed?.paras) ? parsed.paras : [];
  const out = [];

  const push = (para, extra) => out.push({
    line: extra.line != null ? extra.line : para.lineIndices.orig,
    endLine: extra.endLine != null ? extra.endLine : para.lineIndices.orig,
    severity: extra.severity,
    code: extra.code,
    message: extra.message,
  });

  // 先确定本文件的编号偏移约定，再逐行检查 —— 顺序不能反。
  // 门槛：至少 3 对才承认"非零偏移是约定"。只有一两对时众数就是它自己，
  // 会把每一对都判成"符合约定"，等于永远不报错。
  const MIN_OFFSET_EVIDENCE = 3;
  const pairs = paras
    .filter(p => p.lineIndices.trans !== null && p.lineIndices.trans !== undefined && p.transId && p.id)
    .map(p => ({ para: p, a: splitId(p.id), b: splitId(p.transId) }));
  const { offset, base } = pairs.length >= MIN_OFFSET_EVIDENCE
    ? analyzeOffset(pairs)
    : { offset: 0, base: 10 };

  if (offset !== 0) {
    out.push({
      line: 0,
      endLine: 0,
      severity: SEVERITY.INFO,
      code: 'id-offset',
      message: '本文件的译文行编号统一比原文行大 ' + offset
        + '（引擎约定，不算错误）。注意：按原文行重建译文行会改掉这些编号，'
        + '所以这个文件不适合"原格式导出"。',
    });
  }

  for (const { para, a, b } of pairs) {
    const ok = (a && b && a.suffix === b.suffix)
      ? (parseInt(b.raw, base) - parseInt(a.raw, base) === offset)
      : (para.transId === para.id);
    if (ok) continue;
    push(para, {
      line: para.lineIndices.trans,
      severity: SEVERITY.ERROR,
      code: 'id-mismatch',
      message: '译文行编号「' + para.transId + '」与原文行编号「' + para.id + '」不一致'
        + (offset !== 0 ? '（本文件其余行统一相差 ' + offset + '）' : ''),
    });
  }

  // 逐段检查（编号不匹配已在上面按"偏移约定"统一处理）
  for (const para of paras) {
    const li = para.lineIndices;

    // 2) 段内多余行：parseFile 只取段内前两行，第三行起在保存时会丢失
    if (li.extra && li.extra.length) {
      push(para, {
        line: li.extra[0],
        endLine: li.extra[li.extra.length - 1],
        severity: SEVERITY.WARNING,
        code: 'extra-lines',
        message: `段内有 ${li.extra.length} 行既不是原文也不是译文，保存时会丢失：${preview(parsed.lines[li.extra[0]].text)}`,
      });
    }

    // 3) 译文行有内容却解析不出编号
    if (li.trans !== null && li.trans !== undefined && !para.transId
        && String(para.translation || '').trim() !== '') {
      push(para, {
        line: li.trans,
        severity: SEVERITY.WARNING,
        code: 'orphan-trans',
        message: `译文行没有解析出编号，导出时可能与原文行对不上：${preview(parsed.lines[li.trans].text)}`,
      });
    }

    // 4) 人名条目没给译名（含默认名时算已译，故只在名字为空时提示）
    if (para.isName && !String(para.nameTr || '').trim()) {
      push(para, {
        severity: SEVERITY.HINT,
        code: 'name-untranslated',
        message: `人名条目「${preview(para.name || para.content, 16)}」没有名字`,
      });
    }

    // 5) 未翻译（默认不报：新文件会刷满，需要时由调用方开启）
    if (opts.reportUntranslated && !para.done) {
      push(para, {
        severity: SEVERITY.HINT,
        code: 'untranslated',
        message: `未翻译：${preview(para.content, 40)}`,
      });
    }
  }

  // 6) 编号重复：游戏脚本里同一编号出现两次，导出后引擎多半只认一个
  const byId = new Map();
  for (const para of paras) {
    if (!para.id) continue;
    if (!byId.has(para.id)) byId.set(para.id, []);
    byId.get(para.id).push(para);
  }
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    for (const para of group) {
      push(para, {
        severity: SEVERITY.WARNING,
        code: 'duplicate-id',
        message: `编号「${id}」在本文件出现 ${group.length} 次`,
      });
    }
  }

  return out.sort((a, b) => a.line - b.line || a.code.localeCompare(b.code));
}

/** 从解析结果抽出原文行快照（存基线用）。 */
export function baselineFrom(parsed) {
  const paras = Array.isArray(parsed?.paras) ? parsed.paras : [];
  return paras.filter(p => !p.isName).map(p => p.orig);
}

/**
 * 原文行与基线比对。基线为 null/空数组时返回空（未记录基线 = 不做这项检查）。
 * @param {{paras:Array}} parsed
 * @param {string[]|null} baseline
 * @returns {Array} 同 validateStructure 的 Finding 结构
 */
export function diffBaseline(parsed, baseline) {
  if (!Array.isArray(baseline) || !baseline.length) return [];
  const paras = (Array.isArray(parsed?.paras) ? parsed.paras : []).filter(p => !p.isName);

  const out = [];
  if (paras.length !== baseline.length) {
    out.push({
      line: 0,
      endLine: 0,
      severity: SEVERITY.INFO,
      code: 'baseline-count',
      message: `原文段落数变化：基线 ${baseline.length} 段 → 现在 ${paras.length} 段`,
    });
  }

  // 先按行号对齐找差异，再用"在基线里找不到"补充判断 —— 段中插入行会整体错位，
  // 只按行号比会把后面全部报成改动，噪音过大。
  const baselineSet = new Set(baseline);
  const currentSet = new Set(paras.map(p => p.orig));
  const changed = [];
  for (let i = 0; i < paras.length; i++) {
    const cur = paras[i].orig;
    if (i < baseline.length && baseline[i] === cur) continue;
    if (baselineSet.has(cur)) continue; // 只是错位，内容仍在基线里
    changed.push({ para: paras[i], index: i });
  }

  const removed = baseline.filter(b => !currentSet.has(b));
  for (const r of removed.slice(0, 20)) {
    out.push({
      line: 0,
      endLine: 0,
      severity: SEVERITY.WARNING,
      code: 'baseline-line',
      message: `原文行在基线中存在、当前文件已找不到：${preview(r, 40)}`,
    });
  }

  for (const c of changed.slice(0, 50)) {
    out.push({
      line: c.para.lineIndices.orig,
      endLine: c.para.lineIndices.orig,
      severity: SEVERITY.WARNING,
      code: 'baseline-line',
      message: `原文与基线不一致（基线第 ${c.index + 1} 段）：${preview(c.para.orig, 40)}`,
    });
  }

  return out.sort((a, b) => a.line - b.line);
}
