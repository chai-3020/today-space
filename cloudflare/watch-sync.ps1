# watch-sync.ps1 — 轮询监控 cloudflare 目录,自动 git 提交并推送到 GitHub。
# 每 5 秒检查一次变更,发现后自动 commit + push(防抖 3 次确认)。
$ErrorActionPreference = 'Stop'

$devDir  = 'D:\codex  use\cloudflare'
$repoDir = 'D:\codex  use\site'
$gitExe  = 'D:\codex  use\Git\bin\git.exe'
$logFile = 'D:\codex  use\cloudflare\sync.log'
$pollSec = 5

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  try { Add-Content -Path $logFile -Value $line } catch { }
  Write-Host $line
}

function Get-RelevantStatus {
  $status = & $gitExe -C $repoDir status --porcelain 2>&1
  # 忽略 .wrangler 和 sync.log 自身
  return @($status | Where-Object { $_ -match '^ M|^\?\?|^A |^M |^ D|^D ' -and $_ -notmatch '\.wrangler|sync\.log' })
}

Write-Log 'watcher 启动(轮询模式)'

$quietRounds = 0
while ($true) {
  Start-Sleep -Seconds $pollSec
  $changes = Get-RelevantStatus
  if ($changes.Count -gt 0) {
    $quietRounds++
    if ($quietRounds -ge 2) {  # 连续两次检测到(防抖),避免写入中提交
      $quietRounds = 0
      Write-Log ('检测到变更(' + $changes.Count + ' 项):' + ($changes -join '; '))
      & $gitExe -C $repoDir add -A 2>&1 | Out-Null
      $msg = 'auto-sync: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
      & $gitExe -C $repoDir commit -m $msg 2>&1 | ForEach-Object { Write-Log $_ }
      & $gitExe -C $repoDir push origin main 2>&1 | ForEach-Object { Write-Log $_ }
      Write-Log '推送完成'
    }
  } else {
    $quietRounds = 0
  }
}
