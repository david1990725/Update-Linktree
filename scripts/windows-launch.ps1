$ErrorActionPreference = 'Stop'
try {
  $project = Split-Path -Parent $PSScriptRoot
  Set-Location -LiteralPath $project
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { throw '找不到 Node.js。請先安裝 Node.js，關閉並重新開啟視窗後再試。' }
  if (-not (Test-Path 'dashboard.js') -or -not (Test-Path 'node_modules')) { throw '找不到程式或套件。請將啟動程式放在專案資料夾，並先依說明完成 Windows 安裝。' }
  New-Item -ItemType Directory -Path 'data' -Force | Out-Null
  $urlFile = Join-Path $project 'data\dashboard-url'
  function Open-Existing {
    if (-not (Test-Path -LiteralPath $urlFile)) { return $false }
    $url = (Get-Content -LiteralPath $urlFile -Raw).Trim()
    if ($url -notmatch '^http://127\.0\.0\.1:\d+/#([0-9a-f]{64})$') { return $false }
    $token = $Matches[1]
    $origin = $url.Split('#')[0].TrimEnd('/')
    try {
      Invoke-RestMethod -Uri "$origin/api/status" -Headers @{ 'X-Dashboard-Token' = $token } -TimeoutSec 2 | Out-Null
      Start-Process $url
      return $true
    } catch { return $false }
  }
  if (Open-Existing) { exit 0 }
  $proc = Start-Process -FilePath $node.Source -ArgumentList 'dashboard.js' -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $project 'data\dashboard.log') -RedirectStandardError (Join-Path $project 'data\dashboard-error.log')
  for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 200
    if (Open-Existing) { exit 0 }
    $proc.Refresh()
    if ($proc.HasExited) { throw '無法啟動同步工具，請查看 data\dashboard-error.log。' }
  }
  throw '同步工具啟動逾時，請查看 data\dashboard-error.log。'
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '每月活動同步') | Out-Null
  exit 1
}
