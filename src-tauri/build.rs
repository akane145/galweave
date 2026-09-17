fn main() {
    // tauri-build 默认不监视 icons/，图标替换后不会重新嵌入 exe（需显式触发）
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
