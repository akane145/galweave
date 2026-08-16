// MDX 适配器单元测试 — node:test + node:assert, 纯逻辑不依赖 DOM
// 运行: node --test tests/mdx.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import fsShim, { registerBuffer, unregisterBuffer } from '../src/node-shims/fs.js';
import zlibShim from '../src/node-shims/zlib.js';
import assertShim from '../src/node-shims/assert.js';
import { sanitizeMdxHtml, buildMdxResults, createMdxProvider, createPathMdxProvider,
  createTauriMdxProvider, createTauriMdd,
  mimeFromExt, srcToResourceKey, isMddResourceSrc, isEntryLink, isSoundLink, linkTarget } from '../src/mdx.js';
import { base64ToArrayBuffer } from '../src/fs.js';

/* ---------------- 词条交互纯逻辑 ---------------- */

test('mimeFromExt: 常见图片/音频扩展名 → MIME', () => {
  assert.equal(mimeFromExt('a.png'), 'image/png');
  assert.equal(mimeFromExt('a.jpg'), 'image/jpeg');
  assert.equal(mimeFromExt('a.svg'), 'image/svg+xml');
  assert.equal(mimeFromExt('a.mp3'), 'audio/mpeg');
  assert.equal(mimeFromExt('a.wav'), 'audio/wav');
  assert.equal(mimeFromExt('unknown.xyz'), 'application/octet-stream');
  assert.equal(mimeFromExt(''), 'application/octet-stream');
});

test('srcToResourceKey: 去前导 / 或 \\ (MDD key 保留内部反斜杠)', () => {
  assert.equal(srcToResourceKey('/svg/accent.svg'), 'svg/accent.svg');
  assert.equal(srcToResourceKey('\\svg\\accent.svg'), 'svg\\accent.svg');
  assert.equal(srcToResourceKey('img/a.png'), 'img/a.png');
  assert.equal(srcToResourceKey(''), '');
});

test('isMddResourceSrc: 本地资源需要 MDD,外部协议不处理', () => {
  assert.equal(isMddResourceSrc('/svg/a.svg'), true);
  assert.equal(isMddResourceSrc('img/a.png'), true);
  assert.equal(isMddResourceSrc('https://x.com/a.png'), false);
  assert.equal(isMddResourceSrc('data:image/png;base64,xx'), false);
  assert.equal(isMddResourceSrc(''), false);
});

test('entry/sound 链接判断与目标提取', () => {
  assert.equal(isEntryLink('entry://食べる'), true);
  assert.equal(isEntryLink('entry://flower'), true);
  assert.equal(isEntryLink('sound://foo.mp3'), false);
  assert.equal(isSoundLink('sound://foo.mp3'), true);
  assert.equal(linkTarget('entry://食べる'), '食べる');
  assert.equal(linkTarget('sound://a/b.mp3'), 'a/b.mp3');
});

/* ---------------- fs shim(js-mdict 依赖的 openSync/readSync/closeSync) ---------------- */

test('fs shim: 注册 ArrayBuffer 后按 fd/position 读取(Uint8Array 与 DataView)', () => {
  const data = new Uint8Array(64);
  for (let i = 0; i < 64; i++) data[i] = i;
  registerBuffer('t://a', data.buffer.slice(0)); // 独立副本
  const fd = fsShim.openSync('t://a');
  assert.equal(typeof fd, 'number');

  const out = new Uint8Array(8);
  const n = fsShim.readSync(fd, out, { offset: 0, length: 8, position: 4 });
  assert.equal(n, 8);
  assert.deepEqual([...out], [4, 5, 6, 7, 8, 9, 10, 11]);

  // DataView 路径(readNumber 用法)
  const dv = new DataView(new ArrayBuffer(4));
  const n2 = fsShim.readSync(fd, dv, { length: 4, position: 10, offset: 0 });
  assert.equal(n2, 4);
  assert.equal(dv.getUint32(0), (10 << 24) | (11 << 16) | (12 << 8) | 13);

  // 越界只读可用部分
  const tail = new Uint8Array(8);
  assert.equal(fsShim.readSync(fd, tail, { length: 8, position: 60 }), 4);

  // BigInt position 也能读
  const b = new Uint8Array(2);
  fsShim.readSync(fd, b, { length: 2, position: BigInt(8) });
  assert.deepEqual([...b], [8, 9]);

  fsShim.closeSync(fd);
  assert.throws(() => fsShim.readSync(fd, new Uint8Array(1), { length: 1, position: 0 }), /无效 fd/);
  unregisterBuffer('t://a');
  assert.throws(() => fsShim.openSync('t://a'), /未注册/);
});

test('zlib shim: inflateSync 与 node:zlib deflate 往返', () => {
  const raw = Buffer.from('芍药不是药,牡丹才是丹。'.repeat(40), 'utf8');
  const packed = new Uint8Array(deflateSync(raw));
  const restored = zlibShim.inflateSync(packed);
  assert.equal(Buffer.from(restored).toString('utf8'), raw.toString('utf8'));
});

test('assert shim: 条件为假抛错', () => {
  assert.doesNotThrow(() => assertShim(1 === 1, 'ok'));
  assert.throws(() => assertShim(false, '坏格式'), /坏格式/);
});

/* ---------------- MDX 结果映射(注入桩实例) ---------------- */

function fakeInst(){
  return {
    lookup: async () => { throw new Error('boom'); },
    prefix: async () => { throw new Error('boom'); },
  };
}

test('buildMdxResults: 精确命中返回消毒后的 HTML 释义', async () => {
  const inst = {
    lookup: (w) => w === 'honda' ? { keyText: 'HONDA', definition: '<b>本</b>田<script>alert(1)</script>' } : { keyText: '', definition: null },
    prefix: () => [],
  };
  const rs = await buildMdxResults(inst, 'HONDA', 'D');
  assert.equal(rs.length, 1);
  assert.equal(rs[0].headword, 'HONDA');
  assert.equal(rs[0].source, 'D');
  // Node 无 DOMParser → sanitize 原样返回;浏览器冒烟再验消毒
  assert.ok(rs[0].senses[0].html.includes('<b>本</b>田'));
});

test('buildMdxResults: 无精确命中走小写兜底,再不行走前缀补全', async () => {
  const calls = [];
  const inst = {
    lookup: (w) => {
      calls.push(w);
      return w === 'apple' ? { keyText: 'apple', definition: '<p>苹果</p>' } : { keyText: '', definition: null };
    },
    prefix: (w) => w === 'app' ? [
      { keyText: 'apple' }, { keyText: 'application' }, { keyText: 'appstore' },
    ] : [],
    fetch: (item) => ({ keyText: item.keyText, definition: '<i>' + item.keyText + '</i>' }),
  };
  // 大小写兜底: APPLE → apple 命中
  const rs = await buildMdxResults(inst, 'APPLE', 'D');
  assert.equal(rs.length, 1);
  assert.equal(rs[0].headword, 'apple');
  // 前缀补全: appl 无命中 → prefix('appl') 空则空(此桩只在 'app' 有前缀)
  const rs2 = await buildMdxResults(inst, 'appl', 'D');
  assert.equal(rs2.length, 0);
  // 前缀补全: app → 3 条
  const rs3 = await buildMdxResults(inst, 'APP', 'D');
  assert.equal(rs3.length, 3);
  assert.deepEqual(rs3.map(r => r.headword), ['apple', 'application', 'appstore']);
  // 空词安全
  assert.deepEqual(await buildMdxResults(inst, '', 'D'), []);
});

test('buildMdxResults: 查询抛异常按未命中处理,不炸整个查询', async () => {
  const inst = {
    lookup: () => { throw new Error('corrupt'); },
    prefix: () => [{ keyText: 'x' }],
    fetch: () => { throw new Error('corrupt too'); },
  };
  const rs = await buildMdxResults(inst, '任意', 'D');
  assert.deepEqual(rs, []);
});

test('sanitizeMdxHtml: Node 无 DOMParser 时原样返回(浏览器行为由冒烟验证)', () => {
  if (typeof DOMParser === 'undefined'){
    assert.equal(sanitizeMdxHtml('<b>x</b>'), '<b>x</b>');
  }
});

test('buildMdxResults: @@@LINK 变体词跟随到主词条(含循环保护)', async () => {
  const dict = {
    花火: { keyText: '花火', definition: '@@@LINK=はなび' },
    はなび: { keyText: 'はなび', definition: '<div>烟花本义</div>' },
    a: { keyText: 'a', definition: '@@@LINK=b' },
    b: { keyText: 'b', definition: '@@@LINK=a' }, // 循环引用
    c: { keyText: 'c', definition: '@@@LINK=不存在' },
  };
  const inst = {
    lookup: (w) => dict[w] || { keyText: '', definition: null },
    prefix: () => [],
  };
  // 变体 → 主词条
  const rs = await buildMdxResults(inst, '花火', 'D');
  assert.equal(rs.length, 1);
  assert.equal(rs[0].headword, '花火 → はなび');
  assert.ok(rs[0].senses[0].html.includes('烟花本义'));
  // 目标词头是内部 ID(Jitendex 风格)时标题直接显示查询词
  const inst2 = {
    lookup: (w) => w === '食べる' ? { keyText: '食べる', definition: '@@@LINK=@jitendex-1358280' }
      : { keyText: '@jitendex-1358280', definition: '<div>食</div>' }, // 目标键的 keyText 就是内部 ID
    prefix: () => [],
  };
  const rsInt = await buildMdxResults(inst2, '食べる', 'D');
  assert.equal(rsInt[0].headword, '食べる', '内部 ID 目标不显示 @…');
  // 循环引用: 跟随失败 → 按无命中处理(前缀空 → 空结果)
  const rs2 = await buildMdxResults(inst, 'a', 'D');
  assert.deepEqual(rs2, []);
  // 目标不存在 → 空结果
  const rs3 = await buildMdxResults(inst, 'c', 'D');
  assert.deepEqual(rs3, []);
});

test('createMdxProvider: 非 ArrayBuffer 直接拒绝', async () => {
  await assert.rejects(() => createMdxProvider({ name: 'x', buffer: '不是buffer' }), /ArrayBuffer/);
});

/* ---------------- 懒加载 Provider(浏览器版 fetch 路径) ---------------- */

test('createPathMdxProvider: loadBuffer 失败时查询报错且可重试', async () => {
  let calls = 0;
  const p = createPathMdxProvider({
    name: 'X',
    loadBuffer: async () => { calls++; throw new Error('文件不见了'); },
  });
  assert.equal(p.isConfigured(), true, '路径已知即视为已配置');
  assert.equal(p.isLoaded(), false);
  await assert.rejects(() => p.lookup('词'), /文件不见了/);
  await assert.rejects(() => p.lookup('词'), /文件不见了/); // 失败不粘住,下次查询重试
  assert.equal(calls, 2);
});

test('createPathMdxProvider: 并发查询只触发一次 loadBuffer', async () => {
  let calls = 0;
  const p = createPathMdxProvider({
    name: 'X',
    loadBuffer: () => new Promise((_, reject) => setTimeout(() => { calls++; reject(new Error('读不了')); }, 50)),
  });
  await Promise.allSettled([p.lookup('a'), p.lookup('b'), p.lookup('c')]);
  assert.equal(calls, 1, '加载中并发去重');
});

/* ---------------- 桌面版 Tauri Provider(注入 invoke 桩) ---------------- */

/** 构造 Tauri 命令桩:记录调用,按 (cmd, args) 返回配置的结果。 */
function fakeInvoke(handlers, log){
  const calls = log || [];
  return async function invoke(cmd, args){
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (typeof h === 'function') return h(args);
    if (h !== undefined) return h;
    throw new Error('未处理的命令 ' + cmd);
  };
}

test('createTauriMdxProvider: 惰性 open——首次查询才 mdx_open,并发查询只开一次', async () => {
  let opens = 0;
  const log = [];
  const invoke = fakeInvoke({
    mdx_open: () => { opens++; return 7; },
    mdx_lookup: () => ({ key_text: 'honda', definition: '<b>本</b>田' }),
    mdx_prefix: () => [],
  }, log);
  const p = createTauriMdxProvider({ name: 'D', path: 'C:\\a.mdx', invokeImpl: invoke });
  assert.equal(p.isLoaded(), false, '未查询前不 open');
  // 并发 3 次查询: 只 open 一次
  const rs = await Promise.all([p.lookup('honda'), p.lookup('honda'), p.lookup('honda')]);
  assert.equal(opens, 1);
  assert.equal(rs[0][0].headword, 'honda');
  assert.ok(rs[0][0].senses[0].html.includes('<b>本</b>田'));
  assert.equal(rs[0][0].source, 'D');
  assert.equal(log[0].cmd, 'mdx_open');
  assert.equal(log[0].args.path, 'C:\\a.mdx');
});

test('createTauriMdxProvider: open 失败报错并缓存,不重复尝试', async () => {
  let opens = 0;
  const invoke = fakeInvoke({ mdx_open: () => { opens++; throw new Error('解析失败'); } });
  const p = createTauriMdxProvider({ name: 'D', path: 'C:\\bad.mdx', invokeImpl: invoke });
  await assert.rejects(() => p.lookup('词'), /MDX 文件解析失败\(D\)/);
  await assert.rejects(() => p.lookup('词'), /MDX 文件解析失败\(D\)/);
  assert.equal(opens, 1, 'open 失败后缓存,不再重试');
  assert.equal(p.isLoaded(), false);
});

test('createTauriMdxProvider: 未命中走 mdx_prefix 前缀补全(与浏览器版一致)', async () => {
  const log = [];
  const dict = {
    apple: '<p>苹果</p>', application: '<i>应用</i>', appstore: '<b>商店</b>',
  };
  const invoke = fakeInvoke({
    mdx_open: () => 1,
    mdx_lookup: (a) => dict[a.word] ? { key_text: a.word, definition: dict[a.word] } : null,
    mdx_prefix: (a) => a.word === 'app' ? ['apple', 'application', 'appstore'] : [],
  }, log);
  const p = createTauriMdxProvider({ name: 'D', path: 'C:\\x.mdx', invokeImpl: invoke });
  // 精确命中
  const hit = await p.lookup('apple');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].headword, 'apple');
  // 未命中 → prefix('app') → 逐词 lookup
  const rs = await p.lookup('app');
  assert.deepEqual(rs.map(r => r.headword), ['apple', 'application', 'appstore']);
  const cmds = log.filter(c => c.cmd === 'mdx_prefix');
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].args.limit, 6);
  // 前缀为空 → 空结果
  const empty = await p.lookup('zzz');
  assert.deepEqual(empty, []);
});

test('createTauriMdxProvider: dispose 释放句柄,之后可重新 open', async () => {
  const log = [];
  let opens = 0;
  const invoke = fakeInvoke({
    mdx_open: () => { opens++; return 5; },
    mdx_lookup: () => null,
    mdx_prefix: () => [],
    mdx_close: () => {},
  }, log);
  const p = createTauriMdxProvider({ name: 'D', path: 'C:\\x.mdx', invokeImpl: invoke });
  await p.lookup('a');
  p.dispose();
  assert.equal(p.isLoaded(), false);
  // dispose 的 mdx_close 是异步 fire-and-forget,等一个宏任务
  await new Promise(r => setTimeout(r, 0));
  assert.ok(log.some(c => c.cmd === 'mdx_close' && c.args.handle === 5));
  // dispose 后再查询 → 重新 open
  await p.lookup('b');
  assert.equal(opens, 2);
});

test('createTauriMdd: 惰性 open,resourceB64 返回 base64,resource 转 ArrayBuffer', async () => {
  const log = [];
  const b64 = Buffer.from([1, 2, 3]).toString('base64');
  const invoke = fakeInvoke({
    mdd_open: () => 3,
    mdd_resource: (a) => a.key === 'svg/a.svg' ? b64 : null,
    mdd_close: () => {},
  }, log);
  const mdd = createTauriMdd({ name: 'D 资源', path: 'C:\\x.mdd', invokeImpl: invoke });
  assert.equal(await mdd.resourceB64('svg/a.svg'), b64);
  const ab = await mdd.resource('svg/a.svg');
  assert.deepEqual([...new Uint8Array(ab)], [1, 2, 3]);
  assert.equal(await mdd.resource('缺的'), null);
  mdd.dispose();
  await new Promise(r => setTimeout(r, 0));
  assert.ok(log.some(c => c.cmd === 'mdd_close' && c.args.handle === 3));
  assert.equal(log[0].cmd, 'mdd_open');
  assert.equal(log[0].args.path, 'C:\\x.mdd');
});

/* ---------------- base64 → ArrayBuffer(桌面版 MDX 读文件解码) ---------------- */

test('base64ToArrayBuffer: 字节往返', () => {
  const src = new Uint8Array([0, 1, 2, 127, 200, 250, 255]);
  const b64 = Buffer.from(src).toString('base64');
  const back = new Uint8Array(base64ToArrayBuffer(b64));
  assert.deepEqual([...back], [...src]);
  assert.equal(base64ToArrayBuffer('').byteLength, 0);
});
