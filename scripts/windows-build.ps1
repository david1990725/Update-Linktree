$ErrorActionPreference = 'Stop'
try {
  $project = Split-Path -Parent $PSScriptRoot
  $source = Join-Path $PSScriptRoot 'WindowsLauncher.cs'
  $output = Join-Path $project 'MonthlySync.exe'
  if (Test-Path -LiteralPath $output) { throw 'MonthlySync.exe 已存在；請先移走或刪除舊版本。' }
  Add-Type -Path $source -ReferencedAssemblies 'System.Windows.Forms.dll' -OutputAssembly $output -OutputType WindowsApplication
  Write-Host '已建立 MonthlySync.exe。請在專案資料夾內雙擊使用。'
} catch {
  Write-Host ('建立失敗：' + $_.Exception.Message)
  exit 1
}
