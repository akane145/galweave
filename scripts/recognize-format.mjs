#!/usr/bin/env node
/*
 * Detect common Galgame translation text formats and convert them to
 * Galtrans' native ☆/★ paired-line format.
 *
 * 识别/规范化/还原的纯逻辑在 src/recognize.js(GUI「格式识别」弹窗与 CLI 共用同一份代码)。
 * 本文件只做命令行封装。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { detect, canonicalize, restore, renderReport } from '../src/recognize.js';

function usage() {
  console.log(`Usage:
  node scripts/recognize-format.mjs <input> [options]

Options:
  --report                 print a human-readable report (default)
  --json <file>            write the recognition profile JSON
  --convert [file]         write Galtrans-native ☆/★ text
  --restore [file]         restore mode (optional value = profile JSON, alias of --profile)
  --profile <file>         profile JSON used by restore
  --out <file>             output path for --convert/--restore
  --encoding <name>        input encoding (default: utf8)
  --quiet                  suppress the human-readable report
  -h, --help               show this help

Restore (简化: 只要给 --profile 就进入还原模式):
  node scripts/recognize-format.mjs <规范文本.txt> --profile <档案.json> [--out <还原输出>]
  不指定 --out 时,默认输出到输入同目录、把 .canonical.txt 换成 .restored.txt。
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const opts = { report: true, encoding: 'utf8' };
  if (!args.length || args.includes('-h') || args.includes('--help')) return { help: true };
  opts.input = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--report') opts.report = true;
    else if (arg === '--quiet') opts.report = false;
    else if (arg === '--json') opts.json = args[++i];
    else if (arg === '--convert') {
      opts.convert = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) opts.convertPath = args[++i];
    } else if (arg === '--restore') {
      // 兼容: 可带 profile 路径(等价于 --profile),也可只作模式开关
      if (args[i + 1] && !args[i + 1].startsWith('-')) opts.restore = args[++i];
      else opts.restore = true;
    } else if (arg === '--profile') opts.profile = args[++i];
    else if (arg === '--out') opts.out = args[++i];
    else if (arg === '--encoding') opts.encoding = args[++i];
    else throw new Error(`未知参数: ${arg}`);
  }
  return opts;
}

function readText(file, encoding = 'utf8') {
  return fs.readFileSync(file, { encoding });
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function defaultOutput(input, suffix) {
  const ext = path.extname(input);
  return path.join(path.dirname(input), `${path.basename(input, ext)}${suffix}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return; }
  if (!opts.input) throw new Error('缺少输入文件');

  // 还原模式: --profile(或 --restore 带值)触发;输入即规范文本
  const restoreMode = !!opts.profile || opts.restore === true || typeof opts.restore === 'string';
  if (restoreMode) {
    const profileFile = opts.profile || (typeof opts.restore === 'string' ? opts.restore : null)
      || opts.input.replace(/\.canonical\.txt$/i, '.profile.json');
    if (!fs.existsSync(profileFile)) throw new Error(`还原需要 profile JSON: ${profileFile}`);
    const profile = JSON.parse(readText(profileFile));
    const canonicalText = readText(opts.input, opts.encoding);
    const restored = restore(profile, canonicalText);
    const output = opts.out || (opts.input.endsWith('.canonical.txt')
      ? opts.input.replace(/\.canonical\.txt$/i, '.restored.txt')
      : defaultOutput(opts.input, '.restored.txt'));
    writeText(output, restored);
    if (opts.report) console.log(`已还原: ${output}`);
    return;
  }

  const sourceText = readText(opts.input, opts.encoding);
  const profile = detect(sourceText, path.basename(opts.input));
  if (opts.report) console.log(renderReport(profile));
  if (opts.json) writeText(opts.json, JSON.stringify(profile, null, 2));
  if (opts.convert) {
    const output = opts.convertPath || opts.out || defaultOutput(opts.input, '.canonical.txt');
    writeText(output, canonicalize(profile));
    if (opts.report) console.log(`已规范化: ${output}`);
  }
  if (!opts.json && !opts.convert && !opts.report) process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
}
