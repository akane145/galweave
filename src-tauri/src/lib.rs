// lib.rs — Tauri 后端命令
// read_file:  读文件并自动检测编码(UTF-8/Shift-JIS/EUC-JP/UTF-16),统一转 UTF-8 返回;
//             可用 encoding 参数强制指定(检测错时由用户手动纠正)
// write_file: 原子写文件(同目录临时文件 → 替换);按 encoding 参数编码输出(默认 UTF-8);
//             保存前若尚无同名 .bak 则自动备份原文件，备份失败会如实回报
// file_stat:  取文件指纹(大小/修改时间/内容散列),供「保存前检测外部修改」比对
// list_dir:   递归列出目录树(目录在前;文件按名称自然排序→扩展名)

use encoding_rs::{EUC_JP, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::Path;
use tauri::Emitter;

mod obsidian;

#[derive(Serialize)]
struct ObsidianNote { path: String, created: bool }

#[tauri::command]
fn create_obsidian_note(vault_path: String, id: String, content: String) -> Result<ObsidianNote, String> {
    let (path, created) = obsidian::create_note(&vault_path, &id, &content)?;
    Ok(ObsidianNote { path, created })
}

#[tauri::command]
fn create_obsidian_report(vault_path: String, id: String, content: String) -> Result<ObsidianNote, String> {
    let (path, created) = obsidian::create_report(&vault_path, &id, &content)?;
    Ok(ObsidianNote { path, created })
}

#[tauri::command]
fn open_obsidian_note(vault_path: String, id: String) -> Result<(), String> {
    obsidian::open_note(&vault_path, &id)
}

#[derive(Serialize)]
struct FileRead {
    content: String,
    encoding: String,
    /// 解码时遇到无法映射的字节(已用替换符表示) —— 说明检测出的编码可能不对
    lossy: bool,
    /// 原文件带不带 BOM(保存时据此决定是否写回 BOM)
    bom: bool,
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    kind: String, // "directory" | "file"
    depth: usize,
}

/// 文件指纹: 供「保存前检测外部修改」比对。
/// size+mtime 是快筛(便宜),hash 才是判据 —— mtime 可能因外部编辑器保留时间戳
/// 或同一时钟刻度内改写而看不出变化,只比 mtime 会漏报覆盖。
#[derive(Serialize)]
struct FileStat {
    exists: bool,
    size: u64,
    mtime_ms: i64,
    /// FNV-1a 64 位内容散列(内容变了必然变)
    hash: String,
}

/// 写文件的可选参数(JS 侧按 camelCase 传)
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct WriteOptions {
    /// 目标编码: utf-8 / utf-8-bom / shift-jis / euc-jp / utf-16le / utf-16be;缺省 utf-8
    encoding: Option<String>,
    /// 允许在目标编码无法表示部分字符时**仍然写入**(默认拒绝,见 encode_text)
    allow_lossy: Option<bool>,
    /// 跳过 .bak 备份(进度/proof 文件内部用)
    no_backup: Option<bool>,
}

#[derive(Serialize)]
struct WriteResult {
    /// 是否走了「临时文件 + 替换」的原子路径(false = 退化为直接覆盖,见 atomic_reason)
    atomic: bool,
    atomic_reason: Option<String>,
    /// 实际写出用的编码
    encoding: String,
    /// 备份结果: created / exists(已有备份,未覆盖) / skipped(目标不存在或豁免) / failed
    backup: String,
    backup_error: Option<String>,
}

// ---------- 编码检测与解码 ----------

/// 编码名(UI 与设置里的小写名) → encoding_rs 编码。未知返回 None。
fn encoding_by_name(name: &str) -> Option<&'static encoding_rs::Encoding> {
    match name.to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => Some(UTF_8),
        "shift-jis" | "shift_jis" | "sjis" => Some(SHIFT_JIS),
        "euc-jp" | "euc_jp" | "eucjp" => Some(EUC_JP),
        "utf-16le" | "utf16le" => Some(UTF_16LE),
        "utf-16be" | "utf16be" => Some(UTF_16BE),
        "utf-8-bom" => Some(UTF_8),
        _ => None,
    }
}

/// 去掉开头的 BOM 字符(U+FEFF)。只在**手动指定编码**解码时用 —— 自动检测路径
/// 已在 decode_bytes 里按字节判断过 BOM,不需要这一步。
fn strip_bom_char(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

/// 按指定编码解码。用户手动纠正编码时走这里(而非自动检测)。
fn decode_with_name(bytes: &[u8], name: &str) -> Result<FileRead, String> {
    let enc = encoding_by_name(name)
        .ok_or_else(|| format!("不支持的编码: {}", name))?;
    let has_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0xFE, 0xFF]);
    let (cow, _, had_errors) = enc.decode(bytes);
    Ok(FileRead {
        // 强制指定编码时按该编码整体解码,再剥掉可能残留的 BOM 字符
        content: strip_bom_char(&cow).to_string(),
        encoding: name.to_ascii_lowercase(),
        lossy: had_errors,
        bom: has_bom,
    })
}

fn decode_bytes(bytes: &[u8]) -> FileRead {
    // BOM 优先
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let (c, _, e) = UTF_8.decode(&bytes[3..]);
        return FileRead { content: c.into_owned(), encoding: "utf-8".into(), lossy: e, bom: true };
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (c, _, e) = UTF_16LE.decode(&bytes[2..]);
        return FileRead { content: c.into_owned(), encoding: "utf-16le".into(), lossy: e, bom: true };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (c, _, e) = UTF_16BE.decode(&bytes[2..]);
        return FileRead { content: c.into_owned(), encoding: "utf-16be".into(), lossy: e, bom: true };
    }
    // 严格 UTF-8 校验通过 → utf-8
    if let Ok(s) = std::str::from_utf8(bytes) {
        return FileRead { content: s.to_string(), encoding: "utf-8".into(), lossy: false, bom: false };
    }
    // 逐字节可用性检测: ASCII 为主的伪 8bit 直接按 sjis 处理
    let (sjis, _, sjis_err) = SHIFT_JIS.decode(bytes);
    let (euc, _, euc_err) = EUC_JP.decode(bytes);
    if !sjis_err {
        return FileRead { content: sjis.into_owned(), encoding: "shift-jis".into(), lossy: false, bom: false };
    }
    if !euc_err {
        return FileRead { content: euc.into_owned(), encoding: "euc-jp".into(), lossy: false, bom: false };
    }
    // 都失败时退回 shift-jis(日本游戏最常见),至少不会 panic。
    // lossy=true 让 UI 能提示"编码可能不对,可手动指定" —— 猜错时用户有据可依。
    FileRead { content: sjis.into_owned(), encoding: "shift-jis".into(), lossy: true, bom: false }
}

#[tauri::command]
fn read_file(path: String, encoding: Option<String>) -> Result<FileRead, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取失败 {}: {}", path, e))?;
    match encoding.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => decode_with_name(&bytes, name),
        None => Ok(decode_bytes(&bytes)),
    }
}

// ---------- 编码写出 ----------

/// 文本 → 目标编码字节。
///
/// **无法表示的字符默认拒绝写出**(had_errors):encoding_rs 对旧编码表示不了的字符
/// 会写成 `&#12345;` 之类的数字实体,那是**静默损坏** —— 脚本能存下去,引擎里显示乱码,
/// 而用户以为保存成功了。所以这里必须报错,由用户决定改编码还是删字符;
/// 确有需要(目标引擎只能收 SJIS)时可用 allowLossy 显式放行。
///
/// ⚠️ UTF-16 不能走 `encoding_rs` 的 `encode()`。WHATWG 规范把 UTF-16LE/BE 的
/// **编码器**定义为「UTF-8 编码器 + 对应 BOM」,所以 `UTF_16LE.encode("あ")` 得到的是
/// `FF FE E3 81 82` —— UTF-8 字节顶着 UTF-16 的 BOM,换个程序读就是乱码。
/// 真要写 UTF-16 只能自己按码元拼(见下),这也是本文件里唯一手写编码的地方。
fn encode_text(content: &str, name: &str, allow_lossy: bool) -> Result<(Vec<u8>, bool), String> {
    let wanted = name.to_ascii_lowercase();
    let enc = encoding_by_name(&wanted).ok_or_else(|| format!("不支持的编码: {}", name))?;

    // 各编码的 BOM(utf-8 = 无)
    let bom: &[u8] = match wanted.as_str() {
        "utf-8-bom" => &[0xEF, 0xBB, 0xBF],
        "utf-16le" => &[0xFF, 0xFE],
        "utf-16be" => &[0xFE, 0xFF],
        _ => &[],
    };

    let lossy_error = || format!(
        "目标编码 {} 无法表示译文中的部分字符，已中止写入以避免静默替换。\n\
         请改用 UTF-8，或删除这些字符后重试（确实需要强制写入时，可在提示里选「仍然写入」）。",
        wanted
    );

    if wanted == "utf-16le" || wanted == "utf-16be" {
        // str 不含孤立代理项,UTF-16 必然能完整表示 → 不会 lossy
        let mut out = bom.to_vec();
        for u in content.encode_utf16() {
            let b = if wanted == "utf-16le" { u.to_le_bytes() } else { u.to_be_bytes() };
            out.extend_from_slice(&b);
        }
        return Ok((out, false));
    }

    let (cow, _, had_errors) = enc.encode(content);
    if had_errors && !allow_lossy {
        return Err(lossy_error());
    }
    let mut out = cow.into_owned();
    // 剥掉编码器可能自带的 BOM,再按需补一份: 避免 utf-8-bom 写出两个 BOM
    for prefix in [&[0xEF, 0xBB, 0xBF][..], &[0xFF, 0xFE][..], &[0xFE, 0xFF][..]] {
        if out.starts_with(prefix) {
            out.drain(0..prefix.len());
            break;
        }
    }
    if !bom.is_empty() {
        let mut with_bom = bom.to_vec();
        with_bom.extend_from_slice(&out);
        out = with_bom;
    }
    Ok((out, had_errors))
}

// ---------- 内容散列(FNV-1a 64) ----------

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[tauri::command]
fn file_stat(path: String) -> Result<FileStat, String> {
    let p = Path::new(&path);
    let md = match fs::metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileStat { exists: false, size: 0, mtime_ms: 0, hash: String::new() });
        }
        Err(e) => return Err(format!("读取文件状态失败 {}: {}", path, e)),
    };
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let hash = match fs::read(p) {
        Ok(b) => format!("{:016x}", fnv1a64(&b)),
        Err(e) => return Err(format!("读取文件失败 {}: {}", path, e)),
    };
    Ok(FileStat { exists: true, size: md.len(), mtime_ms, hash })
}

// ---------- 原子写入 ----------

/// 备份原文件到 `<源目录>/.galweave/<文件名>.bak`(仅当目标存在且尚无同名 .bak)。
/// 返回 (状态, 错误信息)。**备份失败不阻断写入** —— 它只是一道保险,真正的
/// 保护是原子替换 + 历史快照;但失败必须如实上报,不能让用户以为有备份。
fn backup_once(path: &Path) -> (String, Option<String>) {
    if !path.exists() {
        return ("skipped".into(), None);
    }
    let parent = match path.parent() {
        Some(d) => d,
        None => return ("failed".into(), Some("无法定位源文件目录".into())),
    };
    let gal_dir = parent.join(".galweave");
    if !gal_dir.is_dir() {
        if let Err(e) = fs::create_dir_all(&gal_dir) {
            return ("failed".into(), Some(format!("创建备份目录失败: {}", e)));
        }
    }
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let bak = gal_dir.join(format!("{}.bak", file_name));
    if bak.exists() {
        return ("exists".into(), None);
    }
    match fs::copy(path, &bak) {
        Ok(_) => ("created".into(), None),
        Err(e) => ("failed".into(), Some(e.to_string())),
    }
}

/// 原子写: 同目录临时文件 → 写盘 → 替换目标。
///
/// 为什么必须同目录: `fs::rename` 只在同一卷内是原子的,跨盘会退化成复制+删除。
/// Windows 上 `fs::rename` 走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`,可直接替换
/// 已存在的文件 —— 这是本函数能"先写完整再提交"的前提。
/// 直接 `fs::write` 覆盖的风险是**写到一半失败会留下截断的脚本**(原内容已丢),
/// 替换失败时保留原文件并返回失败，不退回可能截断原文件的直接覆盖。
fn write_atomic(path: &Path, bytes: &[u8]) -> (bool, Option<String>) {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    if let Err(e) = fs::create_dir_all(dir) {
        // 建不出目录时交给下面的直接写入去报错,这里不吞掉原因
        return (false, Some(format!("创建目录失败: {}", e)));
    }
    let tmp_name = format!(
        ".{}.galweave-tmp{}-{}",
        path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "out".into()),
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
    );
    let tmp = dir.join(tmp_name);

    let mut f = match fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
        Ok(f) => f,
        Err(e) => return (false, Some(format!("创建临时文件失败: {}", e))),
    };
    let write_res = (|| -> std::io::Result<()> {
        use std::io::Write;
        f.write_all(bytes)?;
        f.sync_all()?; // 先落盘再替换: 否则掉电时可能留下长度为 0 的目标文件
        Ok(())
    })();
    drop(f);
    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp);
        return (false, Some(format!("写入临时文件失败: {}", e)));
    }

    // 保留原文件权限(Unix 下新建临时文件会按 umask 重算,可能放宽或收紧)
    #[cfg(unix)]
    {
        if let Ok(md) = fs::metadata(path) {
            let _ = fs::set_permissions(&tmp, md.permissions());
        }
    }

    match fs::rename(&tmp, path) {
        Ok(()) => (true, None),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            (false, Some(format!("原子替换失败({})，原文件未被覆盖。请关闭占用文件的程序或另存为", e)))
        }
    }
}

/// 写文件。原子替换 + 可选编码 + 备份结果如实回报。
#[tauri::command]
fn write_file(path: String, content: String, opts: Option<WriteOptions>) -> Result<WriteResult, String> {
    let o = opts.unwrap_or_default();
    let p = Path::new(&path);
    let enc_name = o
        .encoding
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "utf-8".into());
    let allow_lossy = o.allow_lossy.unwrap_or(false);

    let (bytes, lossy) = encode_text(&content, &enc_name, allow_lossy)?;

    // 进度/proof 文件本身就是备份,不再生成 .bak,避免 .galweave 里堆一层无意义副本
    let is_aux = path.ends_with(".progress.json") || path.ends_with(".proof.json");
    let (backup, backup_error) = if o.no_backup.unwrap_or(false) || is_aux {
        ("skipped".into(), None)
    } else {
        backup_once(p)
    };

    let (atomic, atomic_reason) = write_atomic(p, &bytes);

    if !atomic {
        return Err(format!("写入失败 {}: {}", path, atomic_reason.unwrap_or_else(|| "原子替换未完成".into())));
    }

    let _ = lossy;
    Ok(WriteResult { atomic, atomic_reason, encoding: enc_name, backup, backup_error })
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
    // 设置文件同样直接覆盖过 → 走原子替换,避免写一半把 settings.json 留成半个 JSON
    let dir = app_dir_path()?;
    let path = dir.join(&name);
    let (bytes, _) = encode_text(&content, "utf-8", false)?;
    let (atomic, reason) = write_atomic(&path, &bytes);
    if !atomic {
        return Err(format!("写入 {} 失败: {}", path.display(), reason.unwrap_or_else(|| "原子替换未完成".into())));
    }
    Ok(())
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
            read_file, write_file, remove_file, list_dir, read_app_file, write_app_file, read_file_b64, app_dir, file_stat,
            create_obsidian_note, open_obsidian_note, create_obsidian_report,
            dict_cmds::mdx_open, dict_cmds::mdx_lookup, dict_cmds::mdx_prefix, dict_cmds::mdx_search, dict_cmds::mdx_close,
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

    #[test]
    fn failed_parent_creation_is_not_a_successful_save() {
        let dir = temp_dir("blocked-parent");
        let parent = dir.join("parent");
        fs::write(&parent, "keep").unwrap();
        assert!(write_file(parent.join("child.txt").to_string_lossy().into_owned(), "new".into(), None).is_err());
        assert_eq!(fs::read_to_string(parent).unwrap(), "keep");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn failed_atomic_replace_preserves_original_without_direct_write_fallback() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("locked-target");
        let target = dir.join("script.txt");
        fs::write(&target, "original").unwrap();
        let lock = fs::OpenOptions::new().read(true).share_mode(3).open(&target).unwrap();
        assert!(write_file(target.to_string_lossy().into_owned(), "replacement".into(), None).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        drop(lock);
        let _ = fs::remove_dir_all(dir);
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("galweave-bak-test-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// 便捷包装: 默认选项写字符串
    fn wf(path: &str, content: &str) -> WriteResult {
        write_file(path.to_string(), content.to_string(), None).unwrap()
    }

    #[test]
    fn bak_goes_to_galweave_subfolder() {
        let dir = temp_dir("galweave");
        let src = dir.join("script.txt");
        fs::write(&src, "v1").unwrap();
        // 首次写入(目标存在) → .galweave/script.txt.bak 生成,原文件更新
        wf(&src.to_string_lossy(), "v2");
        let gal = dir.join(".galweave");
        assert!(gal.is_dir(), ".galweave 目录应创建");
        let bak = gal.join("script.txt.bak");
        assert!(bak.exists(), ".bak 应生成在 .galweave 下");
        assert_eq!(fs::read_to_string(&bak).unwrap(), "v1");
        assert_eq!(fs::read_to_string(&src).unwrap(), "v2");
        // 二次写入: .bak 已存在 → 不再覆盖
        wf(&src.to_string_lossy(), "v3");
        assert_eq!(fs::read_to_string(&bak).unwrap(), "v1", ".bak 仅首次生成");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_bak_for_progress_and_proof_files() {
        let dir = temp_dir("aux");
        let prog = dir.join("script.progress.json");
        fs::write(&prog, "{}").unwrap();
        wf(&prog.to_string_lossy(), "{}2");
        // 进度/proof 文件本身是备份,不应再生成 .bak
        assert!(!dir.join(".galweave").join("script.progress.json.bak").exists());
        assert!(!dir.join("script.progress.json.bak").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bak_not_created_when_target_absent() {
        let dir = temp_dir("fresh");
        let src = dir.join("new.txt");
        wf(&src.to_string_lossy(), "v1");
        assert!(!dir.join(".galweave").join("new.txt.bak").exists(), "目标原本不存在 → 无 .bak");
        assert_eq!(fs::read_to_string(&src).unwrap(), "v1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_reports_backup_status() {
        let dir = temp_dir("bakstatus");
        let src = dir.join("a.txt");
        // 目标不存在 → skipped
        assert_eq!(wf(&src.to_string_lossy(), "v1").backup, "skipped");
        // 目标存在且无 .bak → created
        assert_eq!(wf(&src.to_string_lossy(), "v2").backup, "created");
        // .bak 已在 → exists(不覆盖)
        assert_eq!(wf(&src.to_string_lossy(), "v3").backup, "exists");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_is_atomic_and_leaves_no_temp_file() {
        let dir = temp_dir("atomic");
        let src = dir.join("s.txt");
        fs::write(&src, "old").unwrap();
        let r = wf(&src.to_string_lossy(), "new");
        assert!(r.atomic, "同目录替换应走原子路径: {:?}", r.atomic_reason);
        assert_eq!(fs::read_to_string(&src).unwrap(), "new");
        // 临时文件必须清理干净,否则 .galweave 之外的目录会残留隐藏文件
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("galweave-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件: {:?}", leftovers);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_creates_missing_parent_dir() {
        let dir = temp_dir("nested");
        let src = dir.join("a").join("b").join("c.txt");
        wf(&src.to_string_lossy(), "hi");
        assert_eq!(fs::read_to_string(&src).unwrap(), "hi");
        let _ = fs::remove_dir_all(&dir);
    }

    /* ---------------- 编码 ---------------- */

    #[test]
    fn encode_utf8_default_has_no_bom() {
        let (b, lossy) = encode_text("こんにちは", "utf-8", false).unwrap();
        assert!(!lossy);
        assert_eq!(b, "こんにちは".as_bytes());
        assert_ne!(&b[..3], &[0xEF, 0xBB, 0xBF]);
    }

    #[test]
    fn encode_utf8_bom_prepends_bom() {
        let (b, _) = encode_text("abc", "utf-8-bom", false).unwrap();
        assert_eq!(&b[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(&b[3..], b"abc");
    }

    #[test]
    fn encode_shift_jis_roundtrips_japanese() {
        let (b, lossy) = encode_text("こんにちは", "shift-jis", false).unwrap();
        assert!(!lossy);
        let r = decode_with_name(&b, "shift-jis").unwrap();
        assert_eq!(r.content, "こんにちは");
        assert!(!r.lossy);
    }

    #[test]
    fn encode_rejects_unrepresentable_chars_by_default() {
        // UTF-8 能表示中文, Shift-JIS 不能 → 必须报错而不是写成数字实体
        let err = encode_text("简体中文", "shift-jis", false).unwrap_err();
        assert!(err.contains("无法表示"), "错误应说明原因: {}", err);
        // 显式放行时才写(had_errors = true 交给调用方知情)
        let (_, lossy) = encode_text("简体中文", "shift-jis", true).unwrap();
        assert!(lossy, "放行时须回报 lossy");
    }

    #[test]
    fn encode_utf16_writes_bom_for_auto_detection() {
        let (le, _) = encode_text("あ", "utf-16le", false).unwrap();
        assert_eq!(&le[..2], &[0xFF, 0xFE]);
        let (be, _) = encode_text("あ", "utf-16be", false).unwrap();
        assert_eq!(&be[..2], &[0xFE, 0xFF]);
        // 写出的字节必须能被自动检测路径读回(否则等于存了个打不开的文件)
        assert_eq!(decode_bytes(&le).content, "あ");
        assert_eq!(decode_bytes(&be).content, "あ");
        assert_eq!(decode_bytes(&le).encoding, "utf-16le");
    }

    #[test]
    fn unknown_encoding_is_rejected() {
        assert!(encode_text("x", "cp932-nope", false).is_err());
        assert!(decode_with_name(b"x", "nope").is_err());
    }

    #[test]
    fn decode_detects_encodings_and_reports_lossy() {
        let (b, _) = encode_text("こんにちは", "shift-jis", false).unwrap();
        let r = decode_bytes(&b);
        assert_eq!(r.encoding, "shift-jis");
        assert_eq!(r.content, "こんにちは");
        assert!(!r.lossy);

        let utf8_bom = [&[0xEF, 0xBB, 0xBF][..], "中文".as_bytes()].concat();
        let r2 = decode_bytes(&utf8_bom);
        assert_eq!(r2.encoding, "utf-8");
        assert_eq!(r2.content, "中文");
        assert!(r2.bom);
    }

    #[test]
    fn forced_decode_strips_bom_char() {
        let utf8_bom = [&[0xEF, 0xBB, 0xBF][..], "中文".as_bytes()].concat();
        let r = decode_with_name(&utf8_bom, "utf-8").unwrap();
        assert_eq!(r.content, "中文", "手动指定编码时不能把 BOM 当正文");
    }

    /* ---------------- 文件指纹 ---------------- */

    #[test]
    fn file_stat_detects_change_and_absence() {
        let dir = temp_dir("stat");
        let src = dir.join("f.txt");
        let missing = file_stat(src.to_string_lossy().into_owned()).unwrap();
        assert!(!missing.exists);
        assert!(missing.hash.is_empty());

        fs::write(&src, "v1").unwrap();
        let a = file_stat(src.to_string_lossy().into_owned()).unwrap();
        assert!(a.exists);
        assert_eq!(a.size, 2);
        assert!(!a.hash.is_empty());

        fs::write(&src, "v2").unwrap();
        let b = file_stat(src.to_string_lossy().into_owned()).unwrap();
        assert_ne!(a.hash, b.hash, "内容变了指纹必须变");

        // 同内容 → 同散列(即便 mtime 变)
        fs::write(&src, "v2").unwrap();
        let c = file_stat(src.to_string_lossy().into_owned()).unwrap();
        assert_eq!(b.hash, c.hash);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fnv1a64_is_stable_and_sensitive() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), fnv1a64(b"a"));
        assert_ne!(fnv1a64(b"a"), fnv1a64(b"b"));
        // 位置敏感: "ab" 与 "ba" 必须不同(否则只是多重集求和)
        assert_ne!(fnv1a64(b"ab"), fnv1a64(b"ba"));
    }

    #[test]
    fn write_with_encoding_roundtrips() {
        let dir = temp_dir("encread");
        let src = dir.join("sjis.txt");
        let opts = Some(WriteOptions {
            encoding: Some("shift-jis".into()),
            allow_lossy: None,
            no_backup: None,
        });
        write_file(src.to_string_lossy().into_owned(), "こんにちは".into(), opts).unwrap();
        // 字节层是 SJIS(不是 UTF-8)
        let raw = fs::read(&src).unwrap();
        assert_ne!(raw, "こんにちは".as_bytes());
        assert_eq!(decode_bytes(&raw).encoding, "shift-jis");
        assert_eq!(decode_bytes(&raw).content, "こんにちは");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_backup_option_skips_bak() {
        let dir = temp_dir("nobackup");
        let src = dir.join("x.txt");
        fs::write(&src, "v1").unwrap();
        let r = write_file(
            src.to_string_lossy().into_owned(),
            "v2".into(),
            Some(WriteOptions { no_backup: Some(true), ..Default::default() }),
        )
        .unwrap();
        assert_eq!(r.backup, "skipped");
        assert!(!dir.join(".galweave").join("x.txt.bak").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
