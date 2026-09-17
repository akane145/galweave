// 只创建经验卡：完整写入临时文件后以 hard_link 发布，目标存在时绝不覆盖。
// 独立 std 模块，可用 rustc --test 单独验证文件边界，无需启动桌面应用。
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i,b)| {
        if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_digit() || (b'a'..=b'f').contains(&b) }
    })
}
fn note_path(vault: &str, id: &str, folder: &str) -> Result<PathBuf, String> {
    if !valid_id(id) { return Err("经验卡标识不正确。".into()); }
    let root = Path::new(vault);
    if !root.is_absolute() || !root.is_dir() || !root.join(".obsidian").is_dir() {
        return Err("请选择 Obsidian 库根目录（包含 .obsidian 文件夹）。".into());
    }
    let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let cases = root.join(folder);
    if let Ok(metadata) = fs::symlink_metadata(&cases) {
        if metadata.file_type().is_symlink() { return Err("校对案例目录不能是符号链接。".into()); }
    }
    fs::create_dir_all(&cases).map_err(|e| format!("无法创建校对案例目录：{e}"))?;
    let resolved = fs::canonicalize(&cases).map_err(|e| e.to_string())?;
    if resolved != canonical.join(folder) { return Err("目标目录指向了库外，已停止写入。".into()); }
    let filename = if folder == "校对意见" { format!("校对意见-{id}.md") } else { format!("{id}.md") };
    let path = cases.join(filename);
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.file_type().is_file() { return Err("目标不是普通文件，已停止操作。".into()); }
    }
    Ok(path)
}
pub fn create_note(vault: &str, id: &str, content: &str) -> Result<(String, bool), String> {
    if content.len() > 1024 * 1024 || !content.starts_with("---\ngalnote: 1\n") || !content.contains(&format!("\nid: \"{id}\"\n")) {
        return Err("经验卡内容格式不正确或超过 1 MB。".into());
    }
    create_document(vault, id, content, "校对案例")
}
pub fn create_report(vault: &str, id: &str, content: &str) -> Result<(String, bool), String> {
    if content.len() > 10 * 1024 * 1024 || !content.starts_with("# Galweave 校对意见\n") {
        return Err("校对意见报告格式不正确或超过 10 MB。".into());
    }
    create_document(vault, id, content, "校对意见")
}
fn create_document(vault: &str, id: &str, content: &str, folder: &str) -> Result<(String, bool), String> {
    let path = note_path(vault, id, folder)?;
    let display = path.to_string_lossy().into_owned();
    if path.exists() { return Ok((display, false)); }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let temp = path.with_extension(format!("{}-{}-{}.tmp", std::process::id(), stamp, NEXT.fetch_add(1, Ordering::Relaxed)));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| format!("无法暂存笔记：{e}"))?;
    let written = file.write_all(content.as_bytes()).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = written { let _ = fs::remove_file(&temp); return Err(format!("保存失败，原有笔记未改动：{error}")); }
    // create-new 的原子发布；失败时不退回可能覆盖旧文件的普通 write_file。
    let published = fs::hard_link(&temp, &path);
    let _ = fs::remove_file(&temp);
    match published {
        Ok(()) => Ok((display, true)),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok((display, false)),
        Err(error) => Err(format!("无法安全创建笔记（目录需支持硬链接，例如 NTFS）。可改用下载 Markdown：{error}")),
    }
}
pub fn open_note(vault: &str, id: &str) -> Result<(), String> {
    let path = note_path(vault, id, "校对案例")?;
    if !path.is_file() { return Err("笔记不存在，请先收藏。".into()); }
    let uri = note_uri(&path.to_string_lossy());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", &uri]).creation_flags(0x08000000).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    { std::process::Command::new("open").arg(&uri).spawn().map_err(|e| e.to_string())?; }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    { std::process::Command::new("xdg-open").arg(&uri).spawn().map_err(|e| e.to_string())?; }
    Ok(())
}
fn note_uri(path: &str) -> String {
    let mut encoded = String::new();
    for b in path.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(b) { encoded.push(*b as char); }
        else { encoded.push_str(&format!("%{b:02X}")); }
    }
    format!("obsidian://open?path={encoded}&paneType=tab")
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "01234567-89ab-8def-8123-456789abcdef";
    fn vault() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("galweave-obsidian-test-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
        fs::create_dir_all(dir.join(".obsidian")).unwrap(); dir
    }
    fn content() -> String { format!("---\ngalnote: 1\nid: \"{ID}\"\n---\n原文\\n[player]：日本語") }
    #[test]
    fn repeat_collection_never_overwrites_personal_notes() {
        let root = vault(); let (path,created) = create_note(root.to_str().unwrap(),ID,&content()).unwrap(); assert!(created);
        fs::write(&path,"用户在 Obsidian 添加的心得").unwrap();
        assert!(!create_note(root.to_str().unwrap(),ID,&content()).unwrap().1);
        assert_eq!(fs::read_to_string(path).unwrap(),"用户在 Obsidian 添加的心得");
        assert_eq!(fs::read_dir(root.join("校对案例")).unwrap().count(),1);
    }
    #[test]
    fn invalid_destination_and_traversal_are_rejected() {
        let root = vault();
        assert!(create_note(root.to_str().unwrap(),"../escape",&content()).is_err());
        assert!(create_note("relative",ID,&content()).is_err());
        assert!(create_note(root.to_str().unwrap(),ID,"wrong format").is_err());
        assert!(create_note(root.parent().unwrap().to_str().unwrap(),ID,&content()).is_err());
    }
    #[test]
    fn simultaneous_collection_creates_exactly_one_complete_note() {
        let root = vault(); let mut threads = Vec::new();
        for _ in 0..6 { let dir=root.clone(); threads.push(std::thread::spawn(move || create_note(dir.to_str().unwrap(),ID,&content()).unwrap().1)); }
        let count = threads.into_iter().filter_map(|t| if t.join().unwrap() { Some(()) } else { None }).count();
        assert_eq!(count,1); assert_eq!(fs::read_to_string(root.join("校对案例").join(format!("{ID}.md"))).unwrap(),content());
        assert_eq!(fs::read_dir(root.join("校对案例")).unwrap().count(),1);
    }
    #[test]
    fn uri_encodes_shell_and_query_characters() {
        assert_eq!(note_uri("E:/a & #%.md"),"obsidian://open?path=E%3A%2Fa%20%26%20%23%25.md&paneType=tab");
    }
    #[test]
    fn report_is_saved_separately_and_never_overwrites() {
        let root=vault();let text="# Galweave 校对意见\n\n原文\n旧译\n改译\n意见";
        let (path,created)=create_report(root.to_str().unwrap(),ID,text).unwrap();
        assert!(created);assert!(Path::new(&path).parent().unwrap().ends_with("校对意见"));
        fs::write(&path,"个人补充").unwrap();
        assert!(!create_report(root.to_str().unwrap(),ID,text).unwrap().1);
        assert_eq!(fs::read_to_string(path).unwrap(),"个人补充");
        assert!(!root.join("校对案例").exists());
        assert!(create_report(root.to_str().unwrap(),ID,"错误格式").is_err());
    }
}
