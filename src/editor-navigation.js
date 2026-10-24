// 编辑与校对导航的纯逻辑，不依赖 DOM。
export function editorKeyAction(e, suggestionsOpen = false){
  if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Tab') return e.shiftKey ? 'previous' : suggestionsOpen ? 'suggest' : 'next';
  if (e.key === 'Enter' && !e.shiftKey) return 'next';
  return null;
}

export function selectionFor(saved, length){
  const clamp = n => Math.max(0, Math.min(length, Number.isFinite(n) ? n : length));
  const start = clamp(saved?.start);
  return { start, end: Math.max(start, clamp(saved?.end)), direction: ['forward','backward'].includes(saved?.direction) ? saved.direction : 'none' };
}

export const DIAGNOSTIC_CATEGORIES = ['missing', 'placeholder', 'ratio', 'term', 'name-conflict', 'token', 'punct'];
export const ISSUE_CATEGORIES = ['all', ...DIAGNOSTIC_CATEGORIES, 'manual', 'annotation'];

// 诊断条目既可以是行号（旧形态，不带类别），也可以是 { i, kind }。
function diagnosticMap(diagnostics){
  const byKind = new Map();
  const add = (kind, i) => {
    if (!byKind.has(kind)) byKind.set(kind, new Set());
    byKind.get(kind).add(i);
  };
  for (const d of diagnostics){
    if (typeof d === 'number') add('', d);
    else if (d && Number.isInteger(d.i)) add(d.kind || '', d.i);
  }
  return byKind;
}

const hasOpenAnnotation = p => p.pr?.annotations?.some(a => !a.resolved) || false;

export function reviewQueue(paras, kind, diagnostics = [], category = 'all'){
  const byKind = diagnosticMap(diagnostics);
  const anyDiagnostic = new Set([...byKind.values()].flatMap(s => [...s]));
  const cat = ISSUE_CATEGORIES.includes(category) ? category : 'all';
  return paras.flatMap((p, i) => {
    const status = p.pr?.status || 'pending';
    const annotations = hasOpenAnnotation(p);
    let matches;
    if (kind === 'annotations') matches = annotations;
    else if (kind === 'issues'){
      matches = cat === 'all' ? anyDiagnostic.has(i) || status === 'issue' || annotations
        : cat === 'manual' ? status === 'issue'
        : cat === 'annotation' ? annotations
        : byKind.get(cat)?.has(i) || false;
    } else matches = status === 'pending';
    return matches ? [i] : [];
  });
}

// 各类别的行数（按行去重，与 reviewQueue 的长度口径一致）。
export function issueCategoryCounts(paras, diagnostics = []){
  const counts = {};
  for (const c of ISSUE_CATEGORIES) counts[c] = reviewQueue(paras, 'issues', diagnostics, c).length;
  return counts;
}

export function nextInQueue(queue, current, direction = 1){
  if (!queue.length) return -1;
  return direction < 0
    ? (queue.findLast(i => i < current) ?? queue[queue.length - 1])
    : (queue.find(i => i > current) ?? queue[0]);
}
