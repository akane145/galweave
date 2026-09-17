// recovery.js 纯逻辑测试 — node:test + node:assert
// 运行: node --test tests/recovery.test.mjs
// 注：只测纯判定，不碰 readSession/writeSession（依赖 Tauri / localStorage）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeMarker, parseMarker, sealMarker, shouldOfferRecovery, recoveryMessage, newSessionId,
} from '../src/recovery.js';

test('makeMarker: 归一化字段，startedAt 非法时回退当前时间', () => {
  const m = makeMarker({ sessionId: 'S1', startedAt: 1000, doc: 'a.ks', path: 'C:/x/a.ks' });
  assert.equal(m.v, 1);
  assert.equal(m.sessionId, 'S1');
  assert.equal(m.startedAt, 1000);
  assert.equal(m.doc, 'a.ks');
  assert.equal(m.path, 'C:/x/a.ks');
  assert.equal(m.closedAt, undefined);

  const bad = makeMarker({ sessionId: 'S1', startedAt: 'abc' });
  assert.ok(bad.startedAt > 0);
  assert.equal(bad.doc, '');
  assert.equal(bad.path, '');
});

test('parseMarker: 接受对象与 JSON 字符串两种输入', () => {
  const json = JSON.stringify({ v: 1, sessionId: 'S1', startedAt: 1000, doc: 'a.ks', path: 'p' });
  assert.deepEqual(parseMarker(json), { v: 1, sessionId: 'S1', startedAt: 1000, doc: 'a.ks', path: 'p' });
  assert.deepEqual(parseMarker({ v: 1, sessionId: 'S1', startedAt: 1000 }), {
    v: 1, sessionId: 'S1', startedAt: 1000, doc: '', path: '',
  });
});

test('parseMarker: 损坏/结构不符一律返回 null（宁可漏报，不弹看不懂的框）', () => {
  assert.equal(parseMarker(null), null);
  assert.equal(parseMarker(undefined), null);
  assert.equal(parseMarker(''), null);
  assert.equal(parseMarker('   '), null);
  assert.equal(parseMarker('{不是 json'), null);
  assert.equal(parseMarker(42), null);
  assert.equal(parseMarker('"字符串"'), null);
  assert.equal(parseMarker({}), null);                              // 缺 v / sessionId
  assert.equal(parseMarker({ v: 2, sessionId: 'S1' }), null);        // 版本不符
  assert.equal(parseMarker({ v: 1, sessionId: '' }), null);          // sessionId 为空
  assert.equal(parseMarker({ v: 1, sessionId: 'S1', closedAt: 'x' }), null); // closedAt 非法
});

test('parseMarker: 保留合法 closedAt', () => {
  const m = parseMarker({ v: 1, sessionId: 'S1', startedAt: 1, closedAt: 2000 });
  assert.equal(m.closedAt, 2000);
});

test('sealMarker: 补上 closedAt 不改其它字段；null 原样返回', () => {
  const m = makeMarker({ sessionId: 'S1', startedAt: 1000, doc: 'a.ks' });
  const sealed = sealMarker(m, 2000);
  assert.equal(sealed.closedAt, 2000);
  assert.equal(sealed.sessionId, 'S1');
  assert.equal(sealed.doc, 'a.ks');
  assert.equal(m.closedAt, undefined, '不应修改原对象');
  assert.equal(sealMarker(null, 1), null);
});

test('shouldOfferRecovery: 只在"有标记 + 未封存 + 非同会话"时为真', () => {
  const unsealed = makeMarker({ sessionId: 'S1' });
  assert.equal(shouldOfferRecovery(unsealed, 'S2'), true);

  // 正常退出（有 closedAt）→ 不提示
  assert.equal(shouldOfferRecovery(sealMarker(unsealed, 1), 'S2'), false);

  // 没有标记（首次启动 / 数据损坏）→ 不提示
  assert.equal(shouldOfferRecovery(null, 'S2'), false);
  assert.equal(shouldOfferRecovery(undefined, 'S2'), false);

  // 同一次会话（防御）→ 不提示
  assert.equal(shouldOfferRecovery(unsealed, 'S1'), false);
});

test('recoveryMessage: 标题写具体后果，带文件名与时间', () => {
  const m = makeMarker({ sessionId: 'S1', startedAt: Date.UTC(2026, 8, 10, 13, 5), doc: 'story_01.ks' });
  const msg = recoveryMessage(m);
  assert.equal(msg.title, '检测到上次异常退出');
  assert.ok(msg.message.includes('story_01.ks'));
  assert.ok(msg.message.includes('2026-09-10'));
  assert.ok(msg.message.includes('崩溃或被强制结束'));
  assert.equal(msg.confirmText, '恢复进度');
  assert.equal(msg.cancelText, '从头打开');
});

test('recoveryMessage: 无文件名 / 无时间也能给出可读文案', () => {
  assert.equal(recoveryMessage(null).title, '检测到上次异常退出');
  const msg = recoveryMessage(makeMarker({ sessionId: 'S1', doc: '' }));
  assert.ok(!msg.message.includes('正在编辑'));
  // 防御分支：startedAt 缺失/非法时不应崩，退化为"未知时间"
  // （makeMarker / parseMarker 会归一化，所以这里直接传裸对象测兜底）
  assert.ok(recoveryMessage({ startedAt: 0, doc: '' }).message.includes('未知时间'));
  assert.ok(recoveryMessage({ startedAt: NaN, doc: 'a.ks' }).message.includes('未知时间'));
});

test('newSessionId: 非空且两次不同', () => {
  const a = newSessionId();
  const b = newSessionId();
  assert.ok(a.length > 3);
  assert.notEqual(a, b);
});
