$node = 'C:\Users\30203\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\node.exe'
$fail = 0
Get-ChildItem 'D:\codex  use\mini-program' -Recurse -Filter '*.js' | Where-Object { $_.FullName -notmatch 'node_modules' } | ForEach-Object {
  $out = & $node --check $_.FullName 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { "FAIL " + $_.Name; ($out -split [char]10 | Select-Object -First 5) | ForEach-Object { "   " + $_ }; $fail++ }
}
"JS failures: " + $fail
"--- pomodoro.js 关键函数存在性 ---"
$js = [System.IO.File]::ReadAllText('D:\codex  use\mini-program\pages\pomodoro\pomodoro.js', [System.Text.UTF8Encoding]::new($false))
foreach ($fn in @('loadCustomModes','openCustom','saveCustom','loadSessions','onSessionComplete','recordSession','hourMarks','refreshNowLine')) {
  if ($js.Contains($fn)) { "OK " + $fn } else { "MISSING " + $fn }
}
"--- wxml 引用与 js 一致性 ---"
$wxml = [System.IO.File]::ReadAllText('D:\codex  use\mini-program\pages\pomodoro\pomodoro.wxml', [System.Text.UTF8Encoding]::new($false))
foreach ($h in @('onMode','onToggle','onReset','openCustom','closeCustom','saveCustom','onCFocus','onCShort','onCLong','noop')) {
  $pat = 'bindtap="' + $h + '"'
  if ($wxml.Contains($pat)) { "OK bind " + $h } else { "MISSING bind " + $h }
}
