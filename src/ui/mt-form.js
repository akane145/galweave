// mt-form.js — 机翻配置面板的表单构造（从 main.js 拆出）
//
// 这一组函数只做一件事：把配置对象渲染成 HTML 字符串。它们**不读也不写 DOM**
// （返回字符串由调用方 innerHTML 注入），不碰任何模块级状态 —— 因此是 main.js 里
// 最容易整体搬走的一块。搬出来也让"表单长什么样"和"表单怎么读写"分开：
// 读取逻辑（readMTFormConfig）留在 main.js，因为它要和保存流程、端口探测按钮对齐。
//
// ⚠️ 这里的 id 字符串（mtBaseUrl / mtHost / mtBatchMode …）与 main.js 的
//    readMTFormConfig() 必须保持一致。两处分离是有意的取舍：改 id 时要同时看两边。

import * as mt from '../mt.js';

function mtField(label, html, hint){
  const controlId = (html.match(/id="([^"]+)"/) || [])[1];
  const forAttr = controlId ? ' for="' + controlId + '"' : '';
  return '<div class="field"><label' + forAttr + '>' + label + '</label>' + html + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
}

function mtInput(id, value, ph){
  return '<input type="text" id="' + id + '" value="' + String(value || '').replace(/"/g, '&quot;') + '" placeholder="' + (ph || '') + '" autocomplete="off">';
}

function mtNum(id, value, min, max){
  return '<input type="number" id="' + id + '" min="' + min + '" max="' + max + '" step="any" value="' + value + '">';
}

function mtCheck(id, label, checked){
  return '<label class="check-label modal-check"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '> ' + label + '</label>';
}

/** 采样参数网格: [{label,id,value,min,max}] → 每参数一列 */
function mtParams(list){
  return '<div class="mt-params">' + list.map(p =>
    '<div class="p"><label for="' + p.id + '">' + p.label + '</label>' + mtNum(p.id, p.value, p.min, p.max) + '</div>'
  ).join('') + '</div>';
}

/** 批量策略两个字段：两种引擎共用，放在「采样参数」页 */
function mtBatchFields(conf){
  return mtField('批量策略（批次模式以返回的行号对齐；行数或控制标签对不上时该批自动退回逐行，不会错位写入）',
    '<select id="mtBatchMode">' +
      '<option value="perLine"' + (conf.batchMode === 'batched' ? '' : ' selected') + '>逐行（默认 · 最稳，失败只影响该行）</option>' +
      '<option value="batched"' + (conf.batchMode === 'batched' ? ' selected' : '') + '>按批次合并请求（一次翻译多行，省往返与时间）</option>' +
    '</select>') +
  mtField('每批行数（仅「按批次合并请求」生效）', mtNum('mtBatchSize', conf.batchSize, 2, 20)) +
  // 超时覆盖"发请求 → 正文读完"整个过程。本地模型冷启动慢，默认 90 秒。
  mtField('单次请求超时（秒）',
    mtNum('mtTimeoutSec', Math.round((conf.timeoutMs || 90000) / 1000), 5, 600),
    '从发请求到正文读完的总时限，默认 90 秒。本地大模型冷启动加载常需 30–60 秒，'
      + '若经常超时（尤其首次翻译）可调大到 180–300 秒。');
}

/** 通用大模型表单（两页：连接与提示词 / 采样与选项） */
export function mtFormLlm(conf){
  const page1 =
    mtField('接口地址（OpenAI 兼容，如 https://api.openai.com/v1）', mtInput('mtBaseUrl', conf.baseUrl, 'https://api.openai.com/v1')) +
    mtField('API Key（留空则不发送；llama.cpp 本地可留空）', mtInput('mtApiKey', conf.apiKey, 'sk-…')) +
    mtField('模型名', mtInput('mtModel', conf.model, 'gpt-4o-mini')) +
    mtField('系统提示词（留空使用默认翻译提示词）',
      '<textarea id="mtSystem" rows="3" placeholder="You are a translator…">' + String(conf.systemPrompt || '').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</textarea>') +
    mtField('多轮上下文（>0 时翻译/批量自动附带最近 N 句原文与译文，使人物语气、指代更连贯；批量逐句累积，切引擎/改配置后清空）', mtNum('mtContextTurns', conf.contextTurns, 0, 20));
  const page2 =
    mtField('采样参数', mtParams([
      { label: '温度 temperature', id: 'mtTemperature', value: conf.temperature, min: 0, max: 2 },
      { label: 'top_p', id: 'mtTopP', value: conf.topP, min: 0, max: 1 },
      { label: 'max_tokens', id: 'mtMaxTokens', value: conf.maxTokens, min: 1, max: 32768 },
      { label: 'frequency_penalty', id: 'mtFreqPenalty', value: conf.frequencyPenalty, min: -2, max: 2 },
    ])) +
    mtField('选项', mtCheck('mtStreaming', '流式输出（翻译当前行时逐字显示）', conf.streaming) +
      '<br>' + mtCheck('mtUseGlossary', '翻译时附加当前项目的 glossary.json 术语', conf.useGlossary)) +
    mtBatchFields(conf);
  return '<div id="mtP0">' + page1 + '</div><div id="mtP1" class="hidden">' + page2 + '</div>';
}

/** Sakura 本地表单（两页：服务与提示词版本 / 采样与选项） */
export function mtFormSakura(conf){
  const page1 =
    mtField('Sakura / llama.cpp 服务地址（Sakura_Launcher_GUI 或 llama-server 显示的地址/端口）',
      '<div class="row">' + mtInput('mtHost', conf.host, 'http://127.0.0.1:8080') +
      '<button id="btnMtDetect" class="toolbtn secondary nowrap">检测端口</button></div>') +
    mtField('模型名（用于提示词版本自动识别，可留空）', mtInput('mtModel', conf.model, '如 sakura-qwen2.5-7b-v1.0')) +
    mtField('提示词版本（auto=按模型名自动识别）',
      '<select id="mtPromptVersion">' + mt.SAKURA_PROMPT_VERSIONS.map(v => '<option value="' + v + '"' + (conf.promptVersion === v ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>',
      'Sakura 使用专用翻译提示词，可附带术语表；语境参考和角色人设用于通用大模型。');
  const page2 =
    mtField('采样参数', mtParams([
      { label: '温度 temperature', id: 'mtTemperature', value: conf.temperature, min: 0, max: 2 },
      { label: 'top_p', id: 'mtTopP', value: conf.topP, min: 0, max: 1 },
      { label: 'max_tokens', id: 'mtMaxTokens', value: conf.maxTokens, min: 1, max: 32768 },
    ])) +
    mtField('选项', mtCheck('mtStreaming', '流式输出（翻译当前行时逐字显示）', conf.streaming) +
      '<br>' + mtCheck('mtUseGlossary', '翻译时附加当前项目的 glossary.json 术语', conf.useGlossary)) +
    mtBatchFields(conf);
  return '<div id="mtP0">' + page1 + '</div><div id="mtP1" class="hidden">' + page2 + '</div>';
}
