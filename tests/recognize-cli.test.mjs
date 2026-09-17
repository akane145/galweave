import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(args){
  return spawnSync(process.execPath, [resolve(root, 'scripts/recognize-format.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('recognize-format CLI：增强 profile 可跨进程规范化并无损还原', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'galweave-parser-'));
  try {
    const source = resolve(dir, 'source.txt');
    writeFileSync(source, '○00001○[[人物]]「こんにちは」[np]\n●00001●[[人物]]「你好」[np]\n\n', 'utf8');
    const canonical = resolve(dir, 'sample.canonical.txt');
    const profile = resolve(dir, 'sample.profile.json');
    const restored = resolve(dir, 'sample.restored.txt');

    const convert = run([source, '--convert', canonical, '--json', profile, '--quiet']);
    assert.equal(convert.status, 0, convert.stderr);
    const savedProfile = JSON.parse(readFileSync(profile, 'utf8'));
    assert.equal(savedProfile.lossless.version, 1);
    assert.ok(savedProfile.modules.records.length > 0);

    const restore = run([canonical, '--profile', profile, '--out', restored, '--quiet']);
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(readFileSync(restored, 'utf8'), readFileSync(source, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
