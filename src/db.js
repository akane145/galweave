// db.js — 词典源注册表持久化(SQLite,桌面版)
// 桌面版: 存 exe 同目录 galtrans.db 的 dict_sources 表(Tauri dict_* 命令);
// 浏览器版: 降级回 settings.json(localStorage,与 v5.0 一致)。
// 源记录字段: { id, type, name, path?, enabled, extra? }
//   type: 'json' | 'http' | 'mdx';extra 存 HTTP 的 urlTemplate/map/headers 等 JSON。

import * as fsx from './fs.js';

/** 是否走 SQLite(桌面版) */
function useDb(){ return fsx.isTauri(); }

async function invokeAll(){
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke;
}

/** 读全部词典源;不存在/出错返回 null(调用方回退) */
export async function dbListSources(){
  if (!useDb()) return null;
  try {
    const rows = await (await invokeAll())('dict_list_sources');
    return (rows || []).map(r => {
      const out = {
        id: r.id,
        type: r.type,
        name: r.name,
        path: r.path || undefined,
        enabled: !!r.enabled,
      };
      // HTTP 源: extra 拆回 urlTemplate/map/headers(与内存源结构一致)
      if (r.extra){
        try {
          const e = JSON.parse(r.extra);
          if (out.type === 'http'){
            out.urlTemplate = e.urlTemplate;
            out.map = e.map || {};
            out.headers = e.headers || {};
          } else {
            out.extra = e;
          }
        } catch (err){ /* 坏 extra 忽略 */ }
      }
      return out;
    });
  } catch (e){
    console.warn('[db] list_sources 失败:', e);
    return null;
  }
}

/**
 * 内存词典源 → dict_add_source 命令参数(纯函数)。
 * HTTP 源的 urlTemplate/map/headers 存进 extra JSON(与 saveDictSettings 一致);
 * 兼容旧 settings.json 里这些字段在顶层的形态(首次迁移时 extra 缺失)。
 */
export function dictSourceToDbPayload(src){
  // HTTP 源: urlTemplate/map/headers 存进 extra JSON(与 saveDictSettings 一致);
  // 兼容旧 settings.json 里这些字段在顶层、无 extra 的形态(首次迁移时)。
  let extra = src.extra;
  if (src.type === 'http' && !extra && src.urlTemplate !== undefined){
    extra = { urlTemplate: src.urlTemplate, map: src.map || {}, headers: src.headers || {} };
  }
  return {
    id: src.id,
    kind: src.type,
    name: src.name,
    path: src.path || null,
    enabled: src.enabled !== false,
    extra: extra ? JSON.stringify(extra) : null,
  };
}

/** 新增/替换词典源 */
export async function dbAddSource(src){
  if (!useDb()) return false;
  try {
    await (await invokeAll())('dict_add_source', dictSourceToDbPayload(src));
    return true;
  } catch (e){
    console.warn('[db] add_source 失败:', e);
    return false;
  }
}

/** 删除词典源 */
export async function dbRemoveSource(id){
  if (!useDb()) return false;
  try {
    await (await invokeAll())('dict_remove_source', { id });
    return true;
  } catch (e){
    console.warn('[db] remove_source 失败:', e);
    return false;
  }
}

/** 更新启用状态 */
export async function dbSetEnabled(id, enabled){
  if (!useDb()) return false;
  try {
    await (await invokeAll())('dict_set_enabled', { id, enabled: !!enabled });
    return true;
  } catch (e){
    console.warn('[db] set_enabled 失败:', e);
    return false;
  }
}

/** 把 settings.dict 的 sources 迁移进 SQLite(首次启动时调用) */
export async function dbMigrateFromSettings(sources){
  if (!useDb()) return;
  let ok = 0;
  for (const s of (sources || [])){
    if (!s || !s.id) continue;
    const migrated = await dbAddSource(s);
    if (migrated) ok++;
  }
  return ok;
}
