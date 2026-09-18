#!/usr/bin/env node
/*
 * fix-mirror-indent.mjs — 修复镜像格式(dc4ph)译文中丢失的旁白全角空格缩进。
 *
 * 约定: 旁白行的 // 原文行以全角空格(　)开头(游戏缩进),对应的译文行(无 //)也应以此开头。
 * 本脚本逐条消息检查: 原文行以全角空格开头而译文行没有时,给译文行补上。
 * 对白(「开头)与名字行(原文无空格)不受影响;已带空格的译文行不重复添加。
 *
 * 用法:
 *   node scripts/fix-mirror-indent.mjs <dc4ph文本>           预览将要修改的行
 *   node scripts/fix-mirror-indent.mjs <dc4ph文本> --write   实际写入
 */
import fs from 'node:fs';

const LINE_RE = /^( *)(\p{So})(\p{So})[ \t]*(\d{3})[ \t]*\3\2(\/\/)?([\s\S]*)$/u;
const bodyOf = (m) => {
  const tail = m[6] || '';
  return m[5] && tail.startsWith('//') ? tail.slice(2) : tail;
};

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const write = args.includes('--write');
if (!file){
  console.error('用法: node scripts/fix-mirror-indent.mjs <dc4ph文本> [--write]');
  process.exit(1);
}

const text = fs.readFileSync(file, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';
const raw = text.split(/\r?\n/);
const changes = [];

for (let i = 0; i < raw.length; i++){
  const m = raw[i].match(LINE_RE);
  if (!m || !m[5]) continue; // 找 // 原文行
  let j = i + 1;
  while (j < raw.length && raw[j].trim() === '') j += 1;
  const p = raw[j] ? raw[j].match(LINE_RE) : null;
  if (!p || p[4] !== m[4]) continue;
  const slashBody = bodyOf(m);
  const plainBody = bodyOf(p);
  if (slashBody.startsWith('　') && plainBody !== '' && !plainBody.startsWith('　')){
    changes.push({
      line: j + 1,
      after: raw[j].slice(0, raw[j].length - plainBody.length) + '　' + plainBody,
      plainBody,
    });
  }
  i = j;
}

if (!changes.length){
  console.log('没有需要修复的译文行(旁白译文行都已带全角空格)。');
  process.exit(0);
}
for (const c of changes){
  console.log(`L${c.line}: 　${c.plainBody.slice(0, 50)}`);
}
if (write){
  for (const c of changes) raw[c.line - 1] = c.after;
  fs.writeFileSync(file, raw.join(nl), 'utf8');
  console.log(`已写入 ${changes.length} 处 → ${file}`);
} else {
  console.log(`(预览 ${changes.length} 处;确认无误后加 --write 写入)`);
}
