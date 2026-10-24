import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const srcDir = new URL('../src/', import.meta.url);

async function jsFiles(dir){
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })){
    const url = new URL(ent.name + (ent.isDirectory() ? '/' : ''), dir);
    if (ent.isDirectory()) out.push(...await jsFiles(url));
    else if (ent.name.endsWith('.js')) out.push(url);
  }
  return out;
}

function stripNoise(code){
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

test('src 中不使用原生 confirm / alert / prompt（Tauri 桌面端被 ACL 拒绝且恒返回真值）', async () => {
  const bad = [];
  for (const url of await jsFiles(srcDir)){
    const code = stripNoise(await readFile(url, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (/(^|[^\w.$])(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(line)) bad.push(`${url.pathname.split('/src/')[1]}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});
