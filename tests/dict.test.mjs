// 词典/建议/片段/CSV 单元测试 — node:test + node:assert, 纯逻辑不依赖 DOM
// 运行: node --test tests/dict.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, toGlossary, fromGlossary } from '../src/csv.js';
import { currentToken, matchSuggestions } from '../src/suggest.js';
import { mergeSnippets, sanitizeSnippets, projectSnippetsPath } from '../src/snippets.js';
import {
  parseDictJson, matchEntries, extractPath, httpToResults, lookupAll,
  createJsonDictProvider, createHttpDictProvider,
  registerProvider, clearProviders, getProviders,
  groupDictResults, favoriteKey, isFavorite, toggleFavorite,
} from '../src/dict.js';

/* ---------------- CSV 解析 ---------------- */

test('parseCsv: 基本逗号分隔与空行过滤', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n\r\n1,2,3\n'), [['a','b','c'],['1','2','3']]);
});

test('parseCsv: 引号字段、转义引号、字段内换行与逗号', () => {
  const rows = parseCsv('"hello, world","say ""hi""","line1\nline2",x');
  assert.deepEqual(rows, [['hello, world', 'say "hi"', 'line1\nline2', 'x']]);
});

test('parseCsv: BOM 与末尾无换行', () => {
  assert.deepEqual(parseCsv('\uFEFF原文,译文'), [['原文','译文']]);
  assert.deepEqual(parseCsv('a,b'), [['a','b']]);
});

test('toGlossary: 2 列进词条,3 列按类型路由,表头自动跳过', () => {
  const g = toGlossary([
    ['类型','原文','译文'],
    ['名词','桐吾','桐吾'],
    ['人名','ティナ','蒂娜'],
    ['term','魔法','magic'],
    ['雑魚','杂鱼'],           // 无类型前缀的 2 列
    ['名词', '', 'x'],         // 空原文忽略
  ]);
  assert.deepEqual(g.names, { '桐吾': '桐吾', 'ティナ': '蒂娜' });
  assert.deepEqual(g.terms, { '魔法': 'magic', '雑魚': '杂鱼' });
});

test('toGlossary: 2 列表头(原文,译文)也跳过', () => {
  const g = toGlossary([['原文','译文'],['魔法','魔法']]);
  assert.deepEqual(g.terms, { '魔法': '魔法' });
  assert.deepEqual(g.names, {});
});

test('fromGlossary ↔ toGlossary 往返(导出带 UTF-8 BOM,导入自动剥离)', () => {
  const g = { names: { 'ティナ': '蒂娜' }, terms: { '魔法': '魔,法"测"试' } };
  const csv = fromGlossary(g);
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'CSV 开头是 UTF-8 BOM(Excel 兼容)');
  const back = toGlossary(parseCsv(csv));
  assert.deepEqual(back, g);
});

/* ---------------- 输入建议 ---------------- */

test('currentToken: 分隔符切分与长度上限', () => {
  assert.equal(currentToken('「食べる', 4), '食べる');
  assert.equal(currentToken('早上好，世界', 3), '早上好');
  assert.equal(currentToken('早上好，世界', 4), '', '光标紧跟分隔符 → 空词元');
  assert.equal(currentToken('', 0), '');
  assert.equal(currentToken('abcdef', 3), 'abc');
  assert.equal(currentToken('abcdefghij0123456', 17).length, 12, '上限 12 字符');
  assert.equal(currentToken('あいう', 99), 'あいう', 'caret 越界夹取');
});

test('matchSuggestions: 精确 > 前缀 > 包含,同级短者在前,限 8 条', () => {
  const terms = { '魔法': 'magic', '魔法少女': '魔法少女', '黒魔法': 'dark' };
  const snips = { 'ys': '我是缩写' };
  const out = matchSuggestions('魔法', terms, snips);
  assert.equal(out[0].src, '魔法');
  assert.equal(out[0].kind, 'term');
  assert.equal(out.find(x => x.src === '魔法少女').kind, 'term');
  assert.equal(out.find(x => x.src === 'ys'), undefined, '不相关片段不出现');
  const snips2 = matchSuggestions('ys', terms, { 'y': 'Y 展开', 'ys': '应答展开', 'ysl': '另一条' });
  assert.equal(snips2[0].src, 'ys');
  assert.ok(snips2.every(x => x.src.includes('y')));
});

test('matchSuggestions: 空词元/空表安全', () => {
  assert.deepEqual(matchSuggestions('', { a: 'b' }, null), []);
  assert.deepEqual(matchSuggestions('x', null, null), []);
  assert.deepEqual(matchSuggestions('x', { '': '空键' }, { 'k': '' }), []);
});

/* ---------------- 片段(纯函数) ---------------- */

test('mergeSnippets: 项目覆盖全局', () => {
  assert.deepEqual(
    mergeSnippets({ ys: '全局', a: 'A' }, { ys: '项目' }),
    { ys: '项目', a: 'A' }
  );
});

test('sanitizeSnippets: 去空白键与空值', () => {
  assert.deepEqual(
    sanitizeSnippets({ ' ys ': 'v', '': 'x', k: '', n: null }),
    { ys: 'v' }
  );
});

test('projectSnippetsPath: 归一化与空目录', () => {
  assert.equal(projectSnippetsPath('E:\\a\\b\\'), 'E:/a/b/snippets.json');
  assert.equal(projectSnippetsPath(''), null);
});

/* ---------------- 词典 JSON 解析与匹配 ---------------- */

test('parseDictJson: 字符串简写与对象释义,坏格式返回 null', () => {
  const d = parseDictJson(JSON.stringify({
    format: 'galtrans-dict-v1', name: 'T',
    entries: { ごめん: '对不起', 食べる: { reading: 'たべる', senses: [{ pos: '动词', gloss: '吃', examples: [{ src: 's', dst: 'd' }] }] }, 坏: {} },
  }));
  assert.equal(d.name, 'T');
  assert.deepEqual(d.entries['ごめん'], { reading: '', senses: [{ gloss: '对不起' }] });
  assert.equal(d.entries['食べる'].senses[0].pos, '动词');
  assert.equal(d.entries['食べる'].senses[0].examples[0].dst, 'd');
  assert.ok(!('坏' in d.entries), '无有效释义的条目丢弃');
  assert.equal(parseDictJson('not json'), null);
  assert.equal(parseDictJson('{"name":"x"}'), null, '缺 entries');
});

test('matchEntries: 词条/读音精确优先,无精确时前缀补全', () => {
  const entries = {
    食べる: { reading: 'たべる', senses: [{ gloss: '吃' }] },
    食べ物: { reading: 'たべもの', senses: [{ gloss: '食物' }] },
    食堂: { reading: 'しょくどう', senses: [{ gloss: '食堂' }] },
  };
  assert.deepEqual(matchEntries(entries, '食べる').map(e => e.headword), ['食べる']);
  assert.deepEqual(matchEntries(entries, 'たべもの').map(e => e.headword), ['食べ物'], '读音精确命中');
  const pref = matchEntries(entries, '食べ');
  assert.equal(pref.length, 2);
  assert.deepEqual(matchEntries(entries, ''), []);
});

test('extractPath: 点路径取值(含数组下标),非法路径 undefined', () => {
  const data = { a: { b: [{ c: 'x' }], d: 1 } };
  assert.equal(extractPath(data, '$'), data);
  assert.equal(extractPath(data, '$.a.b.0.c'), 'x');
  assert.equal(extractPath(data, '$.a.d'), 1);
  assert.equal(extractPath(data, '$.a.z'), undefined);
  assert.equal(extractPath(data, 'a.b'), undefined, '必须 $. 开头');
  assert.equal(extractPath(null, '$.a'), undefined);
});

test('httpToResults: 字符串/数组/对象释义与 root/headword/reading 映射', () => {
  const data = {
    word: '食べる', kana: 'たべる',
    items: [{ pos: 'v1', tr: '吃' }, { pos: 'v2', tr: '进食' }],
  };
  const out = httpToResults(data, {
    root: '$.items', headword: '$..word', // 非法路径 → 回退查询词
  }, 'HTTP测试', '食べる');
  // root 指向条目数组,但条目内 gloss 未映射 → 无结果
  assert.equal(out.length, 0);

  const out2 = httpToResults({ items: [{ w: '食べる', k: 'たべる', t: ['吃', '进食'] }] },
    { root: '$.items', headword: '$.w', reading: '$.k', gloss: '$.t' }, 'H', '食べる');
  assert.equal(out2.length, 1);
  assert.equal(out2[0].headword, '食べる');
  assert.equal(out2[0].reading, 'たべる');
  assert.deepEqual(out2[0].senses, [{ gloss: '吃' }, { gloss: '进食' }]);

  const out3 = httpToResults({ translation: '吃' }, { gloss: '$.translation' }, 'H', '食べる');
  assert.equal(out3[0].headword, '食べる', 'headword 未映射回退查询词');
  const out4 = httpToResults({ senses: [{ pos: '動', gloss: '吃' }] }, { gloss: '$.senses' }, 'H', 'x');
  assert.deepEqual(out4[0].senses, [{ pos: '動', gloss: '吃' }]);
});

/* ---------------- Provider 适配器 ---------------- */

test('createJsonDictProvider: 懒加载 + 缓存 + 坏文件报错', async () => {
  let loads = 0;
  const good = createJsonDictProvider({
    name: 'G', path: 'E:/d.json',
    loadFile: async () => { loads++; return JSON.stringify({ entries: { 食べる: '吃' } }); },
  });
  assert.equal(good.isConfigured(), true);
  assert.deepEqual(await good.lookup('食べる'), [{ headword: '食べる', reading: '', senses: [{ gloss: '吃' }], source: 'G' }]);
  await good.lookup('食べる');
  assert.equal(loads, 1, '只加载一次,之后走缓存');

  const bad = createJsonDictProvider({ name: 'B', path: 'E:/bad.json', loadFile: async () => 'not json' });
  await assert.rejects(() => bad.lookup('x'), /格式不合法/);
  await assert.rejects(() => bad.lookup('x'), /格式不合法/);
  assert.equal(bad.isConfigured(), false, '失败后视为不可用');

  const mem = createJsonDictProvider({ name: 'M', entries: { 駄目: '不行' } });
  assert.equal((await mem.lookup('駄目'))[0].senses[0].gloss, '不行');
});

test('createHttpDictProvider: URL 模板编码/字段映射/非 200 报错/超时中断', async () => {
  let lastUrl = '', lastOpts = null;
  const ok = createHttpDictProvider({
    name: 'H', urlTemplate: 'https://api.x/dict?q={word}&w={word}',
    headers: { 'X-Key': 'k' },
    fetchImpl: async (u, o) => { lastUrl = u; lastOpts = o; return { ok: true, json: async () => ({ word: '食べる', result: [{ type: '動詞', mean: '吃' }] }) }; },
    map: { root: '$.result', headword: '$.word', gloss: '$.mean' },
  });
  const rs = await ok.lookup('食べる');
  assert.equal(lastUrl, 'https://api.x/dict?q=%E9%A3%9F%E3%81%B9%E3%82%8B&w=%E9%A3%9F%E3%81%B9%E3%82%8B');
  assert.equal(lastOpts.headers['X-Key'], 'k');
  assert.equal(rs[0].headword, '食べる');
  assert.deepEqual(rs[0].senses, [{ gloss: '吃' }]);

  const fail = createHttpDictProvider({
    name: 'F', urlTemplate: 'https://x/{word}',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await assert.rejects(() => fail.lookup('x'), /HTTP 503/);

  const unconf = createHttpDictProvider({ name: 'U' });
  assert.equal(unconf.isConfigured(), false);
});

test('lookupAll: 并发聚合,单个失败进 errors 不影响其余', async () => {
  const ps = [
    { id: 'a', name: 'A', isConfigured: () => true, lookup: async () => [{ headword: 'w', reading: '', senses: [{ gloss: 'a' }], source: 'A' }] },
    { id: 'b', name: 'B', isConfigured: () => true, lookup: async () => { throw new Error('boom'); } },
    { id: 'c', name: 'C', isConfigured: () => false, lookup: async () => [{ headword: 'x', senses: [], source: 'C' }] },
  ];
  const r = await lookupAll('w', ps);
  assert.equal(r.results.length, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].source, 'B');
  assert.ok(/boom/.test(r.errors[0].message));
});

test('注册表: registerProvider 去重,clearProviders 清空', async () => {
  clearProviders();
  const p = createJsonDictProvider({ id: 'test:dup', name: 'T', entries: { 可愛い: { reading: 'かわいい', senses: [{ gloss: '可爱' }] } } });
  registerProvider(p);
  registerProvider(createJsonDictProvider({ id: 'test:dup', name: 'T2', entries: { x: 'y' } })); // 同 id 去重
  assert.equal(getProviders().length, 1);
  assert.equal(getProviders()[0].name, 'T');
  const rs = await getProviders()[0].lookup('可愛い');
  assert.equal(rs[0].senses[0].gloss, '可爱');
  assert.equal(rs[0].reading, 'かわいい');
  clearProviders();
  assert.equal(getProviders().length, 0);
});

/* ---------------- 词典增强: 模糊 / 分组 / 收藏 ---------------- */

const EN = { apple: '苹果', candy: '糖果', application: '应用', 食べる: '吃', 食べ物: '食物' };

test('matchEntries: 无精确/前缀时 fuzzy 走包含匹配(≤20)', () => {
  // 精确
  assert.deepEqual(matchEntries(EN, 'apple').map(e => e.headword), ['apple']);
  // 前缀
  assert.deepEqual(matchEntries(EN, 'app').map(e => e.headword), ['apple', 'application']);
  // 普通无命中(没有 fuzzy) → 空
  assert.deepEqual(matchEntries(EN, '吃'), []);
  // fuzzy 包含: '食べ' 的包含匹配
  const fz = matchEntries(EN, '食べ', { fuzzy: true }).map(e => e.headword);
  assert.deepEqual(fz, ['食べる', '食べ物']);
  // fuzzy 对精确命中不干扰
  assert.deepEqual(matchEntries(EN, 'apple', { fuzzy: true }).map(e => e.headword), ['apple']);
});

test('groupDictResults: 同词多源并入一张卡,组内含来源分段', () => {
  const results = [
    { headword: '食べる', reading: 'たべる', senses: [{ gloss: 'A' }], source: 'D1' },
    { headword: '食べる', reading: 'たべる', senses: [{ gloss: 'B' }], source: 'D2' },
    { headword: '花火', reading: '', senses: [{ gloss: 'C' }], source: 'D1' },
  ];
  const g = groupDictResults(results);
  assert.equal(g.length, 2);
  const eat = g.find(x => x.headword === '食べる');
  assert.deepEqual(eat.sources.map(s => s.source), ['D1', 'D2']);
  assert.equal(eat.sources[0].senses[0].gloss, 'A');
  assert.equal(eat.sources[1].senses[0].gloss, 'B');
});

test('收藏: favoriteKey 唯一、isFavorite/toggleFavorite 增删', () => {
  const a = { word: '食べる', reading: 'たべる', source: 'D1' };
  const b = { word: '食べる', reading: 'たべる', source: 'D2' };
  assert.notEqual(favoriteKey(a), favoriteKey(b), '不同源视为不同收藏');
  let list = [];
  assert.equal(isFavorite(list, a), false);
  list = toggleFavorite(list, a);
  assert.equal(list.length, 1);
  assert.equal(isFavorite(list, a), true);
  assert.equal(isFavorite(list, b), false);
  list = toggleFavorite(list, a); // 再切 → 取消
  assert.deepEqual(list, []);
  // 同时收集两个不同源都保留
  list = toggleFavorite(toggleFavorite([], a), b);
  assert.equal(list.length, 2);
});
