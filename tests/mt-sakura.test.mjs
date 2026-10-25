import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setProviderConfig, translateText, translateTextProtected } from '../src/mt.js';

async function withSakuraEnv(fetchImpl, fn, config = {}){
  const store = new Map();
  const savedLS = globalThis.localStorage;
  const savedFetch = globalThis.fetch;
  const savedWindow = globalThis.window;
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  globalThis.fetch = fetchImpl;
  try {
    await setProviderConfig('sakura', {
      host: 'http://127.0.0.1:8080', model: 'sakura-qwen2.5-v1.0',
      promptVersion: 'v1.0', useGlossary: true, streaming: false, timeoutMs: 5000,
      ...config,
    });
    return await fn();
  } finally {
    globalThis.localStorage = savedLS;
    globalThis.fetch = savedFetch;
    globalThis.window = savedWindow;
  }
}

function jsonResponse(data, status = 200){
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => '',
  };
}

function content(text){
  return { choices: [{ message: { content: text } }] };
}

test('Sakura provider 不发送语境，正常译文保留普通提示词相关字样', async () => {
  let request;
  await withSakuraEnv(async (_url, options) => {
    request = JSON.parse(options.body);
    return jsonResponse(content('吃完早饭后，白河发来了ＣＯＭＵ。未翻译的术语表项如下。'));
  }, async () => {
    const result = await translateText('sakura', '朝食が終わったところで、白河からＣＯＭＵが来た。', {
      names: { ひより: '日和' }, terms: {},
    }, null, 'CTX_NEIGHBOR_MUST_NOT_BE_SENT');
    assert.equal(result, '吃完早饭后，白河发来了ＣＯＭＵ。未翻译的术语表项如下。');
  });
  assert.equal(request.messages[1].content,
    '根据以下术语表（可以为空）：\nひより<|sep|>日和\n将下面的日文文本根据对应关系和备注翻译成中文：朝食が終わったところで、白河からＣＯＭＵが来た。');
  assert.ok(!JSON.stringify(request.messages).includes('CTX_NEIGHBOR_MUST_NOT_BE_SENT'));
});

test('Sakura 拒绝复述完整术语表及翻译指令模板', async () => {
  await withSakuraEnv(async () => jsonResponse(content(
    '吃完早饭后，白河发来了ＣＯＭＵ。· 「ひより」说不定我能给你一些建议呢 （未翻译）· 她还是那么有干劲啊。 （未翻译）根据以下术语表（可以为空）：ひより<|sep|>日和将下面的日文文本根据对应关系和备注翻译成中文：'
  )), async () => {
    await assert.rejects(
      () => translateTextProtected('sakura', '朝食が終わったところで、白河からＣＯＭＵが来た。', {
        names: { ひより: '日和' }, terms: {},
      }),
      /Sakura.*提示词指令.*拒绝/
    );
  });
});

test('占位符别名：Sakura 实际调用链恢复模型改写的换行标记', async () => {
  await withSakuraEnv(async () => jsonResponse(content('上半【GWCTRL:0】下半')), async () => {
    const control = String.fromCharCode(92) + 'n';
    assert.equal(await translateTextProtected('sakura', '前半' + control + '后半', null), '上半' + control + '下半');
  });
});

test('Sakura 流式结果聚合后检查跨分片的指令标记', async () => {
  const encoder = new TextEncoder();
  const chunks = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '根据以下术语表' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '（可以为空）：术语' } }] }) + '\n\n',
    'data: [DONE]\n\n',
  ];
  await withSakuraEnv(async () => ({
    ok: true, status: 200,
    json: async () => ({}),
    text: async () => '',
    body: { getReader: () => ({
      read: async () => chunks.length
        ? { done: false, value: encoder.encode(chunks.shift()) }
        : { done: true },
    }) },
  }), async () => {
    await assert.rejects(
      () => translateText('sakura', '本文', null, () => {}, ''),
      /Sakura.*提示词指令.*拒绝/
    );
  }, { streaming: true });
});

test('Sakura 404 回退沿用已选 v1.5 的 messages 生成 ChatML', async () => {
  const requests = [];
  await withSakuraEnv(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/v1/chat/completions')) return jsonResponse({}, 404);
    return jsonResponse({ content: '译文' });
  }, async () => {
    await setProviderConfig('sakura', {
      host: 'http://127.0.0.1:8080', model: 'sakura-qwen3-v1.5',
      promptVersion: 'v1.5', useGlossary: true, timeoutMs: 5000,
    });
    const result = await translateText('sakura', '本文', { names: { ひより: '日和' }, terms: {} }, null, 'CTX_NEIGHBOR_MUST_NOT_BE_SENT');
    assert.equal(result, '译文');
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0].body.messages[0].content, /日本二次元/);
  assert.ok(!JSON.stringify(requests[0].body.messages).includes('CTX_NEIGHBOR_MUST_NOT_BE_SENT'));
  assert.match(requests[1].body.prompt, /日本二次元/);
  assert.match(requests[1].body.prompt, /参考以下术语表/);
  assert.ok(!requests[1].body.prompt.includes('CTX'));
});

test('Sakura 译文仍通过原有受保护 token 校验', async () => {
  let userMessage = '';
  await withSakuraEnv(async (_url, options) => {
    userMessage = JSON.parse(options.body).messages[1].content;
    const token = userMessage.match(/⟦GWCTRL:\d+⟧/)?.[0];
    return jsonResponse(content('翻译' + (token || '')));
  }, async () => {
    const result = await translateTextProtected('sakura', '朝食[np]終わった', null, 'CTX_NEIGHBOR_MUST_NOT_BE_SENT');
    assert.equal(result, '翻译[np]');
  });
  assert.ok(!userMessage.includes('CTX_NEIGHBOR_MUST_NOT_BE_SENT'));
});

test('Sakura 不按普通词语拒绝，也允许正文自带的指令标记', async () => {
  const answer = '只有（未翻译）普通术语表词汇和ＣＯＭＵ。';
  await withSakuraEnv(async () => jsonResponse(content(answer)), async () => {
    assert.equal(await translateText('sakura', '本文'), answer);
  });
  const marker = '将下面的日文文本翻译成中文：';
  await withSakuraEnv(async () => jsonResponse(content(marker)), async () => {
    assert.equal(await translateText('sakura', '原文含有：' + marker), marker);
  });
});
