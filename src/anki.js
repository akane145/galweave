// anki.js — AnkiConnect 客户端与制卡内容组装（纯逻辑，不依赖 DOM）。
//
// 用途：遇到疑难文法、生僻词或经典译法时，把【生词 + 假名 + 词典释义 + 当前对白原句 + 译文】
// 一键送到 Anki，边翻译边积累语料。
//
// 依赖 AnkiConnect 插件（Anki 的本地 HTTP 接口，默认 http://127.0.0.1:8331）。
// **桌面版可以访问本地端口** —— 2026-09-18 实测确认（Tauri 的 csp 为 null，
// 不拦本地请求；spike 方式：起一个 mock 服务，启动 exe 后确认服务器收到请求）。
//
// 本模块**不做网络 IO**，只负责：
//   1. 组装 AnkiConnect 的请求体（纯函数，可单测）
//   2. 解析响应（AnkiConnect 用 {result, error} 信封，HTTP 状态永远是 200）
// 真正的 fetch 由调用方注入（见 main.js），这样单测无需起服务器。

/** AnkiConnect 默认地址 */
export const ANKI_DEFAULT_URL = 'http://127.0.0.1:8331';
/** 默认牌组与笔记类型 */
export const ANKI_DEFAULT_DECK = 'Galweave';
export const ANKI_DEFAULT_MODEL = 'Basic';
/** 请求超时：Anki 未启动时应快速失败，而不是让 UI 一直转 */
export const ANKI_TIMEOUT_MS = 5000;

/* ---------------- 请求组装 ---------------- */

/**
 * 组装 AnkiConnect 请求体。
 * AnkiConnect 的协议极简：{ action, version, params }，version 恒为 6。
 */
export function buildRequest(action, params){
  return { action: String(action || ''), version: 6, params: params || {} };
}

/** 连通性探测请求 */
export function versionRequest(){
  return buildRequest('version', {});
}

/** 列牌组 / 笔记类型：用于设置界面给出可选值 */
export function deckNamesRequest(){ return buildRequest('deckNames', {}); }
export function modelNamesRequest(){ return buildRequest('modelNames', {}); }

/**
 * 组装 addNote 请求。
 *
 * AnkiConnect 的字段名按**笔记类型**而异（Basic 是 Front/Back，问答题是 问/答…），
 * 所以开放 fields 覆盖，默认用 Basic。
 */
export function addNoteRequest(note){
  return buildRequest('addNote', { note: normalizeNote(note) });
}

/** 归一化一条笔记：字段与标签都要是字符串数组/对象，否则 Anki 会报错 */
export function normalizeNote(note){
  const n = note && typeof note === 'object' ? note : {};
  const fields = {};
  for (const [k, v] of Object.entries(n.fields || {})){
    const key = String(k || '').trim();
    if (key) fields[key] = String(v == null ? '' : v);
  }
  const tags = (Array.isArray(n.tags) ? n.tags : [])
    .map(t => String(t == null ? '' : t).trim())
    .filter(Boolean);
  const out = { fields };
  if (n.deckName) out.deckName = String(n.deckName);
  if (n.modelName) out.modelName = String(n.modelName);
  if (tags.length) out.tags = tags;
  if (n.options && typeof n.options === 'object') out.options = n.options;
  return out;
}

/* ---------------- 响应解析 ---------------- */

/**
 * 解析 AnkiConnect 响应。
 *
 * ⚠️ AnkiConnect **即使出错也返回 HTTP 200**，错误放在 `{ error }` 里。
 *    只查 res.ok 会把失败当成功（"卡片已添加"但实际没加）。
 * @returns {{ok:boolean, result:*, error:string|null}}
 */
export function parseResponse(data){
  if (!data || typeof data !== 'object') return { ok: false, result: null, error: '响应格式无法识别' };
  if (data.error) return { ok: false, result: null, error: String(data.error) };
  return { ok: true, result: data.result, error: null };
}

/** 把 AnkiConnect 的常见错误翻成人话（原生文案是英文/技术向的） */
export function describeError(err){
  const s = String(err == null ? '' : err);
  if (!s) return '';
  if (/failed to connect|ECONNREFUSED|NetworkError|fetch/i.test(s)){
    return '连不上 Anki。请确认 Anki 正在运行，且已安装并启用 AnkiConnect 插件。';
  }
  if (/collection is not available/i.test(s)){
    return 'Anki 正在同步或关闭中，暂时无法写入。稍后重试。';
  }
  if (/duplicate/i.test(s)){
    return '这张卡已存在（Anki 判定为重复）。';
  }
  if (/model was not found|deck was not found/i.test(s)){
    return '找不到指定的笔记类型或牌组。请在设置里改成一个已存在的名字。';
  }
  return s;
}

/* ---------------- 卡片内容 ---------------- */

/** HTML 转义：Anki 字段是 HTML，未转义的原句会被当成标签解析 */
export function escHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 组装一条卡片的正面与背面。
 *
 * 内容取舍：正面放**生词 + 假名**（要考察的），背面放**释义 + 对白原句 + 译文**（上下文）。
 * 把原句与译文放背面是有意的 —— 这张卡的目的是记住词，而语境是用来理解与回想的锚点，
 * 放正面会直接泄题。
 *
 * @param {{word?:string, reading?:string, meaning?:string, sentence?:string,
 *          translation?:string, speaker?:string, note?:string, source?:string}} input
 * @returns {{front:string, back:string}}
 */
export function buildCardFields(input){
  const it = input && typeof input === 'object' ? input : {};
  const word = String(it.word == null ? '' : it.word).trim();
  const reading = String(it.reading == null ? '' : it.reading).trim();

  const frontParts = [escHtml(word)];
  if (reading && reading !== word) frontParts.push('<div class="reading">' + escHtml(reading) + '</div>');
  const front = frontParts.join('\n');

  const backParts = [];
  const meaning = String(it.meaning == null ? '' : it.meaning).trim();
  if (meaning) backParts.push(escHtml(meaning));
  const sentence = String(it.sentence == null ? '' : it.sentence).trim();
  const translation = String(it.translation == null ? '' : it.translation).trim();
  if (sentence || translation){
    const speaker = String(it.speaker == null ? '' : it.speaker).trim();
    const head = speaker ? '<div class="speaker">' + escHtml(speaker) + '</div>' : '';
    const body = '<hr>' + head
      + (sentence ? '<div class="orig">' + escHtml(sentence) + '</div>' : '')
      + (translation ? '<div class="trans">' + escHtml(translation) + '</div>' : '');
    backParts.push(body);
  }
  const note = String(it.note == null ? '' : it.note).trim();
  if (note) backParts.push('<div class="note">' + escHtml(note) + '</div>');
  const source = String(it.source == null ? '' : it.source).trim();
  if (source) backParts.push('<div class="source">' + escHtml(source) + '</div>');

  return { front, back: backParts.join('\n') };
}

/**
 * 由一次查词/一行译文组装完整的 note 对象。
 * @returns {object} 可直接喂给 addNoteRequest
 */
export function buildNote(input, opts = {}){
  const { front, back } = buildCardFields(input);
  const tags = (Array.isArray(opts.tags) ? opts.tags : [])
    .map(t => String(t == null ? '' : t).trim())
    .filter(Boolean);
  return normalizeNote({
    fields: { Front: front, Back: back },
    deckName: opts.deck || ANKI_DEFAULT_DECK,
    modelName: opts.model || ANKI_DEFAULT_MODEL,
    tags,
  });
}

/** 自动标签：把来源（项目名/文件名）变成 Anki 可用的标签（空格换成下划线，去掉非法字符） */
export function autoTags(...parts){
  return [...new Set(
    parts
      .map(p => String(p == null ? '' : p).trim())
      .filter(Boolean)
      .map(p => p.replace(/[^\w\u4e00-\u9fff\u3040-\u30ff-]+/g, '_').replace(/^_+|_+$/g, ''))
      .filter(Boolean)
  )];
}
