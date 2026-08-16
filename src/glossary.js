// glossary.js — 术语表模块(项目制)
// 术语表按"项目"管理: 项目 = 当前打开文件所在目录,术语表存 <项目目录>/glossary.json。
// 同目录的多个文件共享一份术语表;未打开文件/无路径(浏览器)时回退软件目录全局术语表。
// 项目目录不可写时自动回退全局/localStorage。

import { isTauri } from './fs.js';
import { recalcDone } from './model.js';

const LS_GLOSS_KEY = 'galtrans_glossary_v1';
const GLOBAL_FILE = 'glossary.json'; // 软件目录全局术语表
const PROJECT_FILE = 'glossary.json'; // 项目目录术语表文件名

let cache = null;       // 内存缓存
let projectDir = null;  // 当前项目目录(为空 = 全局术语表)

function emptyGloss(){ return { names: {}, terms: {} }; }
function cloneGloss(g){ return { names: { ...(g.names || {}) }, terms: { ...(g.terms || {}) } }; }

/** 规范化目录路径: \ 统一转 /、去尾部斜杠、去空白(纯函数,可单测) */
export function normalizeDirPath(p){
  if (!p) return '';
  return String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 项目术语表完整路径(纯函数,可单测);dir 为空返回 null */
export function projectGlossaryPath(dir){
  const d = normalizeDirPath(dir);
  if (!d) return null;
  return d + '/' + PROJECT_FILE;
}

/** 读任意路径文本;不存在/出错返回 null */
async function readText(path){
  if (!path) return null;
  try {
    const { readTextFileSource } = await import('./fs.js');
    return await readTextFileSource(path);
  } catch (e) { return null; }
}

/** 读全局术语表(软件目录 → localStorage) */
async function readGlobal(){
  if (isTauri()){
    try {
      const { readAppFile } = await import('./fs.js');
      const raw = await readAppFile(GLOBAL_FILE);
      if (raw){ try { return JSON.parse(raw); } catch (e) { return null; } }
    } catch (e) { return null; }
  }
  try { return JSON.parse(localStorage.getItem(LS_GLOSS_KEY) || 'null'); } catch (e) { return null; }
}

function writeLocalFallback(g){
  try { localStorage.setItem(LS_GLOSS_KEY, JSON.stringify(g)); } catch (e) { /* 忽略 */ }
}

/**
 * 加载术语表: 有项目目录 → 优先项目 glossary.json;
 * 项目文件不存在时以全局术语表为初始内容(旧版数据无缝过渡);
 * 无项目目录 → 全局术语表。
 */
export async function loadGlossaryForProject(dir){
  projectDir = normalizeDirPath(dir) || null; // 规范化(统一 /),同一目录不同斜杠视为同一项目
  if (projectDir){
    const raw = await readText(projectGlossaryPath(projectDir));
    if (raw){
      try {
        cache = cloneGloss(JSON.parse(raw));
        return cache;
      } catch (e) { /* 项目文件损坏 → 回退全局 */ }
    }
  }
  const g = await readGlobal();
  cache = g && typeof g === 'object' ? cloneGloss(g) : emptyGloss();
  return cache;
}

/** 保存术语表到当前项目目录;项目不可写 → 全局 → localStorage */
export async function saveGlossaryForProject(gloss){
  cache = cloneGloss(gloss);
  if (projectDir){
    try {
      const { writeTextFileSource } = await import('./fs.js');
      await writeTextFileSource(projectGlossaryPath(projectDir), JSON.stringify(cache, null, 2));
      return;
    } catch (e) { /* 项目目录不可写 → 回退全局 */ }
  }
  if (isTauri()){
    try {
      const { writeAppFile } = await import('./fs.js');
      await writeAppFile(GLOBAL_FILE, JSON.stringify(cache, null, 2));
      return;
    } catch (e) { /* 回退 localStorage */ }
  }
  writeLocalFallback(cache);
}

/** 当前项目目录(供 UI 显示) */
export function getProjectDir(){ return projectDir; }

/** 内存缓存隔离(测试用) */
export function resetGlossaryState(){ cache = null; projectDir = null; }

// 兼容旧导出名(无参加载=全局;保存到当前项目)
export const loadGlossary = loadGlossaryForProject;
export const saveGlossary = saveGlossaryForProject;

/* ---------------- 应用逻辑 ---------------- */

/**
 * 人名自动: 遍历 paras,说话人名命中人名表时,自动把 nameTr 设为中文译名。
 * 仅在当前 nameTr 仍是原文名(即未手动改过)时应用,避免覆盖人工编辑。
 * 返回应用条数。
 */
export function applyNames(paras, names){
  let n = 0;
  for (const p of paras){
    if (!p.name) continue;
    const dst = names[p.name];
    if (dst && p.nameTr === p.name){ // 未手动改过才自动应用
      p.nameTr = dst;
      recalcDone(p); // NAME 行的 done = nameTr !== name,需刷新
      n++;
    }
  }
  return n;
}

/**
 * 词条批量应用: 在已翻译的译文中,把词条原文替换为译文(用于统一已翻文本中的专名/术语)。
 * 只替换译文,原文永不修改;NAME 条目与空译文行跳过。
 * 采用"一次扫描、非重叠替换"(长词条优先),替换出的译文不会再被其它词条二次替换。
 * 返回替换总次数。
 */
export function applyTermsToTranslations(paras, terms){
  let total = 0;
  const keys = Object.keys(terms).filter(k => k && terms[k] !== undefined && terms[k] !== '');
  if (!keys.length) return 0;
  const sorted = keys.sort((a, b) => b.length - a.length);
  for (const p of paras){
    if (p.isName) continue;
    const tv = p.translation || '';
    if (tv.trim() === '') continue;
    let out = '', i = 0, cnt = 0;
    while (i < tv.length){
      let hit = null;
      for (const k of sorted){
        if (tv.startsWith(k, i)){ hit = k; break; }
      }
      if (hit){
        out += terms[hit];
        i += hit.length;
        cnt++;
      } else {
        out += tv[i];
        i++;
      }
    }
    if (cnt > 0){
      p.translation = out;
      p.done = (p.brackets ? out.slice(1, -1) : out).trim() !== '';
      total += cnt;
    }
  }
  return total;
}

/** 记录新翻译的人名(说话人名 → 译名),翻译人名时自动沉淀进人名表。 */
export function recordNameIfNew(names, srcName, trName){
  if (!srcName || !trName || trName === srcName) return false;
  if (names[srcName] && names[srcName] === trName) return false;
  names[srcName] = trName;
  return true;
}
