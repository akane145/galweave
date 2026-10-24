// 固定本地图标的字符串输出：无 DOM 依赖，用户文本不能成为 SVG 标记或 href。
const ICON_NAMES = new Set([
  'import', 'save', 'save-all', 'export', 'undo', 'redo', 'search', 'replace',
  'book', 'pen', 'check', 'warning', 'close', 'panel-collapse', 'more', 'plus',
  'return-to-editor', 'circle', 'pending',
]);

export function iconMarkup(name){
  if (!ICON_NAMES.has(name)) throw new RangeError('未知图标');
  return '<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-' + name + '"/></svg>';
}

export function rowStatusIcon(key){
  switch (key){
    case 'pending': return 'pending';
    case 'issue': return 'warning';
    case 'approved': return 'check';
    default: return 'circle';
  }
}
