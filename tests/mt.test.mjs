// mt.js 新引擎纯逻辑测试 — node:test + node:assert
// 覆盖: URL 归一化 / 请求体 / 非流式与 SSE 响应解析 / 通用大模型提示词与上下文 /
//       Sakura 提示词版本识别与术语表格式 / 旧配置迁移。
// 运行: node --test tests/mt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeApiUrl, buildGptBody, parseGptResponse, parseSseLine, sseTextToChunks,
  buildLlmSystemPrompt, buildLlmUserPrompt, buildLlmMessages,
  detectSakuraPromptVersion, buildGlossaryText, buildSakuraMessagesV,
  migrateMtSettings, registerProvider, translateTextProtected, translateLinesBatched,
  stripControlChars,
  BATCH_MODES, BATCH_SIZE_MIN, BATCH_SIZE_MAX, BATCH_SIZE_DEFAULT,
  normalizeBatchMode, normalizeBatchSize, buildBatchUserText, parseNumberedLines,
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

test('translateTextProtected: provider 只看到占位符，返回后恢复控制标签', async () => {
  let received = '';
  registerProvider({
    id: 'test-protected', name: 'test', isConfigured: () => true,
    async translate(text){
      received = text;
      return text.replace('原文', '译文');
    },
  });
  const result = await translateTextProtected('test-protected', '原文[r][np]', null);
  assert.equal(received.includes('[r]'), false);
  assert.equal(received.includes('[np]'), false);
  assert.equal(result, '译文[r][np]');
});

test('translateTextProtected: 换行标签被模型吃掉时自动回填，不再整行作废', async () => {
  registerProvider({
    id: 'test-drop-break', name: 'test', isConfigured: () => true,
    async translate(text){ return text.replace(/⟦[^⟧]+⟧/, ''); },
  });
  // 译文重排断行是常态：末尾的换行标签丢失 → 补回末尾
  assert.equal(await translateTextProtected('test-drop-break', '原文[r]', null), '原文[r]');
});

test('translateTextProtected: 命令类标签丢失仍然拒绝，并指明是哪个控制符', async () => {
  registerProvider({
    id: 'test-drop-cmd', name: 'test', isConfigured: () => true,
    async translate(text){ return text.replace(/⟦[^⟧]+⟧/, ''); },
  });
  await assert.rejects(
    () => translateTextProtected('test-drop-cmd', '原文%p100;', null),
    /定位命令 %p100;/
  );
});

/* ---------------- 控制字符清洗（传输边界，双向） ---------------- */

test('stripControlChars: 删换行/制表/零宽/BOM/行分隔符/替换符，不碰引擎标签与占位符', () => {
  const src = 'あ\nい\tう\rえ\u200Bお\uFEFFか\u2028き\uFFFDく';
  assert.equal(stripControlChars(src), 'あいうえおかきく');
  // 引擎标签是普通可见字符，不是控制字符 —— 不能被误删
  const bs = String.fromCharCode(92); // 反斜杠
  assert.equal(stripControlChars('A' + bs + 'nB'), 'A' + bs + 'nB');
  assert.equal(stripControlChars('<r>[n][r][np]%p100;'), '<r>[n][r][np]%p100;');
  // 占位符本体不含控制字符，原样保留
  assert.equal(stripControlChars('⟦GWCTRL:0⟧'), '⟦GWCTRL:0⟧');
  assert.equal(stripControlChars(null), '');
  assert.equal(stripControlChars(undefined), '');
});

test('translateTextProtected: 传输前清洗输入，采纳前清洗输出', async () => {
  let received = '';
  registerProvider({
    id: 'test-sanitize-in', name: 'test', isConfigured: () => true,
    // 模拟模型在译文里夹带换行与零宽字符
    async translate(text){ received = text; return '译\n文' + '\u200B' + text.replace('原文', ''); },
  });
  // 原文里混入真实换行 / 制表 / 零宽字符
  const result = await translateTextProtected('test-sanitize-in', '原\n文\t', null);
  assert.equal(received.includes('\n'), false);
  assert.equal(received.includes('\t'), false);
  assert.equal(received.includes('\u200B'), false);
  assert.equal(result, '译文');   // 输出侧的控制字符同样被清掉
});

test('translateLinesBatched: 逐行清洗输入与输出，批量协议的换行不受影响', async () => {
  let received = '';
  registerProvider({
    id: 'test-sanitize-batch', name: 'test', isConfigured: () => true,
    // 模拟模型在序号 1 的译文里夹带零宽字符
    async translate(text){ received = text; return '1. 甲\u200B乙\n2. 丙\n'; },
  });
  // 第一行原文里混入真实换行 —— 若不逐行清洗，payload 会多出一条「序号行」破坏对齐
  const outs = await translateLinesBatched('test-sanitize-batch', ['甲\n乙', '丙'], null);
  assert.equal(received.includes('甲\n乙'), false);                       // 行内换行已删
  assert.equal(received.split('\n').filter(s => /^\s*\d/.test(s)).length, 2); // 序号行仍是 2 条
  assert.deepEqual(outs, ['甲乙', '丙']);                                 // 输出侧零宽字符已删
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

/* ---------------- 批量策略（Q6） ---------------- */

test('normalizeBatchMode: 只认 perLine/batched，其余回退 perLine（最稳）', () => {
  assert.deepEqual(BATCH_MODES, ['perLine', 'batched']);
  assert.equal(normalizeBatchMode('batched'), 'batched');
  assert.equal(normalizeBatchMode('perLine'), 'perLine');
  assert.equal(normalizeBatchMode('batch'), 'perLine');
  assert.equal(normalizeBatchMode(''), 'perLine');
  assert.equal(normalizeBatchMode(null), 'perLine');
  assert.equal(normalizeBatchMode(undefined), 'perLine');
});

test('normalizeBatchSize: 钳到 2–20，非法回退默认 5', () => {
  assert.equal(BATCH_SIZE_DEFAULT, 5);
  assert.equal(normalizeBatchSize(5), 5);
  assert.equal(normalizeBatchSize('8'), 8);
  assert.equal(normalizeBatchSize(8.6), 9);
  assert.equal(normalizeBatchSize(0), BATCH_SIZE_MIN);
  assert.equal(normalizeBatchSize(-3), BATCH_SIZE_MIN);
  assert.equal(normalizeBatchSize(999), BATCH_SIZE_MAX);
  assert.equal(normalizeBatchSize('abc'), BATCH_SIZE_DEFAULT);
  assert.equal(normalizeBatchSize(null), BATCH_SIZE_DEFAULT);
});

test('buildBatchUserText: 写明行数与格式要求，正文带序号', () => {
  const t = buildBatchUserText(['おはよう', 'こんばんは']);
  assert.ok(t.includes('恰好 2 行'));
  assert.ok(t.includes('1. おはよう'));
  assert.ok(t.includes('2. こんばんは'));
  assert.ok(t.includes('不要合并行'));
  // 空输入不抛错
  assert.ok(buildBatchUserText([]).includes('恰好 0 行'));
  assert.ok(buildBatchUserText(null).includes('恰好 0 行'));
});

test('parseNumberedLines: 按序号对齐，容忍多种分隔与项目符号', () => {
  assert.deepEqual(parseNumberedLines('1. 早上好\n2. 晚上好', 2), ['早上好', '晚上好']);
  assert.deepEqual(parseNumberedLines('1、甲\n2、乙', 2), ['甲', '乙']);
  assert.deepEqual(parseNumberedLines('1：甲\n2：乙', 2), ['甲', '乙']);
  assert.deepEqual(parseNumberedLines('- 1. 甲\n- 2. 乙', 2), ['甲', '乙']);
  // 乱序也按序号归位
  assert.deepEqual(parseNumberedLines('2. 乙\n1. 甲', 2), ['甲', '乙']);
  // 译文里带句点/冒号不影响（只认行首序号）
  assert.deepEqual(parseNumberedLines('1. 早。好：呀\n2. 乙', 2), ['早。好：呀', '乙']);
  // 空译文（源行为空）是合法结果
  assert.deepEqual(parseNumberedLines('1. \n2. 乙', 2), ['', '乙']);
});

test('parseNumberedLines: 缺行/重复/无序号一律 null —— 宁可回退也不猜对齐', () => {
  assert.equal(parseNumberedLines('1. 甲', 2), null);              // 少一行
  assert.equal(parseNumberedLines('1. 甲\n1. 乙', 2), null);        // 序号重复
  assert.equal(parseNumberedLines('甲\n乙', 2), null);              // 完全没有序号
  assert.equal(parseNumberedLines('', 2), null);
  assert.equal(parseNumberedLines(null, 2), null);
  assert.equal(parseNumberedLines('1. 甲', 0), null);               // n 非法
  assert.equal(parseNumberedLines('1. 甲', NaN), null);
});

test('parseNumberedLines: 多出来的行被忽略（不破坏对齐），不影响正确结果', () => {
  // 只要 1..n 齐全就算成功：多出的行没有序号归属，忽略它比整批失败更划算
  assert.deepEqual(parseNumberedLines('1. 甲\n2. 乙\n3. 丙', 2), ['甲', '乙']);
  assert.deepEqual(parseNumberedLines('以下是翻译：\n1. 甲\n2. 乙\n（完）', 2), ['甲', '乙']);
});
