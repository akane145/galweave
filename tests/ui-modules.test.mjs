// src/ui/ 拆分模块的导入完整性测试 — node:test + node:assert
//
// 为什么需要这个测试：2026-09-18 拆分 main.js 时，新建的 src/ui/mt-form.js 里
// 把 `../mt.js` 误写成 `./mt.js`。**lint 不查、node --test 也不查**（没有测试直接
// import 该模块），只有 vite build 才会报 UNRESOLVED_IMPORT。
// 本文件用动态 import 把每个 UI 模块真正加载一遍，让这类路径错误在 npm test 阶段
// 就暴露，而不是留到打包时。
//
// 运行: node --test tests/ui-modules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const UI_DIR = new URL('../src/ui/', import.meta.url);

/** 纯逻辑模块（无 DOM 依赖）在 Node 下可直接 import；含 DOM 的需先铺最小桩。 */
function stubDom(){
  const el = () => ({
    style: {}, dataset: {}, classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    append(){}, appendChild(){}, insertBefore(){}, removeChild(){}, replaceChildren(){},
    setAttribute(){}, getAttribute: () => null, addEventListener(){}, removeEventListener(){},
    querySelectorAll: () => [], querySelector: () => null, getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
    focus(){}, blur(){}, click(){}, value: '', textContent: '', innerHTML: '', title: '', hidden: false,
  });
  globalThis.document = {
    documentElement: el(), body: el(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: el, createDocumentFragment: el, addEventListener(){}, removeEventListener(){},
  };
  globalThis.window = globalThis.window || {};
  globalThis.getComputedStyle = globalThis.getComputedStyle || (() => ({ getPropertyValue: () => '' }));
}

test('src/ui/ 下每个模块都能被 import（拦住相对路径写错）', async () => {
  stubDom();
  const files = (await readdir(UI_DIR)).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 0, 'src/ui/ 应当至少有一个模块');

  const failed = [];
  for (const f of files){
    try {
      await import(new URL(f, UI_DIR).href);
    } catch (e){
      failed.push(f + ': ' + e.message);
    }
  }
  assert.deepEqual(failed, [], '以下 UI 模块无法加载:\n' + failed.join('\n'));
});

test('src/ui/ 模块只通过 ../ 引入 src/ 下的模块（目录层级正确）', async () => {
  const files = (await readdir(UI_DIR)).filter(f => f.endsWith('.js'));
  const { readFile } = await import('node:fs/promises');
  const bad = [];
  for (const f of files){
    const src = await readFile(fileURLToPath(new URL(f, UI_DIR)), 'utf8');
    // 允许 './'（同目录）与 '../'（上一级）；裸的 './xxx' 指向 src/ 才是错的
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)){
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      // src/ui/x.js 里 '../foo.js' 正确；'./foo.js' 只能指向 src/ui/ 内的文件
      if (spec.startsWith('./')){
        const target = spec.slice(2);
        const exists = files.includes(target);
        if (!exists) bad.push(f + ' → ' + spec + '（src/ui/ 内不存在该文件，应写成 ../' + target + '）');
      }
    }
  }
  assert.deepEqual(bad, [], '发现相对路径疑似写错:\n' + bad.join('\n'));
});
