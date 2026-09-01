# watch-sync.ps1 — 监控 cloudflare 开发目录,自动 git 提交并推送到 GitHub。
# 通过 site\cloudflare junction 实时同步;变化后防抖 5 秒,自动 commit + push。
$ErrorActionPreference = 'Stop'

$devDir   = 'D:\codex  use\cloudflare'
$repoDir  = 'D:\codex  use\site'
$gitExe   = 'D:\codex  use\Git\bin\git.exe'
$logFile  = 'D:\codex  use\cloudflare\sync.log'

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

Write-Log "watcher 启动,监控: $devDir"

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $devDir
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor
                        [System.IO.NotifyFilters]::FileName -bor
                        [System.IO.NotifyFilters]::DirectoryName -bor
                        [System.IO.NotifyFilters]::Size

$timer = New-Object System.Timers.Timer
$timer.Interval = 5000  # 防抖窗口
$timer.AutoReset = $false

$script:changed = $false

$action = {
  $script:changed = $true
  $timer.Stop()
  $timer.Start()
}

Register-ObjectEvent -InputObject $watcher -EventName Changed -Action $action | Out-Null
Register-ObjectEvent -InputObject $watcher -EventName Created  -Action $action | Out-Null
Register-ObjectEvent -InputObject $watcher -EventName Deleted  -Action $action | Out-Null
Register-ObjectEvent -InputObject $watcher -EventName Renamed  -Action $action | Out-Null

# 防抖到期后的提交动作
$commitAction = {
  $timer.Stop()
  if (-not $script:changed) { return }
  $script:changed = $false

  # 忽略 .wrangler 与日志自身的变化
  $status = & $gitExe -C $repoDir status --porcelain 2>&1
  $relevant = $status | Where-Object { $_ -notmatch '\.wrangler|sync\.log' }
  if (-not $relevant) { return }

  Write-Log "检测到变更,提交中..."
  & $gitExe -C $repoDir add -A 2>&1 | Out-Null
  & $gitExe -C $repoDir commit -m "auto-sync: $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>&1 | ForEach-Object { Write-Log $_ }
  & $gitExe -C $repoDir push origin main 2>&1 | ForEach-Object { Write-Log $_ }
  Write-Log "推送完成"
}

$timerEvent = Register-ObjectEvent -InputObject $timer -EventName Elapsed -Action $commitAction

$watcher.EnableRaisingEvents = $true
Write-Log "监控中(Ctrl+C 退出)。变更后 5 秒内自动提交并推送。"

try {
  while ($true) { Start-Sleep -Seconds 1 }
} finally {
  $watcher.EnableRaisingEvents = $false
  $watcher.Dispose()
  $timer.Dispose()
}
