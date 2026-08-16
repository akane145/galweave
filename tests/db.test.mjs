// db.js 词典源持久化纯逻辑测试 — node:test + node:assert
// 覆盖 dictSourceToDbPayload:内存源 → dict_add_source 命令参数(HTTP 源 extra 打包)。
// 运行: node --test tests/db.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dictSourceToDbPayload } from '../src/db.js';

test('dictSourceToDbPayload: HTTP 源顶层字段打包进 extra(首次迁移形态)', () => {
  const p = dictSourceToDbPayload({
    id: 'ds_1', type: 'http', name: '在线词典', enabled: true,
    urlTemplate: 'https://api.example.com/dict?q={word}',
    map: { gloss: '$.data.means' },
    headers: { Authorization: 'Bearer sk-xxx' },
  });
  assert.equal(p.id, 'ds_1');
  assert.equal(p.kind, 'http');
  assert.equal(p.enabled, true);
  assert.equal(p.path, null);
  const extra = JSON.parse(p.extra);
  assert.equal(extra.urlTemplate, 'https://api.example.com/dict?q={word}');
  assert.deepEqual(extra.map, { gloss: '$.data.means' });
  assert.deepEqual(extra.headers, { Authorization: 'Bearer sk-xxx' });
});

test('dictSourceToDbPayload: HTTP 源已有 extra 时原样序列化', () => {
  const p = dictSourceToDbPayload({
    id: 'ds_2', type: 'http', name: 'x',
    extra: { urlTemplate: 'https://x/{word}', map: {}, headers: {} },
  });
  const extra = JSON.parse(p.extra);
  assert.equal(extra.urlTemplate, 'https://x/{word}');
});

test('dictSourceToDbPayload: JSON 源 extra 序列化,无 extra 为 null', () => {
  const withExtra = dictSourceToDbPayload({ id: 'a', type: 'json', name: 'j', extra: { k: 'v' } });
  assert.deepEqual(JSON.parse(withExtra.extra), { k: 'v' });
  const without = dictSourceToDbPayload({ id: 'b', type: 'json', name: 'j' });
  assert.equal(without.extra, null);
});

test('dictSourceToDbPayload: MDX 源保留 path,enabled 缺省为 true', () => {
  const p = dictSourceToDbPayload({ id: 'mdx:x', type: 'mdx', name: 'm', path: 'C:\\dicts\\a.mdx' });
  assert.equal(p.kind, 'mdx');
  assert.equal(p.path, 'C:\\dicts\\a.mdx');
  assert.equal(p.enabled, true);
  assert.equal(p.extra, null);
});

test('dictSourceToDbPayload: enabled:false 透传', () => {
  const p = dictSourceToDbPayload({ id: 'c', type: 'json', name: 'j', enabled: false });
  assert.equal(p.enabled, false);
});
