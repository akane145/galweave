// mt.js 新引擎纯逻辑测试 — node:test + node:assert
// 覆盖: URL 归一化 / 请求体 / 非流式与 SSE 响应解析 / 通用大模型提示词与上下文 /
//       Sakura 提示词版本识别与术语表格式 / 旧配置迁移。
// 运行: node --test tests/mt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeApiUrl, buildGptBody, parseGptResponse, parseSseLine, sseTextToChunks,
  DEFAULT_LLM_SYSTEM, buildLlmSystemPrompt, buildLlmUserPrompt, buildLlmMessages,
  detectSakuraPromptVersion, buildGlossaryText, buildSakuraMessagesV,
  migrateMtSettings,
} from '../src/mt.js';

/* ---------------- URL 归一化 ---------------- */

test('normalizeApiUrl: 补 /v1/chat/completions', () => {
  assert.equal(normalizeApiUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(normalizeApiUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(normalizeApiUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(normalizeApiUrl('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions');
  assert.equal(normalizeApiUrl('https://x.com/chat/completions'), 'https://x.com/chat/completions');
  assert.equal(normalizeApiUrl(''), '');
  assert.equal(normalizeApiUrl('  '), '');
});

/* ---------------- 请求体 ---------------- */

test('buildGptBody: 采样参数/流式/频率惩罚/扩展字段', () => {
  const body = buildGptBody({
    model: 'm', messages: [{ role: 'user', content: 'x' }],
    temperature: 0.1, topP: 0.3, maxTokens: 512, stream: true,
    frequencyPenalty: 0.4, extrabody: { custom: 1 },
  });
  assert.equal(body.model, 'm');
  assert.equal(body.temperature, 0.1);
  assert.equal(body.top_p, 0.3);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.stream, true);
  assert.equal(body.frequency_penalty, 0.4);
  assert.equal(body.custom, 1);
  // useMaxCompletionTokens 分支
  const body2 = buildGptBody({ model: 'm', messages: [], maxTokens: 100, useMaxCompletionTokens: true });
  assert.equal(body2.max_completion_tokens, 100);
  assert.equal(body2.max_tokens, undefined);
  // 缺省字段不出现
  const body3 = buildGptBody({ model: 'm', messages: [] });
  assert.deepEqual(Object.keys(body3).sort(), ['messages', 'model']);
});

/* ---------------- 响应解析 ---------------- */

test('parseGptResponse: OpenAI / llama.cpp / 错误 / 无法识别', () => {
  assert.equal(parseGptResponse({ choices: [{ message: { content: ' 你好 ' } }] }), '你好');
  assert.equal(parseGptResponse({ content: ' こんにちは ' }), 'こんにちは');
  assert.throws(() => parseGptResponse({ error: 'boom' }), /boom/);
  assert.throws(() => parseGptResponse({}), /无法识别/);
});

test('parseSseLine: data 行 / [DONE] / 非 data 行', () => {
  assert.deepEqual(parseSseLine('data: {"choices":[{"delta":{"content":"你"}}]}').json.choices[0].delta.content, '你');
  assert.deepEqual(parseSseLine('data: [DONE]'), { done: true });
  assert.equal(parseSseLine('foo'), null);
  assert.equal(parseSseLine(''), null);
  assert.equal(parseSseLine('data: 不是JSON'), null);
});

test('sseTextToChunks: 完整流拼接与 [DONE] 截断', () => {
  const text = [
    'data: {"choices":[{"delta":{"content":"你"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.deepEqual(sseTextToChunks(text), ['你', '好']);
  // 无 [DONE] 也能收尾
  assert.deepEqual(sseTextToChunks('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'), ['a']);
});

/* ---------------- 通用大模型提示词 ---------------- */

test('buildLlmSystemPrompt: 默认模板替换语言占位符;自定义原样使用', () => {
  const def = buildLlmSystemPrompt('');
  assert.ok(def.includes('Japanese') && def.includes('Chinese'));
  assert.ok(!def.includes('{srclang}') && !def.includes('{tgtlang}'));
  assert.equal(buildLlmSystemPrompt('你是一个翻译'), '你是一个翻译');
});

test('buildLlmUserPrompt: 术语表段 + 原文', () => {
  assert.equal(buildLlmUserPrompt('こんにちは', ''), 'こんにちは');
  const withG = buildLlmUserPrompt('こんにちは', '太郎<|sep|>太郎');
  assert.ok(withG.startsWith('翻译时请将以下术语按要求翻译：\n太郎<|sep|>太郎\n\n'));
  assert.ok(withG.endsWith('こんにちは'));
});

test('buildLlmMessages: system + 多轮历史 + 当前 user', () => {
  const msgs = buildLlmMessages('A', '', 'SYS', [
    { user: '前句', assistant: '前译' },
  ]);
  assert.deepEqual(msgs.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(msgs[1].content, '前句');
  assert.equal(msgs[2].content, '前译');
  assert.equal(msgs[3].content, 'A');
  assert.ok(buildLlmMessages('A', '', 'SYS', []).length === 2);
});

/* ---------------- Sakura 提示词版本 ---------------- */

test('detectSakuraPromptVersion: 按模型名识别', () => {
  assert.equal(detectSakuraPromptVersion(''), 'v1.0');
  assert.equal(detectSakuraPromptVersion('SakuraLLM v0.9'), 'v0.9');
  assert.equal(detectSakuraPromptVersion('Sakura v0.10 1.8B'), 'v0.10');
  assert.equal(detectSakuraPromptVersion('sakura-qwen2.5-v1.0'), 'v1.0');
  assert.equal(detectSakuraPromptVersion('sakura-qwen3-v1.5'), 'v1.5');
  assert.equal(detectSakuraPromptVersion('GalTransl_LLM'), 'GalTransl');
  assert.equal(detectSakuraPromptVersion('hy-mt2-qwen'), 'GalTransl');
});

test('buildGlossaryText: 版本化格式(v1.0 <|sep|> / 其余 -> / v0.9 空)', () => {
  const names = { 大和: '大和', 太郎: '太郎' };
  const terms = { 食べる: '吃' };
  assert.equal(buildGlossaryText(names, terms), '食べる<|sep|>吃'); // 默认 v1.0,恒等项(大和/太郎)被去重
  assert.equal(buildGlossaryText(names, terms, 'v0.10'), '食べる->吃');
  assert.equal(buildGlossaryText(names, terms, 'v1.5'), '食べる->吃');
  assert.equal(buildGlossaryText(names, terms, 'v0.9'), '');
  // 非恒等项参与
  assert.equal(buildGlossaryText({ 大和: '大和丸' }, terms), '大和<|sep|>大和丸\n食べる<|sep|>吃');
});

test('buildSakuraMessagesV: 各版本 system 与 user 结构', () => {
  const v09 = buildSakuraMessagesV('こんにちは', '太郎<|sep|>太郎', 'v0.9');
  assert.ok(v09[0].content.startsWith('你是一个轻小说翻译模型'), 'v0.9/v1.0 同款 system');
  assert.ok(v09[1].content.startsWith('将下面的日文文本翻译成中文：こんにちは'));
  assert.ok(!v09[1].content.includes('术语表'), 'v0.9 不携带术语表');

  const v10 = buildSakuraMessagesV('こんにちは', '太郎<|sep|>太郎', 'v1.0');
  assert.ok(v10[1].content.includes('根据以下术语表'), 'v1.0 携带术语表');

  const v15 = buildSakuraMessagesV('こんにちは', '', 'v1.5');
  assert.ok(v15[0].content.includes('日本二次元'));
  assert.ok(v15[1].content.startsWith('将下面的文本从日文翻译成简体中文：\nこんにちは'));

  const gal = buildSakuraMessagesV('こんにちは', '', 'GalTransl');
  assert.ok(gal[0].content.includes('视觉小说翻译模型'));
});

/* ---------------- 配置迁移 ---------------- */

test('migrateMtSettings: 旧 sakura 结构 → providers 结构', () => {
  const m = migrateMtSettings({ provider: 'sakura', sakura: { host: 'http://127.0.0.1:8080', useGlossary: false } });
  assert.equal(m.provider, 'sakura');
  assert.equal(m.providers.sakura.host, 'http://127.0.0.1:8080');
  assert.equal(m.providers.sakura.useGlossary, false);
  assert.ok(m.providers.llm, 'llm 占位');
});

test('migrateMtSettings: 已是新结构则原样保留', () => {
  const m = migrateMtSettings({ provider: 'llm', providers: { llm: { model: 'x' }, sakura: { host: 'h' } } });
  assert.equal(m.provider, 'llm');
  assert.equal(m.providers.llm.model, 'x');
  assert.equal(m.providers.sakura.host, 'h');
});
