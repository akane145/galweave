// snippets.js — 快捷片段(缩写→展开文本)存储
// 两层: 全局 snippets.json(软件目录/localStorage) + 项目 <目录>/snippets.json;
// 匹配时合并(项目覆盖全局),编辑保存到项目(未打开文件时保存到全局),与术语表行为一致。

import { isTauri } from './fs.js';
import { normalizeDirPath } from './glossary.js';

const LS_KEY = 'galtrans_snippets_v1';
const FILE_NAME = 'snippets.json';

let projectDir = null;

/** 项目片段完整路径(纯函数);dir 为空返回 null */
export function projectSnippetsPath(dir){
  const d = normalizeDirPath(dir);
  return d ? d + '/' + FILE_NAME : null;
}

/** 合并(纯函数,可单测): 项目覆盖全局 */
export function mergeSnippets(globalObj, projectObj){
  return { ...(globalObj || {}), ...(projectObj || {}) };
}

/** 清洗: 去空白键、丢空值(纯函数) */
export function sanitizeSnippets(obj){
  const out = {};
  for (const [k, v] of Object.entries(obj || {})){
    const kk = String(k).trim();
    if (kk && v !== undefined && v !== null && String(v) !== '') out[kk] = String(v);
  }
  return out;
}

async function readText(path){
  if (!path) return null;
  try {
    const { readTextFileSource } = await import('./fs.js');
    return await readTextFileSource(path);
  } catch (e) { return null; }
}

async function readGlobal(){
  if (isTauri()){
    try {
      const { readAppFile } = await import('./fs.js');
      const raw = await readAppFile(FILE_NAME);
      if (raw){
        try { return sanitizeSnippets(JSON.parse(raw)); } catch (e) { return {}; }
      }
    } catch (e) { /* 回退 localStorage */ }
  }
  try { return sanitizeSnippets(JSON.parse(localStorage.getItem(LS_KEY) || 'null')); } catch (e) { return {}; }
}

/**
 * 加载片段: { global, project, merged }。
 * 有项目目录时读取项目 snippets.json(不存在则空);全局始终读取。
 */
export async function loadSnippetsForProject(dir){
  projectDir = normalizeDirPath(dir) || null;
  const globalSnips = await readGlobal();
  let projectSnips = {};
  if (projectDir){
    const raw = await readText(projectSnippetsPath(projectDir));
    if (raw){
      try { projectSnips = sanitizeSnippets(JSON.parse(raw)); } catch (e) { /* 项目文件损坏按空处理 */ }
    }
  }
  return { global: globalSnips, project: projectSnips, merged: mergeSnippets(globalSnips, projectSnips) };
}

/**
 * 保存片段表(当前编辑层): 有项目目录 → 项目文件;否则全局文件 → localStorage。
 * 返回实际落点 'project' | 'global' | 'local'。
 */
export async function saveSnippetsForProject(snips){
  const clean = sanitizeSnippets(snips);
  if (projectDir){
    try {
      const { writeTextFileSource } = await import('./fs.js');
      await writeTextFileSource(projectSnippetsPath(projectDir), JSON.stringify(clean, null, 2));
      return 'project';
    } catch (e) { /* 项目不可写 → 回退全局 */ }
  }
  if (isTauri()){
    try {
      const { writeAppFile } = await import('./fs.js');
      await writeAppFile(FILE_NAME, JSON.stringify(clean, null, 2));
      return 'global';
    } catch (e) { /* 回退 localStorage */ }
  }
  try { localStorage.setItem(LS_KEY, JSON.stringify(clean)); } catch (e) { /* 忽略 */ }
  return 'local';
}

/** 当前片段项目目录(供 UI 显示落盘位置) */
export function getSnippetsProjectDir(){ return projectDir; }

/** 内存状态重置(测试用) */
export function resetSnippetsState(){ projectDir = null; }
