import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const release = path.join(root, 'src-tauri', 'target', 'release');
const copies = [
  [path.join(release, 'galweave.exe'), path.join(release, 'Galweave_NoMT.exe')],
  [
    path.join(release, 'bundle', 'nsis', `Galweave_${version}_x64-setup.exe`),
    path.join(release, 'bundle', 'nsis', `Galweave_NoMT_${version}_x64-setup.exe`),
  ],
  [
    path.join(release, 'bundle', 'msi', `Galweave_${version}_x64_en-US.msi`),
    path.join(release, 'bundle', 'msi', `Galweave_NoMT_${version}_x64_en-US.msi`),
  ],
];

for (const [source, target] of copies){
  if (!fs.existsSync(source)) throw new Error(`未找到构建产物: ${source}`);
  fs.copyFileSync(source, target);
  console.log(`已生成: ${target}`);
}
