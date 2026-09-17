const PROFILES = [
  { id: 'jitendex', match: /jitendex/i, css: ['common.css', 'jitendex.css'], tokens: {} },
  { id: 'daijirin3', match: /大辞林|DAIJIRIN3|スーパー大辞林/i, css: ['DAIJIRIN3.css'], tokens: {} },
  { id: 'meikyo3', match: /明鏡|MK3/i, css: ['MK3.css', 'MK3-appendix.css'], tokens: {} },
  { id: 'kojien7', match: /広辞苑|岩波/i, css: [], tokens: { '$midashi-color$': 'var(--dict-accent)', '$midashi-font-family$': 'var(--dict-head-font)', '$midashi-font-size$': '1.35em' } },
  { id: 'xsjrh', match: /新世纪|XSJRH/i, css: [], tokens: {} },
  { id: 'xmjrh', match: /新明解|XMJRH/i, css: [], tokens: {} },
  { id: 'shogakukan', match: /小学馆|Shogakukan/i, css: [], tokens: {} },
  { id: 'kodansha', match: /講談社|日本語大辞典/i, css: [], tokens: {} },
  { id: 'nihongo-shinjiten', match: /日本语新辞典/i, css: [], tokens: {} },
  { id: 'nlb', match: /(^|[\\/])NLB([\\/]|$)/i, css: [], tokens: {} },
  { id: 'dajici', match: /大词泉|DJS([\\/.]|$)/i, css: [], tokens: {} },
  { id: 'kougo-kenkyusha', match: /研究社|kougo/i, css: [], tokens: {} },
  { id: 'kogo-kadokawa', match: /古語大辞典|KogoGaiji/i, css: [], tokens: {} },
  { id: 'default', match: /.*/, css: [], tokens: {} },
];

export function profileForDictionary(pathOrName = '') {
  const input = String(pathOrName || '');
  return PROFILES.find(p => p.match.test(input)) || PROFILES[PROFILES.length - 1];
}

export function dictionaryCssCandidates(pathOrName = '') {
  const input = String(pathOrName || '');
  const profile = profileForDictionary(input);
  const base = input.split(/[\\/]/).pop() || '';
  const stem = base.replace(/\.mdx$/i, '');
  const out = [];
  const add = (name) => { if (name && !out.includes(name)) out.push(name); };
  add(stem + '.css');
  for (const name of profile.css) add(name);
  return { profile, candidates: out };
}

export function profileNormalizationCss(profileOrId) {
  const id = typeof profileOrId === 'string' ? profileOrId : (profileOrId && profileOrId.id) || 'default';
  const font = id === 'jitendex' || id === 'daijirin3' || id === 'meikyo3' || id === 'kojien7'
    ? 'var(--dict-head-font)'
    : 'var(--dict-body-font)';
  const extra = id === 'jitendex'
    ? '.dc-html[data-dict-profile="jitendex"] .headline{font-size:1.4em;line-height:1.28}'
    : '';
  return [
    `.dc-html[data-dict-profile="${id}"]{font-family:${font};font-size:var(--dict-base-size);line-height:1.62;color:var(--dict-text)}`,
    `.dc-html[data-dict-profile="${id}"] img,.dc-html[data-dict-profile="${id}"] svg,.dc-html[data-dict-profile="${id}"] video{max-width:100%;height:auto}`,
    `.dc-html[data-dict-profile="${id}"] table{max-width:100%;font-size:.92em}`,
    extra,
  ].filter(Boolean).join('');
}
