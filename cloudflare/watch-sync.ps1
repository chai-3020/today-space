# watch-sync.ps1 — 轮询监控 cloudflare 目录,自动 git 提交并推送到 GitHub。
# 每 5 秒检查一次变更,发现后自动 commit + push(防抖 2 轮)。
$ErrorActionPreference = 'Continue'

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
  $status = & $gitExe -C $repoDir status --porcelain 2>$null
  return @($status | Where-Object { $_ -match '^ M|^\?\?|^A |^M |^ D|^D ' -and $_ -notmatch '\.wrangler|sync\.log' })
}

function Invoke-Git($argsList) {
  $output = & $gitExe -C $repoDir @argsList 2>&1
  $code = $LASTEXITCODE
  return [pscustomobject]@{ Code = $code; Output = $output }
}

Write-Log 'watcher 启动(轮询模式)'

$quietRounds = 0
while ($true) {
  Start-Sleep -Seconds $pollSec
  $changes = Get-RelevantStatus
  if ($changes.Count -gt 0) {
    $quietRounds++
    if ($quietRounds -ge 2) {
      $quietRounds = 0
      Write-Log ('检测到变更(' + $changes.Count + ' 项)')
      $add = Invoke-Git @('add', '-A')
      $msg = 'auto-sync: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')
      $cm = Invoke-Git @('commit', '-m', $msg)
      if ($cm.Code -eq 0) { Write-Log ('已提交: ' + ($cm.Output | Out-String).Trim()) }
      $ps = Invoke-Git @('push', 'origin', 'main')
      if ($ps.Code -eq 0) { Write-Log '推送完成' } else { Write-Log ('推送失败: ' + ($ps.Output | Out-String).Trim()) }
    }
  } else {
    $quietRounds = 0
  }
}
