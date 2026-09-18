#!/usr/bin/env node
// inspect.mjs — 用真实文件检查识别结果
//
// 与 VS Code 扩展**共用同一套规则库与选择逻辑**（src/rules.js），
// 所以在终端调好的规则，在编辑器里得到的结果一致。
//
// 用法：
//   node scripts/inspect.mjs <文件> [选项]
//
// 选项：
//   --rule <id>        强制用规则库里的某条规则（用 --list-rules 查 id）
//   --config <json>    用一个临时规则文件（覆盖规则库；含反斜杠时建议用文件而非命令行）
//   --open <字符>      覆盖原文标记
//   --close <字符>     覆盖译文标记
//   --regex <正则>     覆盖自定义前缀正则
//   --list-rules       列出规则库后退出
//   --json             以 JSON 输出解析结果
//   --limit <n>        明细最多显示 n 段（默认 20）
//   -h, --help         显示帮助
//
// 示例：
//   node scripts/inspect.mjs "../test text/新建 文本文档 (2).txt"
//   node scripts/inspect.mjs "../test text/新建 文本文档 (13).txt" --rule circle-inline-speaker
//   node scripts/inspect.mjs somefile.txt --list-rules

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseLines, isMirrorDoc, KIND, ROLE } from '../src/lineparse.js';
import { detectEncoding, decodeBytes, encodingLabel } from '../src/encoding.js';
import {
  BUILTIN_RULES, normalizeRule, findRule, validateRule, scoreRule, pickRule,
} from '../src/rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..');
const RULES_DIR = path.join(EXT_DIR, 'rules');

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const out = { file: null, overrides: {}, limit: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--list-rules') { out.listRules = true; continue; }
    if (a === '--rule') { out.ruleId = argv[++i]; continue; }
    if (a === '--config') { out.configPath = argv[++i]; continue; }
    if (a === '--open') { out.overrides.open = argv[++i]; continue; }
    if (a === '--close') { out.overrides.close = argv[++i]; continue; }
    if (a === '--regex') { out.overrides.regex = argv[++i]; continue; }
    if (a === '--limit') { out.limit = Number(argv[++i]) || 20; continue; }
    if (a.startsWith('-')) { console.error(`未知选项：${a}`); process.exit(2); }
    if (!out.file) { out.file = a; continue; }
    console.error(`多余的参数：${a}`);
    process.exit(2);
  }
  return out;
}

function usage() {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('// inspect.mjs'), src.indexOf('\nimport fs'));
  console.log(body.replace(/^\/\/ ?/gm, '').trim());
}

/** 规则库 = 内置 + 扩展自带 rules/*.json。与扩展的载入逻辑同源。 */
function loadRuleLibrary() {
  const lib = BUILTIN_RULES.slice();
  const rejected = [];
  let names = [];
  try {
    names = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.json'));
  } catch (e) { /* 没有 rules 目录也正常 */ }
  for (const name of names) {
    const p = path.join(RULES_DIR, name);
    const fallbackId = name.replace(/\.json$/, '');
    let rule;
    try {
      rule = normalizeRule(JSON.parse(fs.readFileSync(p, 'utf8')), fallbackId);
    } catch (e) {
      rejected.push(`${fallbackId}：不是合法 JSON（${e.message}）`);
      continue;
    }
    const invalid = validateRule(rule);
    if (invalid) { rejected.push(`${rule.label}：${invalid}`); continue; }
    lib.push(rule);
  }
  return { lib, rejected };
}

/* ---------------- 主流程 ---------------- */

const args = parseArgs(process.argv.slice(2));
const { lib, rejected } = loadRuleLibrary();
const samplePath = path.join(EXT_DIR, 'rules/circle-inline-speaker.json');

if (args.help || (!args.file && !args.listRules)) { usage(); process.exit(args.help ? 0 : 2); }

if (args.listRules) {
  console.log(`规则库共 ${lib.length} 条：\n`);
  for (const r of lib) {
    console.log(`  ${r.id.padEnd(28)} ${r.label}`);
    if (r.conf.regex) console.log(`  ${''.padEnd(28)} 正则：${r.conf.regex}`);
  }
  if (rejected.length) {
    console.log(`\n被拒绝的规则文件：`);
    for (const r of rejected) console.log(`  ${r}`);
  }
  console.log(`\n规则文件样例：${path.relative(process.cwd(), samplePath)}`);
  process.exit(0);
}

if (!fs.existsSync(args.file)) {
  console.error(`文件不存在：${args.file}`);
  process.exit(2);
}

let conf, ruleLabel, forced = false, autoScore = null;

if (args.configPath) {
  const p = path.resolve(args.configPath);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`规则文件读取失败：${e.message}`);
    process.exit(2);
  }
  const rule = normalizeRule(raw, path.basename(p, '.json'));
  const invalid = validateRule(rule);
  if (invalid) {
    console.error(`规则「${rule.label}」无效 —— ${invalid}`);
    console.error('提示：shell 会吃掉反斜杠，复杂正则请写进 JSON 用 --config 传入。');
    process.exit(2);
  }
  conf = rule.conf;
  ruleLabel = `${rule.label}（--config 指定）`;
  forced = true;
} else if (args.ruleId) {
  const rule = findRule(lib, args.ruleId);
  if (!rule) {
    console.error(`规则库里没有 id 为「${args.ruleId}」的规则。用 --list-rules 查看可用规则。`);
    process.exit(2);
  }
  conf = rule.conf;
  ruleLabel = `${rule.label}（--rule 指定）`;
  forced = true;
}

// 手工覆盖（可叠加在规则库/规则文件之上）
if (Object.keys(args.overrides).length) {
  const base = conf || (lib[0] && lib[0].conf) || {};
  conf = normalizeRule({ ...base, ...args.overrides }, 'cli').conf;
  ruleLabel = `${ruleLabel ? ruleLabel + ' + ' : ''}命令行覆盖`;
  forced = true;
}

// 读文件先判编码：日语脚本有不少是 Shift-JIS / EUC-JP，按 UTF-8 读会整篇乱码、规则也匹配不上
const rawBytes = fs.readFileSync(args.file);
const decodeWith = (label, bytes) => new TextDecoder(label).decode(bytes);
const encInfo = detectEncoding(rawBytes, { decode: decodeWith });
const decoded = decodeBytes(rawBytes, encInfo, decodeWith);
const text = decoded.text;
if (decoded.degraded) console.error(`警告：${decoded.reason}，已降级按 UTF-8 读`);
// 镜像格式(dc4ph)与扩展走同一条分流：结构自证，不需要规则库（见 src/lineparse.js）
const mirrorFile = isMirrorDoc(text);

if (!conf && mirrorFile) {
  // 镜像格式没有 ☆/★ 标记，规则库解释不了它：给它一个能读出来的标签，conf 留空
  ruleLabel = '镜像格式（dc4ph：// 原文行 + 普通译文行）（自动识别）';
}
if (!conf && !mirrorFile) {
  const picked = pickRule(text, lib);
  if (!picked) {
    console.log(`文件：${path.basename(args.file)}`);
    console.log(`没有规则能解释这个文件。可用规则（--list-rules 看详情）：${lib.map(r => r.id).join(', ')}`);
    process.exit(0);
  }
  conf = picked.rule.conf;
  ruleLabel = `${picked.rule.label}（自动选择）`;
  autoScore = picked.score;
}

const parsed = parseLines(text, { conf });

/** 规则是否真的解释了这份文档（至少一行正文被吃掉前缀）。 */
function ruleExplains(p) {
  return p.paras.some(x => x.orig.length > x.content.length);
}
const explains = ruleExplains(parsed);

if (args.json) {
  console.log(JSON.stringify({
    file: args.file, rule: ruleLabel, conf, explains,
    encoding: encInfo.encoding, encodingConfidence: encInfo.confidence, encodingEvidence: encInfo.evidence,
    ...parsed,
  }, null, 2));
  process.exit(0);
}

const kindLabel = { [KIND.NAME]: '人名', [KIND.DIALOGUE]: '对话', [KIND.NARRATION]: '旁白' };
const roleCount = {};
for (const l of parsed.lines) roleCount[l.role] = (roleCount[l.role] || 0) + 1;

console.log(`文件：${path.basename(args.file)}`);
console.log(`编码：${encodingLabel(encInfo.encoding)}（${encInfo.encoding}，置信度 ${encInfo.confidence}）`);
console.log(`规则：${ruleLabel}`);
console.log(mirrorFile
  ? '标记：镜像格式（#0x 地址头 + ★◎ 编号 ◎★// 原文行 + ★◎ 编号 ◎★ 译文行）'
  : `标记：原文=${conf.open || '(空)'}  译文=${conf.close || '(空)'}  自定义正则=${conf.regex ? '有' : '无'}`);
if (autoScore) {
  console.log(`评分：命中 ${autoScore.marked} 行 · 说话人 ${autoScore.speakers} · 编号 ${autoScore.numbered}`);
}
console.log(`换行：${parsed.nl === '\r\n' ? 'CRLF' : 'LF'}   段尾空行：${parsed.trailingBlank ? '有' : '无'}`);

if (!explains) {
  console.log('');
  console.log(`⚠ 这条规则没有解释文件的任何一行 —— 下面的统计是"整行当正文"的结果，不可信。`);
  console.log(`  ${forced ? '换一条规则，或去掉 --rule/--config 让工具自动选择。' : '用 galweave.rules 追加规则文件。'}`);
}

console.log('');
console.log(`段落 ${parsed.summary.total}   人名 ${parsed.summary.name}   对话 ${parsed.summary.dialogue}   旁白 ${parsed.summary.narration}   已翻译 ${parsed.summary.done}   未翻译 ${parsed.summary.untranslated}`);
console.log(`行角色  原文 ${roleCount[ROLE.ORIG] || 0}   译文 ${roleCount[ROLE.TRANS] || 0}   注释 ${roleCount[ROLE.COMMENT] || 0}   空行 ${roleCount[ROLE.BLANK] || 0}   多余 ${roleCount[ROLE.OTHER] || 0}`);

if (parsed.paras[0]) console.log(`区间来源：${parsed.paras[0].rangeSource}`);

const speakers = [...new Set(parsed.paras.filter(p => p.name).map(p => p.name))];
if (speakers.length) console.log(`说话人 ${speakers.length} 位：${speakers.join(' ')}`);

if (parsed.summary.untranslated) {
  console.log(`\n未翻译示例：`);
  for (const p of parsed.paras.filter(p => !p.done).slice(0, 5)) {
    console.log(`  第 ${p.lineIndices.orig + 1} 行  [${kindLabel[p.kind]}]  ${p.content.slice(0, 44)}`);
  }
}

console.log(`\n段落明细（前 ${Math.min(args.limit, parsed.summary.total)} 段）：`);
for (const p of parsed.paras.slice(0, args.limit)) {
  const ln = String(p.lineIndices.orig + 1).padStart(4);
  const kind = (kindLabel[p.kind] || p.kind).padEnd(2);
  const st = p.done ? '✓' : '·';
  const who = (p.name || '—').padEnd(5);
  console.log(`  ${ln} ${st} ${kind} ${who} ${p.id.padEnd(18)} ${p.content.slice(0, 46)}`);
}
if (parsed.summary.total > args.limit) {
  console.log(`  …（另有 ${parsed.summary.total - args.limit} 段，用 --limit 调整）`);
}
