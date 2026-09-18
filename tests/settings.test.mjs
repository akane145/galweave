// settings.js 存储层测试 — node:test + node:assert
// 覆盖: 配额超限判定 / 写失败不抛异常 / 背景图本体不进 settings blob（旧版会顶爆 localStorage）
// 运行: node --test tests/settings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  saveSettings, loadSettings, clearSettingsCache,
  saveBackground, loadBackground, clearBackground,
  isQuotaError, QUOTA_HINT,
} from '../src/settings.js';

/* ---------------- 环境替身 ---------------- */

/**
 * 浏览器环境替身: isTauri() 读 window.__TAURI_INTERNALS__，置空即走 localStorage 分支。
 * @param {{failWith?: object}} [opt] failWith 给定时，setItem 抛该异常（模拟配额超限）
 */
function withBrowserEnv(fn, opt = {}){
  const store = new Map();
  const saved = { ls: globalThis.localStorage, win: globalThis.window };
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (opt.failWith) throw opt.failWith;
      store.set(k, String(v));
    },
    removeItem: k => { store.delete(k); },
  };
  clearSettingsCache();
  return Promise.resolve(fn(store)).finally(() => {
    globalThis.localStorage = saved.ls;
    globalThis.window = saved.win;
    clearSettingsCache();
  });
}

/** 读出 localStorage 里那条 settings blob（测试断言"什么被写进去了"） */
function storedSettings(store){
  const raw = store.get('galtrans_settings_v1');
  return raw ? JSON.parse(raw) : null;
}

const BIG_DATA_URL = 'data:image/png;base64,' + 'A'.repeat(5000);

/* ---------------- 配额超限判定 ---------------- */

test('isQuotaError: 识别各浏览器的配额超限写法', () => {
  const e1 = new Error('quota'); e1.name = 'QuotaExceededError';
  const e2 = new Error('quota'); e2.name = 'NS_ERROR_DOM_QUOTA_REACHED';
  const e3 = new Error('quota'); e3.code = 22;                    // 旧 WebKit
  const e4 = new Error('quota'); e4.code = 1014;                  // 旧 Firefox
  assert.equal(isQuotaError(e1), true);
  assert.equal(isQuotaError(e2), true);
  assert.equal(isQuotaError(e3), true);
  assert.equal(isQuotaError(e4), true);
  // 非配额错误不能被误判，否则会把真实故障说成"存储满了"
  assert.equal(isQuotaError(new Error('boom')), false);
  assert.equal(isQuotaError(null), false);
  assert.equal(isQuotaError(undefined), false);
});

/* ---------------- 写失败不抛异常 ---------------- */

test('saveSettings: 正常写入返回 ok，且内容落到 localStorage', async () => {
  await withBrowserEnv(async (store) => {
    const r = await saveSettings({ ui: { mode: 'dark' } });
    assert.equal(r.ok, true);
    assert.equal(r.error, undefined);
    assert.equal(storedSettings(store).ui.mode, 'dark');
  });
});

test('saveSettings: 配额超限时返回失败状态而不是抛异常（本次修复的核心）', async () => {
  const quota = new Error('quota'); quota.name = 'QuotaExceededError';
  await withBrowserEnv(async () => {
    // 不 reject/sync throw —— 调用点有十余处，抛出去会打断用户当前操作
    const r = await saveSettings({ ui: { mode: 'dark' } });
    assert.equal(r.ok, false);
    assert.ok(r.error, '失败时必须带回错误对象供调用方提示');
    assert.equal(r.error.message, QUOTA_HINT, '配额错误要给可操作的中文提示');
  }, { failWith: quota });
});

test('saveSettings: 非配额错误也不抛，原样带回错误', async () => {
  const boom = new Error('磁盘只读');
  await withBrowserEnv(async () => {
    const r = await saveSettings({ ui: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error.message, '磁盘只读', '非配额错误不应被替换成配额提示');
  }, { failWith: boom });
});

/* ---------------- 背景图本体不进 settings ---------------- */

test('saveBackground: 图片本体不写进 settings blob，只留轻量显示参数', async () => {
  await withBrowserEnv(async (store) => {
    const r = await saveBackground(BIG_DATA_URL, 0.5, 'contain');
    assert.equal(r.ok, true);
    const blob = storedSettings(store);
    // 旧实现把整条 data URL 塞进 settings.ui.background —— 数 MB 的图会顶爆 5MB 配额，
    // 连带把主题/字体等同一 blob 里的设置一起拖没。图片必须走 IndexedDB。
    assert.equal(blob.ui.background, undefined, '图片本体不得留在 settings 里');
    assert.equal(blob.ui.backgroundOpacity, 0.5);
    assert.equal(blob.ui.backgroundFit, 'contain');
    assert.equal(blob.ui.hasBackground, true);
    // 整个 settings 序列化后必须很小，与图片体积无关
    assert.ok(JSON.stringify(blob).length < 500,
      'settings blob 体积不应随图片增大（实际 ' + JSON.stringify(blob).length + ' 字节）');
  });
});

test('saveBackground: 清空背景时移除标记与参数', async () => {
  await withBrowserEnv(async (store) => {
    await saveBackground(BIG_DATA_URL, 0.5, 'cover');
    await saveBackground(null, 0.82, 'cover');
    const blob = storedSettings(store);
    assert.equal(blob.ui.hasBackground, false);
    assert.equal(blob.ui.background, undefined);
  });
});

test('loadBackground: 能读取旧版存在 settings 里的图并迁移出 settings（不丢用户背景）', async () => {
  await withBrowserEnv(async (store) => {
    // 预置旧版数据形态：整条 data URL 就在 settings.ui.background
    store.set('galtrans_settings_v1', JSON.stringify({
      ui: { background: BIG_DATA_URL, backgroundOpacity: 0.7, backgroundFit: 'tile' },
    }));
    clearSettingsCache();

    const bg = await loadBackground();
    assert.equal(bg.dataUrl, BIG_DATA_URL, '旧版背景不能丢');
    assert.equal(bg.opacity, 0.7);
    assert.equal(bg.fit, 'tile');

    // 迁移后 settings 里不应再留那份大数据（IndexedDB 写入在 Node 下静默失败，
    // 但不影响"settings 已被清干净"这一断言）
    const blob = storedSettings(store);
    assert.equal(blob.ui.background, undefined, '迁移后必须从 settings 里抹掉,否则配额问题依旧');
  });
});

test('loadBackground: 无背景时返回默认参数且不炸', async () => {
  await withBrowserEnv(async () => {
    const bg = await loadBackground();
    assert.equal(bg.dataUrl, null);
    assert.equal(bg.opacity, 0.82);
    assert.equal(bg.fit, 'cover');
  });
});

test('clearBackground: 清掉标记与透明度,便于重设时沿用默认', async () => {
  await withBrowserEnv(async (store) => {
    await saveBackground(BIG_DATA_URL, 0.3, 'auto');
    await clearBackground();
    const blob = storedSettings(store);
    assert.equal(blob.ui.hasBackground, false);
    assert.equal(blob.ui.background, undefined);
    assert.equal(blob.ui.backgroundOpacity, 0.82);
    assert.equal(blob.ui.backgroundFit, 'auto', '用户选的 fit 值应保留,重设时沿用');
  });
});

/* ---------------- 缓存行为 ---------------- */

test('loadSettings: 命中缓存时不再读 localStorage', async () => {
  await withBrowserEnv(async (store) => {
    await saveSettings({ ui: { mode: 'light' } });
    // 绕过 saveSettings 直接改底层 —— 命中缓存则读不到这个改动
    store.set('galtrans_settings_v1', JSON.stringify({ ui: { mode: 'tampered' } }));
    const s = await loadSettings();
    assert.equal(s.ui.mode, 'light');
    clearSettingsCache();
    const fresh = await loadSettings();
    assert.equal(fresh.ui.mode, 'tampered', '清缓存后应重新读取');
  });
});
