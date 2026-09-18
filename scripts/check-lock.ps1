# PowerShell 需要此文件以 UTF-8 BOM 开头，否则中文路径会按 ANSI 误读
Get-Process | Where-Object { $_.Name -like '*galtrans*' -or $_.Name -like '*galweave*' } | Select-Object Name, Id, Path | Format-List
Write-Host "--- file locks on target exe ---"
$p1 = "E:\Workbuddy\galweave - 副本\src-tauri\target\release\galweave.exe"
try {
  $fs = [System.IO.File]::Open($p1, 'Open', 'ReadWrite', 'None')
  $fs.Close()
  Write-Host "galweave.exe: NOT locked"
} catch {
  Write-Host "galweave.exe: LOCKED -> $($_.Exception.Message)"
}
$p2 = "E:\Workbuddy\galweave - 副本\src-tauri\target\release\bundle\nsis\Galweave_5.3.1_x64-setup.exe"
try {
  $fs = [System.IO.File]::Open($p2, 'Open', 'ReadWrite', 'None')
  $fs.Close()
  Write-Host "setup.exe: NOT locked"
} catch {
  Write-Host "setup.exe: LOCKED -> $($_.Exception.Message)"
}
