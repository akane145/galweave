// dict_cmds.rs — 词典 Tauri 命令层
// 句柄管理(MDX/MDD 读取器注册表) + 查询/资源命令 + SQLite 词典源注册表。
// 与 mdict.rs 分离:mdict.rs 是纯解析,本文件是 Tauri 边界。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, RwLock};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::mdict::MdictReader;

/// 应用级共享状态。rusqlite::Connection 非 Send+Sync,必须用 Mutex 包(官方推荐)。
pub struct DictState {
    pub mdx: RwLock<HashMap<u32, MdictReader>>,
    pub mdd: RwLock<HashMap<u32, MdictReader>>,
    pub next: AtomicU32,
    pub db: Mutex<Option<Connection>>,
}

impl DictState {
    pub fn new() -> Self {
        Self {
            mdx: RwLock::new(HashMap::new()),
            mdd: RwLock::new(HashMap::new()),
            next: AtomicU32::new(1),
            db: Mutex::new(None),
        }
    }
    fn next_id(&self) -> u32 {
        self.next.fetch_add(1, Ordering::SeqCst)
    }
    fn db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
        let exe = std::env::current_exe().map_err(|e| format!("定位程序目录失败: {}", e))?;
        let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        Ok(dir.join("galtrans.db"))
    }
    /// 打开数据库(惰性,单次);返回克隆的 connection 引用
    pub fn with_db<F, T>(&self, app: &AppHandle, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let mut guard = self.db.lock().map_err(|_| "数据库锁失败".to_string())?;
        if guard.is_none() {
            let path = Self::db_path(app)?;
            let conn = Connection::open(&path).map_err(|e| format!("打开词典库失败 {}: {}", path.display(), e))?;
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS dict_sources(
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    path TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    extra TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                );",
            ).map_err(|e| format!("建表失败: {}", e))?;
            *guard = Some(conn);
        }
        f(guard.as_ref().unwrap())
    }
}

#[derive(Serialize)]
pub struct DictSourceRow {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub path: Option<String>,
    pub enabled: bool,
    pub extra: Option<String>,
}

#[derive(Serialize)]
pub struct MdxHit {
    pub key_text: String,
    pub definition: String,
}

/// 打开 MDX 词典,返回句柄 id
#[tauri::command]
pub fn mdx_open(state: State<DictState>, path: String) -> Result<u32, String> {
    let reader = MdictReader::open(&path, false)?;
    let id = state.next_id();
    state.mdx.write().map_err(|_| "句柄锁失败".to_string())?.insert(id, reader);
    Ok(id)
}

/// 查询 MDX 词条;Rust 端完成 @@@LINK 跟随(≤3 跳)与大小写兜底。
#[tauri::command]
pub fn mdx_lookup(state: State<DictState>, handle: u32, word: String) -> Result<Option<MdxHit>, String> {
    let norm = word.trim().to_string();
    let hit = {
        let m = state.mdx.read().map_err(|_| "句柄锁失败".to_string())?;
        let r = m.get(&handle).ok_or("词典句柄无效(可能已关闭或重启)")?;
        r.lookup_follow(&norm)?
    };
    Ok(hit.map(|(kt, definition)| MdxHit { key_text: kt, definition }))
}

/// 前缀补全(返回词头列表)
#[tauri::command]
pub fn mdx_prefix(state: State<DictState>, handle: u32, word: String, limit: Option<u32>) -> Result<Vec<String>, String> {
    let m = state.mdx.read().map_err(|_| "句柄锁失败".to_string())?;
    let r = m.get(&handle).ok_or("词典句柄无效")?;
    Ok(r.prefix(&word, (limit.unwrap_or(6) as usize).min(20)))
}

/// 模糊搜索(包含匹配)词头列表
#[tauri::command]
pub fn mdx_search(state: State<DictState>, handle: u32, word: String, limit: Option<u32>) -> Result<Vec<String>, String> {
    let m = state.mdx.read().map_err(|_| "句柄锁失败".to_string())?;
    let r = m.get(&handle).ok_or("词典句柄无效")?;
    Ok(r.search(&word, (limit.unwrap_or(20) as usize).min(50)))
}

/// 关闭 MDX 词典
#[tauri::command]
pub fn mdx_close(state: State<DictState>, handle: u32) -> Result<(), String> {
    state.mdx.write().map_err(|_| "句柄锁失败".to_string())?.remove(&handle);
    Ok(())
}

/// 打开 MDD 资源包,返回句柄
#[tauri::command]
pub fn mdd_open(state: State<DictState>, path: String) -> Result<u32, String> {
    let reader = MdictReader::open(&path, true)?;
    let id = state.next_id();
    state.mdd.write().map_err(|_| "句柄锁失败".to_string())?.insert(id, reader);
    Ok(id)
}

/// 读取 MDD 资源(图片/音频原始字节;base64 编码返回,WebView 可直接用 data URL 或写文件)
/// 生成 MDD 资源 key 的候选变体: 原样、去前导 / \、以及内部斜杠风格互换
/// (MDX 词条 href/src 常用正斜杠,MDD 内部 key 常用反斜杠,二者需互相尝试方能命中)。
fn mdd_key_variants(k: &str) -> Vec<String> {
    let t = k.trim_start_matches(['\\', '/']);
    let mut v = vec![k.to_string(), t.to_string()];
    if t.contains('\\') || t.contains('/') {
        v.push(t.replace('\\', "/"));
        v.push(t.replace('/', "\\"));
    }
    v.sort();
    v.dedup();
    v
}

#[tauri::command]
pub fn mdd_resource(state: State<DictState>, handle: u32, key: String) -> Result<Option<String>, String> {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    let m = state.mdd.read().map_err(|_| "句柄锁失败".to_string())?;
    let r = m.get(&handle).ok_or("MDD 句柄无效")?;
    for cand in mdd_key_variants(&key) {
        if let Some(b) = r.mdd_resource(&cand)? {
            return Ok(Some(STANDARD.encode(b)));
        }
    }
    Ok(None)
}

/// 关闭 MDD
#[tauri::command]
pub fn mdd_close(state: State<DictState>, handle: u32) -> Result<(), String> {
    state.mdd.write().map_err(|_| "句柄锁失败".to_string())?.remove(&handle);
    Ok(())
}

/* ---------------- SQLite 词典源注册表 ---------------- */

#[tauri::command]
pub fn dict_list_sources(state: State<DictState>, app: AppHandle) -> Result<Vec<DictSourceRow>, String> {
    state.with_db(&app, |conn| {
        let mut stmt = conn.prepare("SELECT id, type, name, path, enabled, extra FROM dict_sources ORDER BY created_at").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| {
            Ok(DictSourceRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                name: r.get(2)?,
                path: r.get(3)?,
                enabled: r.get::<_, i64>(4)? != 0,
                extra: r.get(5)?,
            })
        }).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
}

#[tauri::command]
pub fn dict_add_source(
    state: State<DictState>,
    app: AppHandle,
    id: String,
    kind: String,
    name: String,
    path: Option<String>,
    enabled: bool,
    extra: Option<String>,
) -> Result<(), String> {
    state.with_db(&app, |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO dict_sources(id, type, name, path, enabled, extra) VALUES(?1,?2,?3,?4,?5,?6)",
            params![id, kind, name, path, enabled as i64, extra],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub fn dict_remove_source(state: State<DictState>, app: AppHandle, id: String) -> Result<(), String> {
    state.with_db(&app, |conn| {
        conn.execute("DELETE FROM dict_sources WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub fn dict_set_enabled(state: State<DictState>, app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    state.with_db(&app, |conn| {
        conn.execute("UPDATE dict_sources SET enabled=?1 WHERE id=?2", params![enabled as i64, id]).map_err(|e| e.to_string())?;
        Ok(())
    })
}
