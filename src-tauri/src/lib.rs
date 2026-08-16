// lib.rs — Tauri 后端命令
// read_file:  读文件并自动检测编码(UTF-8/Shift-JIS/EUC-JP/UTF-16),统一转 UTF-8 返回
// write_file: 写文件(UTF-8);保存前若尚无同名 .bak 则自动备份原文件
// list_dir:   递归列出目录树(目录在前;文件按名称自然排序→扩展名)

use encoding_rs::{EUC_JP, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::Path;
use tauri::Emitter;

#[derive(Serialize)]
struct FileRead {
    content: String,
    encoding: String,
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    kind: String, // "directory" | "file"
    depth: usize,
}

// ---------- 编码检测与解码 ----------

fn decode_bytes(bytes: &[u8]) -> FileRead {
    // BOM 优先
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (c, _, _) = UTF_8.decode(&bytes[3..]);
        return FileRead { content: c.into_owned(), encoding: "utf-8".into() };
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (c, _, _) = UTF_16LE.decode(&bytes[2..]);
        return FileRead { content: c.into_owned(), encoding: "utf-16le".into() };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (c, _, _) = UTF_16BE.decode(&bytes[2..]);
        return FileRead { content: c.into_owned(), encoding: "utf-16be".into() };
    }
    // 严格 UTF-8 校验通过 → utf-8
    if let Ok(s) = std::str::from_utf8(bytes) {
        return FileRead { content: s.to_string(), encoding: "utf-8".into() };
    }
    // 逐字节可用性检测: ASCII 为主的伪 8bit 直接按 sjis 处理
    let (sjis, _, sjis_err) = SHIFT_JIS.decode(bytes);
    let (euc, _, euc_err) = EUC_JP.decode(bytes);
    if !sjis_err {
        return FileRead { content: sjis.into_owned(), encoding: "shift-jis".into() };
    }
    if !euc_err {
        return FileRead { content: euc.into_owned(), encoding: "euc-jp".into() };
    }
    // 都失败时退回 shift-jis(日本游戏最常见),至少不会 panic
    FileRead { content: sjis.into_owned(), encoding: "shift-jis".into() }
}

#[tauri::command]
fn read_file(path: String) -> Result<FileRead, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取失败 {}: {}", path, e))?;
    Ok(decode_bytes(&bytes))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    // 保存前自动备份到 <源目录>/.galweave/<文件名>.bak(仅当目标存在且尚无同名 .bak);
    // 进度/proof 文件本身就是备份,不再生成 .bak,避免 .galweave 里堆一层无意义副本。
    let is_aux = path.ends_with(".progress.json") || path.ends_with(".proof.json");
    if !is_aux && p.exists() {
        if let Some(parent) = p.parent() {
            let gal_dir = parent.join(".galweave");
            if gal_dir.is_dir() || fs::create_dir_all(&gal_dir).is_ok() {
                let file_name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let bak = gal_dir.join(format!("{}.bak", file_name));
                if !bak.exists() {
                    let _ = fs::copy(p, &bak);
                }
            }
        }
    }
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, content).map_err(|e| format!("写入失败 {}: {}", path, e))
}

// 读取文件为 base64(背景图片等二进制资源;约比原图大 33%,由调用方限制大小)
#[tauri::command]
fn read_file_b64(path: String) -> Result<String, String> {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    let bytes = fs::read(&path).map_err(|e| format!("读取失败 {}: {}", path, e))?;
    Ok(STANDARD.encode(bytes))
}

// 删除文件(清理进度文件 .progress.json 等;不存在视为已删,不报错)
#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    match fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除失败 {}: {}", path, e)),
    }
}

// ---------- 软件目录数据文件(与 exe 同目录,便携) ----------

fn app_dir_path() -> Result<std::path::PathBuf, String> {
    std::env::current_exe()
        .and_then(|exe| {
            Ok(exe.parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| std::path::PathBuf::from(".")))
        })
        .map_err(|e| format!("无法定位程序目录: {}", e))
}

// 返回 exe 所在目录(保存对话框的默认路径等用)
#[tauri::command]
fn app_dir() -> Result<String, String> {
    Ok(app_dir_path()?.to_string_lossy().to_string())
}

#[tauri::command]
fn read_app_file(name: String) -> Result<Option<String>, String> {
    let dir = app_dir_path()?;
    let path = dir.join(&name);
    if !path.exists() {
        return Ok(None);
    }
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) => Err(format!("读取 {} 失败: {}", path.display(), e)),
    }
}

#[tauri::command]
fn write_app_file(name: String, content: String) -> Result<(), String> {
    let dir = app_dir_path()?;
    let path = dir.join(&name);
    fs::write(&path, content).map_err(|e| format!("写入 {} 失败: {}", path.display(), e))
}

// ---------- 目录树 ----------

// 自然排序: 把字符串切成 数字块/非数字块,逐块比较(数字按数值,其余按字典序)
fn split_chunks(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_digit: Option<bool> = None;
    for ch in s.chars() {
        let d = ch.is_ascii_digit();
        match prev_digit {
            Some(pd) if pd == d => cur.push(ch),
            _ => {
                if !cur.is_empty() { out.push(std::mem::take(&mut cur)); }
                cur.push(ch);
                prev_digit = Some(d);
            }
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out
}

fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (ca, cb) = (split_chunks(a), split_chunks(b));
    let n = ca.len().min(cb.len());
    for i in 0..n {
        let x = &ca[i];
        let y = &cb[i];
        match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(m), Ok(nn)) if m != nn => return m.cmp(&nn),
            (Ok(_), Ok(_)) => {}
            _ => {
                let o = x.cmp(y);
                if o != Ordering::Equal { return o; }
            }
        }
    }
    ca.len().cmp(&cb.len())
}

fn collect_dir(dir: &Path, depth: usize, out: &mut Vec<DirEntry>) -> Result<(), String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}: {}", dir.display(), e))?;
    let mut entries: Vec<(String, bool, std::path::PathBuf)> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        entries.push((name, is_dir, entry.path()));
    }
    // 排序: 目录在前;文件按 名称自然序 → 扩展名
    let ext_of = |n: &str| -> String {
        match n.rfind('.') {
            Some(i) => n[i + 1..].to_lowercase(),
            None => String::new(),
        }
    };
    entries.sort_by(|a, b| {
        if a.1 != b.1 { return if a.1 { Ordering::Less } else { Ordering::Greater }; }
        let nc = natural_cmp(&a.0, &b.0);
        if nc != Ordering::Equal { return nc; }
        ext_of(&a.0).cmp(&ext_of(&b.0))
    });
    for (name, is_dir, path) in entries {
        // 跳过内部备份目录 .galweave(进度/proof/.bak 存放处),避免出现在侧栏文件树
        if is_dir && name == ".galweave" { continue; }
        let p = path.to_string_lossy().to_string();
        out.push(DirEntry { name: name.clone(), path: p.clone(), kind: if is_dir { "directory".into() } else { "file".into() }, depth });
        if is_dir && depth < 40 {
            collect_dir(&path, depth + 1, out)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    collect_dir(Path::new(&path), 0, &mut out)?;
    Ok(out)
}

// ---------- 入口 ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        // 词典引擎共享状态(SQLite 词典源注册表 + MDX/MDD 句柄)
        .manage(dict_cmds::DictState::new())
        // 桌面端拖拽: Webview 会拦截 HTML5 drop,拿不到路径;
        // 改由窗口级 DragDrop 事件取真实路径,再 emit 给前端。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let _ = window.emit("galtrans-drag-drop", paths.clone());
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, remove_file, list_dir, read_app_file, write_app_file, read_file_b64, app_dir,
            dict_cmds::mdx_open, dict_cmds::mdx_lookup, dict_cmds::mdx_prefix, dict_cmds::mdx_close,
            dict_cmds::mdd_open, dict_cmds::mdd_resource, dict_cmds::mdd_close,
            dict_cmds::dict_list_sources, dict_cmds::dict_add_source, dict_cmds::dict_remove_source, dict_cmds::dict_set_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------- MDX/MDD 词典引擎 ----------
pub mod mdict;
// ---------- 词典 Tauri 命令层(SQLite 词典源 + 句柄) ----------
pub mod dict_cmds;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("galweave-bak-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn bak_goes_to_galweave_subfolder() {
        let dir = temp_dir("galweave");
        let src = dir.join("script.txt");
        fs::write(&src, "v1").unwrap();
        // 首次写入(目标存在) → .galweave/script.txt.bak 生成,原文件更新
        write_file(src.to_string_lossy().into_owned(), "v2".into()).unwrap();
        let gal = dir.join(".galweave");
        assert!(gal.is_dir(), ".galweave 目录应创建");
        let bak = gal.join("script.txt.bak");
        assert!(bak.exists(), ".bak 应生成在 .galweave 下");
        assert_eq!(fs::read_to_string(&bak).unwrap(), "v1");
        assert_eq!(fs::read_to_string(&src).unwrap(), "v2");
        // 二次写入: .bak 已存在 → 不再覆盖
        write_file(src.to_string_lossy().into_owned(), "v3".into()).unwrap();
        assert_eq!(fs::read_to_string(&bak).unwrap(), "v1", ".bak 仅首次生成");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_bak_for_progress_and_proof_files() {
        let dir = temp_dir("aux");
        let prog = dir.join("script.progress.json");
        fs::write(&prog, "{}").unwrap();
        write_file(prog.to_string_lossy().into_owned(), "{}2".into()).unwrap();
        // 进度/proof 文件本身是备份,不应再生成 .bak
        assert!(!dir.join(".galweave").join("script.progress.json.bak").exists());
        assert!(!dir.join("script.progress.json.bak").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bak_not_created_when_target_absent() {
        let dir = temp_dir("fresh");
        let src = dir.join("new.txt");
        write_file(src.to_string_lossy().into_owned(), "v1".into()).unwrap();
        assert!(!dir.join(".galweave").join("new.txt.bak").exists(), "目标原本不存在 → 无 .bak");
        assert_eq!(fs::read_to_string(&src).unwrap(), "v1");
        let _ = fs::remove_dir_all(&dir);
    }
}
