// mt.js — 机器翻译 Provider 框架(双引擎架构)
//  通用大模型接口(llm): OpenAI 兼容,可自定义地址/Key/模型/提示词/采样参数,支持流式与多轮上下文。
//  Sakura 本地(sakura): 专用离线翻译模型,按模型名自动识别提示词版本(v0.9/v0.10/v1.0/v1.5/GalTransl)。
//  llama.cpp 兼容: 两引擎都直连 llama.cpp 的 OpenAI 兼容端点 /v1/chat/completions(默认 127.0.0.1:8080);
//  Sakura 保留 /completion 回退(旧 llama.cpp server)。
// Provider 接口: { id, name, isConfigured(), translate(text, glossary, onChunk?), translateBatch(texts, glossary?) }

import { loadSettings, saveSettings } from './settings.js';

export async function getMTSettings(){
  const s = await loadSettings();
  return s.mt || {};
}

export async function saveMTSettings(mt){
  const s = await loadSettings();
  s.mt = mt;
  await saveSettings(s);
}

/* ---------------- Provider 注册表 ---------------- */

const providers = [];

export function registerProvider(p){
  providers.push(p);
}
export function getProviders(){ return providers.slice(); }

export function getProvider(id){
  return providers.find(p => p.id === id) || null;
}

/* ---------------- 空 Provider(默认,未配置) ---------------- */

const NotConfiguredProvider = {
  id: 'none',
  name: '未配置',
  isConfigured(){ return false; },
  async translate(){
    throw new Error('尚未配置机器翻译服务。请在「⚙ 机翻配置」中配置。');
  },
  async translateBatch(){
    throw new Error('尚未配置机器翻译服务。请在「⚙ 机翻配置」中配置。');
  }
};

registerProvider(NotConfiguredProvider);

/* ============================================================
   共享 LLM 传输层(OpenAI 兼容 chat/completions + llama.cpp 兼容)
   ============================================================ */

/** 接口地址归一化 → {base}/v1/chat/completions(已含版本或 chat/completions 则原样) */
export function normalizeApiUrl(base){
  let s = String(base || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/\/chat\/completions$/.test(s)) return s;
  if (/\/v\d+$/.test(s)) return s + '/chat/completions';
  return s + '/v1/chat/completions';
}

/** 构造请求体(OpenAI chat/completions 参数格式) */
export function buildGptBody(opt){
  const o = opt || {};
  const data = { model: o.model, messages: o.messages || [] };
  if (o.temperature !== undefined && o.temperature !== null) data.temperature = o.temperature;
  if (o.topP !== undefined && o.topP !== null) data.top_p = o.topP;
  const maxKey = o.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens';
  if (o.maxTokens) data[maxKey] = o.maxTokens;
  if (o.stream) data.stream = true;
  if (o.frequencyPenalty) data.frequency_penalty = o.frequencyPenalty;
  if (o.repetitionPenalty) data.repetition_penalty = o.repetitionPenalty;
  if (o.extrabody && typeof o.extrabody === 'object') Object.assign(data, o.extrabody);
  return data;
}

/** 解析非流式响应: OpenAI choices[0].message.content 或 llama.cpp data.content */
export function parseGptResponse(data){
  if (data && data.error) throw new Error('翻译服务返回错误: ' + data.error);
  if (data && data.choices && data.choices[0] && data.choices[0].message && typeof data.choices[0].message.content === 'string'){
    return data.choices[0].message.content.trim();
  }
  if (data && typeof data.content === 'string'){
    return data.content.trim();
  }
  throw new Error('翻译服务返回了无法识别的响应。');
}

/* ---- SSE 流式解析 ---- */

/**
 * 解析一行 SSE 事件(形如 `data: {...}` 或 `data: [DONE]`)。
 * 返回 { json } / { done } / null(非 data 行或解析失败)。
 */
export function parseSseLine(line){
  const text = String(line || '').trim();
  if (!text.startsWith('data:')) return null;
  const payload = text.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return { done: true };
  try { return { json: JSON.parse(payload) }; } catch (e) { return null; }
}

/** 把一段 SSE 文本解析为增量内容块数组(遇 [DONE] 停止) */
export function sseTextToChunks(text){
  const out = [];
  for (const event of String(text || '').split(/\r?\n\r?\n/)){
    for (const line of event.split(/\r?\n/)){
      const r = parseSseLine(line);
      if (!r) continue;
      if (r.done) return out;
      const c = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].delta && r.json.choices[0].delta.content;
      if (typeof c === 'string' && c) out.push(c);
    }
  }
  return out;
}

/** 读取流式 Response,逐块回调 onChunk,返回拼接后的完整文本 */
export async function parseSseStream(res, onChunk){
  let full = '';
  const emit = (text) => {
    const chunks = sseTextToChunks(text);
    for (const c of chunks){
      full += c;
      if (onChunk) onChunk(c);
    }
  };
  if (res.body && res.body.getReader){
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;){
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || '';
      emit(parts.join('\n\n') + '\n\n');
    }
    emit(buf);
  } else {
    emit(await res.text());
  }
  return full;
}

/** 请求失败(携带 httpStatus 供 404 回退判断) */
class HttpError extends Error {
  constructor(msg, status){
    super(msg);
    this.httpStatus = status;
  }
}

/** 非流式/流式 POST 到 chat/completions */
async function postChat(url, body, headers, opt){
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opt.timeoutMs || 90000);
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } finally { clearTimeout(timer); }
  } catch (e){
    throw new Error('无法连接翻译服务(' + (opt.base || '') + ')。请确认服务已启动并检查地址。');
  }
  if (!res.ok){
    if (res.status === 404 && opt.legacyCompletion) throw new HttpError('端点不存在', 404);
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) {}
    throw new Error('翻译请求失败 (HTTP ' + res.status + ')' + (detail ? ': ' + detail : ''));
  }
  if (opt.streaming && opt.onChunk){
    return await parseSseStream(res, opt.onChunk);
  }
  return parseGptResponse(await res.json());
}

/** 回退到 llama.cpp /completion 端点(旧式,不识别 chat/completions 的 server) */
async function postLegacyCompletion(opt){
  const base = String(opt.base || '').replace(/\/+$/, '');
  const p = opt.params || {};
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opt.timeoutMs || 90000);
    try {
      res = await fetch(base + '/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: opt.legacyPrompt,
          temperature: p.temperature !== undefined ? p.temperature : 0.1,
          top_p: p.topP !== undefined ? p.topP : 0.3,
          n_predict: p.maxTokens || 512,
          repeat_penalty: 1.0,
          stop: ['<|im_end|>']
        }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
  } catch (e){
    throw new Error('无法连接翻译服务(' + base + ')。请确认服务已启动并检查地址。');
  }
  if (!res.ok){
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) {}
    throw new Error('翻译请求失败 (HTTP ' + res.status + ')' + (detail ? ': ' + detail : ''));
  }
  return parseGptResponse(await res.json());
}

/**
 * OpenAI 兼容 chat/completions 调用(两引擎共用)。
 * opt: { base, apiKey?, model, messages, params:{temperature,topP,maxTokens,frequencyPenalty?},
 *        streaming?, onChunk?, timeoutMs?, legacyCompletion?, legacyPrompt? }
 */
export async function chatCompletions(opt){
  const url = normalizeApiUrl(opt.base);
  const headers = { 'Content-Type': 'application/json' };
  if (opt.apiKey) headers.Authorization = 'Bearer ' + opt.apiKey;
  const body = buildGptBody({
    model: opt.model,
    messages: opt.messages,
    stream: !!opt.streaming,
    ...(opt.params || {}),
  });
  try {
    return await postChat(url, body, headers, opt);
  } catch (e){
    if (opt.legacyCompletion && e instanceof HttpError && e.httpStatus === 404){
      return postLegacyCompletion(opt);
    }
    throw e;
  }
}

/* ============================================================
   通用大模型 Provider(OpenAI 兼容)
   ============================================================ */

export const DEFAULT_LLM_SYSTEM = 'You are a translator. Please help me translate the following {srclang} text into {tgtlang}. You should only tell me the translation result without any additional explanations.';

const LLM_DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  model: '',
  systemPrompt: '',           // 空 = 使用默认模板
  temperature: 0.3,
  topP: 0.3,
  maxTokens: 1024,
  frequencyPenalty: 0,
  streaming: false,           // SSE 流式输出(翻译当前行时逐字显示)
  contextTurns: 0,            // 多轮上下文: 附最近 N 轮原文/译文历史(0=关)
  useGlossary: true,
};

/** 系统提示词: 自定义原样使用;否则默认模板并替换语言占位符 */
export function buildLlmSystemPrompt(custom){
  const c = String(custom || '').trim();
  if (c) return c;
  return DEFAULT_LLM_SYSTEM
    .replace('{srclang}', 'Japanese')
    .replace('{tgtlang}', 'Chinese');
}

/** 用户消息正文: 术语表段 + 原文 */
export function buildLlmUserPrompt(text, glossaryText){
  const gloss = glossaryText ? '翻译时请将以下术语按要求翻译：\n' + glossaryText + '\n\n' : '';
  return gloss + String(text);
}

/** 构造 messages: system + 多轮历史 + 当前 user */
export function buildLlmMessages(text, glossaryText, systemPrompt, history){
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const t of history || []){
    messages.push({ role: 'user', content: t.user });
    messages.push({ role: 'assistant', content: t.assistant });
  }
  messages.push({ role: 'user', content: buildLlmUserPrompt(text, glossaryText) });
  return messages;
}

/* ============================================================
   Sakura 本地 Provider(专用离线翻译模型,提示词版本化)
   ============================================================ */

export const SAKURA_SYSTEM = '你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。';
export const SAKURA_USER_PLAIN = '将下面的日文文本翻译成中文：';
export const SAKURA_USER_GLOSS = '根据以下术语表（可以为空）：\n{glossary}\n将下面的日文文本根据对应关系和备注翻译成中文：';
const IM_START = '<|im_start|>';
const IM_END = '<|im_end|>';

export const SAKURA_PROMPT_VERSIONS = ['auto', 'v0.9', 'v0.10', 'v1.0', 'v1.5', 'GalTransl'];

// 各版本 system 提示(SakuraLLM 官方模板)
const SAKURA_SYSTEM_V10 = '你是一个轻小说翻译模型，可以流畅通顺地使用给定的术语表以日本轻小说的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，注意不要混淆使役态和被动态的主语和宾语，不要擅自添加原文中没有的代词，也不要擅自增加或减少换行。';
const SAKURA_SYSTEM_V15 = '你是一个日本二次元领域的日语翻译模型，可以流畅通顺地以日本轻小说/漫画/Galgame的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。';
const SAKURA_SYSTEM_GALTRANSL = '你是一个视觉小说翻译模型，可以通顺地使用给定的术语表以指定的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，注意不要混淆使役态和被动态的主语和宾语，不要擅自添加原文中没有的特殊符号，也不要擅自增加或减少换行。';

const SAKURA_DEFAULTS = {
  host: 'http://127.0.0.1:8080',  // llama.cpp / Sakura_Launcher_GUI 默认端口
  model: '',                      // 模型名(用于提示词版本自动识别;留空用 'sakura')
  promptVersion: 'auto',          // auto/v0.9/v0.10/v1.0/v1.5/GalTransl
  useGlossary: true,
  streaming: false,
  temperature: 0.1,
  topP: 0.3,
  maxTokens: 512,
};

/** 按模型名自动识别提示词版本;未知回退 v1.0 */
export function detectSakuraPromptVersion(model){
  const m = String(model || '').toLowerCase();
  if (m.includes('galtransl') || m.includes('hy-mt2')) return 'GalTransl';
  if (m.includes('v1.5') || m.includes('qwen3-v1.5')) return 'v1.5';
  if (m.includes('v1.0') || m.includes('qwen2.5-v1.0')) return 'v1.0';
  if (m.includes('v0.10')) return 'v0.10';
  if (m.includes('v0.9')) return 'v0.9';
  return 'v1.0';
}

function resolveSakuraVersion(promptVersion, model){
  if (!promptVersion || promptVersion === 'auto') return detectSakuraPromptVersion(model);
  return SAKURA_PROMPT_VERSIONS.includes(promptVersion) ? promptVersion : 'v1.0';
}

/** 术语表 → Sakura 术语文本(按版本格式;v0.9 无术语表支持) */
export function buildGlossaryText(names, terms, version){
  const v = version || 'v1.0';
  if (v === 'v0.9') return '';
  const sep = (v === 'v1.0') ? '<|sep|>' : '->';
  const lines = [];
  const seen = new Set();
  const push = (src, dst) => {
    if (!src || !dst || dst === src || seen.has(src)) return;
    seen.add(src);
    lines.push(src + sep + dst);
  };
  for (const k of Object.keys(names || {})) push(k, names[k]);
  for (const k of Object.keys(terms || {})) push(k, terms[k]);
  return lines.join('\n');
}

function sakuraSystemForVersion(version){
  switch (version){
    case 'v0.10': return SAKURA_SYSTEM_V10;
    case 'v1.5': return SAKURA_SYSTEM_V15;
    case 'GalTransl': return SAKURA_SYSTEM_GALTRANSL;
    default: return SAKURA_SYSTEM;
  }
}

/** user 消息正文(按版本) */
export function buildSakuraUserTextV(text, glossaryText, version){
  const v = version || 'v1.0';
  if (v === 'v0.9'){
    return SAKURA_USER_PLAIN + text;
  }
  if (v === 'v0.10'){
    return '根据以下术语表（可以为空）：\n' + (glossaryText || '') + '\n\n将下面的日文文本根据上述术语表的对应关系和备注翻译成中文：' + text;
  }
  if (v === 'v1.5' || v === 'GalTransl'){
    const g = glossaryText ? '参考以下术语表（可为空，格式为src->dst #备注）\n' + glossaryText + '\n\n根据以上术语表的对应关系和备注，' : '';
    return g + '将下面的文本从日文翻译成简体中文：\n' + text;
  }
  // v1.0
  return buildSakuraUserText(text, glossaryText);
}

/** OpenAI 兼容消息数组(按版本) */
export function buildSakuraMessagesV(text, glossaryText, version){
  const v = version || 'v1.0';
  return [
    { role: 'system', content: sakuraSystemForVersion(v) },
    { role: 'user', content: buildSakuraUserTextV(text, glossaryText, v) }
  ];
}

// ---- 以下保持 v5.0 签名与行为(v1.0 默认),供既有调用方与测试使用 ----

// 构造 user 消息正文(带/不带术语表,v1.0)
export function buildSakuraUserText(text, glossaryText){
  const plain = SAKURA_USER_PLAIN + text;
  if (!glossaryText) return plain;
  return SAKURA_USER_GLOSS.replace('{glossary}', glossaryText) + text;
}

// OpenAI 兼容消息数组(用于 /v1/chat/completions,v1.0)
export function buildSakuraMessages(text, glossaryText){
  return [
    { role: 'system', content: SAKURA_SYSTEM },
    { role: 'user', content: buildSakuraUserText(text, glossaryText) }
  ];
}

// 完整 ChatML prompt(用于 llama.cpp /completion)
export function buildSakuraPrompt(text, glossaryText){
  const user = buildSakuraUserText(text, glossaryText);
  return IM_START + 'system\n' + SAKURA_SYSTEM + IM_END + '\n' +
         IM_START + 'user\n' + user + IM_END + '\n' +
         IM_START + 'assistant\n';
}

// 解析两种响应的 content(Sakura 版错误文案)
export function parseSakuraResponse(data){
  if (data && data.error) throw new Error('Sakura 返回错误: ' + data.error);
  if (data && data.choices && data.choices[0] && data.choices[0].message && typeof data.choices[0].message.content === 'string'){
    return data.choices[0].message.content.trim();
  }
  if (data && typeof data.content === 'string'){
    return data.content.trim();
  }
  throw new Error('Sakura 返回了无法识别的响应。');
}

/* ---- 端口探测 ---- */

export const SAKURA_COMMON_PORTS = [8080, 5000, 8000, 8888, 11434, 18080];

/** 探测本机常见端口,返回有 HTTP 服务响应的端口列表 */
export async function probeSakuraPorts(ports){
  const list = ports || SAKURA_COMMON_PORTS;
  const results = [];
  for (const port of list){
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1200);
      const r = await fetch('http://127.0.0.1:' + port + '/', { signal: ctrl.signal });
      clearTimeout(t);
      if (r.status >= 200 && r.status < 600) results.push(port);
    } catch (e){
      // 连接拒绝/超时 → 该端口无服务
    }
  }
  return results;
}

/* ---- 配置(providers 结构 + 旧结构迁移) ---- */

const configs = { llm: null, sakura: null };

function normalizeProviderConfig(id, cfg){
  const d = id === 'llm' ? LLM_DEFAULTS : SAKURA_DEFAULTS;
  const c = { ...d, ...(cfg || {}) };
  if (id === 'llm'){
    c.baseUrl = String(c.baseUrl || '').trim();
    c.model = String(c.model || '').trim();
    c.apiKey = String(c.apiKey || '');
    c.temperature = Number.isFinite(Number(c.temperature)) ? Number(c.temperature) : d.temperature;
    c.topP = Number.isFinite(Number(c.topP)) ? Number(c.topP) : d.topP;
    c.maxTokens = Number.isFinite(Number(c.maxTokens)) && c.maxTokens > 0 ? Number(c.maxTokens) : d.maxTokens;
    c.frequencyPenalty = Number.isFinite(Number(c.frequencyPenalty)) ? Number(c.frequencyPenalty) : d.frequencyPenalty;
    c.contextTurns = Number.isFinite(Number(c.contextTurns)) ? Math.max(0, Math.min(20, Number(c.contextTurns))) : 0;
    c.streaming = !!c.streaming;
    c.useGlossary = c.useGlossary !== false;
  } else {
    c.host = String(c.host || '').trim() || d.host;
    c.model = String(c.model || '').trim();
    c.promptVersion = SAKURA_PROMPT_VERSIONS.includes(c.promptVersion) ? c.promptVersion : 'auto';
    c.useGlossary = c.useGlossary !== false;
    c.streaming = !!c.streaming;
    c.temperature = Number.isFinite(Number(c.temperature)) ? Number(c.temperature) : d.temperature;
    c.topP = Number.isFinite(Number(c.topP)) ? Number(c.topP) : d.topP;
    c.maxTokens = Number.isFinite(Number(c.maxTokens)) && c.maxTokens > 0 ? Number(c.maxTokens) : d.maxTokens;
  }
  return c;
}

/**
 * 旧设置结构 → 新结构(纯函数,可单测)。
 * 旧: { provider?, sakura?: {host,useGlossary} } → 新: { provider, providers:{llm,sakura} }
 */
export function migrateMtSettings(mt){
  const src = (mt && typeof mt === 'object') ? mt : {};
  const providers = { ...(src.providers || {}) };
  if (!providers.sakura && src.sakura){
    providers.sakura = {
      host: src.sakura.host,
      useGlossary: src.sakura.useGlossary !== false,
    };
  }
  if (!providers.llm) providers.llm = {};
  return {
    provider: (src.provider === 'llm' || src.provider === 'sakura') ? src.provider : 'sakura',
    providers,
  };
}

/** 加载所有 Provider 配置(含旧结构一次性迁移),刷新内存缓存。initMT 时调用。 */
export async function ensureProviderConfigs(){
  const mt = await getMTSettings();
  if (!mt.providers){
    const migrated = migrateMtSettings(mt);
    mt.provider = migrated.provider;
    mt.providers = migrated.providers;
    await saveMTSettings(mt);
  }
  configs.sakura = normalizeProviderConfig('sakura', mt.providers.sakura);
  configs.llm = normalizeProviderConfig('llm', mt.providers.llm);
  llmContext = [];
  return configs;
}

/** 读取某 Provider 配置(副本) */
export async function getProviderConfig(id){
  if (!configs[id]) await ensureProviderConfigs();
  return { ...configs[id] };
}

/** 保存某 Provider 配置(内存 + settings.mt.providers[id]) */
export async function setProviderConfig(id, cfg){
  await ensureProviderConfigs();
  configs[id] = normalizeProviderConfig(id, cfg);
  if (id === 'llm') llmContext = [];
  const mt = await getMTSettings();
  mt.providers[id] = configs[id];
  await saveMTSettings(mt);
  return { ...configs[id] };
}

// 兼容旧调用方
export async function getSakuraConfig(){ return getProviderConfig('sakura'); }
export async function setSakuraConfig(cfg){ return setProviderConfig('sakura', cfg); }

function currentSakuraConf(){
  return configs.sakura || SAKURA_DEFAULTS;
}

/* ---- 实际调用 ---- */

// 翻译发送给模型的原文: 对话(首尾带「」)只发括号内的内容,旁白直接发原文
export function extractQuoteContent(text){
  const s = String(text);
  if (s.startsWith('「') && s.endsWith('」')) return s.slice(1, -1);
  return s;
}

/** Sakura 核心调用(按配置版本构造提示词;流式时 onChunk 逐块回调) */
async function sakuraTranslateCore(text, glossary, onChunk){
  const conf = currentSakuraConf();
  if (!conf.host) throw new Error('尚未配置 Sakura 本地服务。请先打开「⚙ 机翻配置」。');
  const version = resolveSakuraVersion(conf.promptVersion, conf.model);
  const gt = (conf.useGlossary && glossary && version !== 'v0.9')
    ? buildGlossaryText(glossary.names, glossary.terms, version) : '';
  const content = extractQuoteContent(text);
  return chatCompletions({
    base: conf.host,
    apiKey: '',
    model: conf.model || 'sakura',
    messages: buildSakuraMessagesV(content, gt, version),
    params: { temperature: conf.temperature, topP: conf.topP, maxTokens: conf.maxTokens },
    streaming: !!(conf.streaming && onChunk),
    onChunk,
    legacyCompletion: true,
    legacyPrompt: buildSakuraPrompt(content, gt),
  });
}

/** 翻译入口(供 UI 调用): 携带当前项目术语表;对话只发「」内原文 */
export async function sakuraTranslate(text, glossary){
  return sakuraTranslateCore(text, glossary, null);
}

const SakuraProvider = {
  id: 'sakura',
  name: 'Sakura 本地',
  isConfigured(){ const c = configs.sakura; return !!(c && c.host); },
  async translate(text, glossary, onChunk){ return sakuraTranslateCore(text, glossary, onChunk); },
  async translateBatch(texts, glossary){
    const out = [];
    for (const t of texts) out.push(await sakuraTranslateCore(t, glossary, null)); // 串行
    return out;
  }
};

registerProvider(SakuraProvider);

/* ============================================================
   通用大模型 Provider 实例
   ============================================================ */

let llmContext = []; // 多轮上下文滚动历史 {user, assistant}

const LlmProvider = {
  id: 'llm',
  name: '通用大模型',
  isConfigured(){
    const c = configs.llm;
    return !!(c && c.baseUrl && c.model);
  },
  async translate(text, glossary, onChunk){
    const conf = configs.llm || LLM_DEFAULTS;
    if (!conf.baseUrl || !conf.model) throw new Error('尚未配置通用大模型接口。请在「⚙ 机翻配置」中填写接口地址与模型。');
    const system = buildLlmSystemPrompt(conf.systemPrompt);
    const gt = conf.useGlossary && glossary ? buildGlossaryText(glossary.names, glossary.terms) : '';
    const content = extractQuoteContent(text);
    const turns = Math.max(0, Number(conf.contextTurns) || 0);
    const history = turns > 0 ? llmContext.slice(-turns) : [];
    const streaming = !!(conf.streaming && onChunk);
    const out = await chatCompletions({
      base: conf.baseUrl,
      apiKey: conf.apiKey,
      model: conf.model,
      messages: buildLlmMessages(content, gt, system, history),
      params: {
        temperature: conf.temperature,
        topP: conf.topP,
        maxTokens: conf.maxTokens,
        frequencyPenalty: conf.frequencyPenalty,
      },
      streaming,
      onChunk,
    });
    if (turns > 0){
      llmContext.push({ user: content, assistant: out });
      if (llmContext.length > turns) llmContext.splice(0, llmContext.length - turns);
    }
    return out;
  },
  async translateBatch(texts, glossary){
    const out = [];
    for (const t of texts) out.push(await this.translate(t, glossary, null)); // 串行,批量复用上下文
    return out;
  }
};

registerProvider(LlmProvider);

/** 翻译一段文本。未配置时抛错,由调用方提示用户。onChunk 可选(流式逐块)。 */
export async function translateText(providerId, text, glossary, onChunk){
  const p = getProvider(providerId) || NotConfiguredProvider;
  if (!p.isConfigured()) throw new Error('尚未配置机器翻译服务。请在「⚙ 机翻配置」中配置。');
  return p.translate(text, glossary, onChunk);
}

/** 批量翻译。未配置时抛错。 */
export async function translateBatch(providerId, texts, glossary){
  const p = getProvider(providerId) || NotConfiguredProvider;
  if (!p.isConfigured()) throw new Error('尚未配置机器翻译服务。请在「⚙ 机翻配置」中配置。');
  return p.translateBatch(texts, glossary);
}
