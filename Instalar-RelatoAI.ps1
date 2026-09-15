$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = Join-Path $env:LOCALAPPDATA "RelatoAI"
$app = Join-Path $base "app"
New-Item $app -ItemType Directory -Force | Out-Null
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '\\RelatoAI\\app\\.*RelatoAI\.DesktopAgent' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Milliseconds 500
Get-ChildItem $app -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
$wsh = New-Object -ComObject WScript.Shell
$startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\Relato AI Desktop Agent.lnk"
if ($dotnet) {
  Copy-Item (Join-Path $here "Agent-FrameworkDependent\*") $app -Recurse -Force
  $target = $dotnet.Source
  $args = '"' + (Join-Path $app "RelatoAI.DesktopAgent.dll") + '"'
  Start-Process $target -ArgumentList $args
} else {
  Copy-Item (Join-Path $here "Agent-SelfContained\RelatoAI.DesktopAgent.exe") (Join-Path $app "RelatoAI.DesktopAgent.exe") -Force
  $target = Join-Path $app "RelatoAI.DesktopAgent.exe"
  $args = ""
  Start-Process $target
}
$shortcut = $wsh.CreateShortcut($startup)
$shortcut.TargetPath = $target
$shortcut.Arguments = $args
$shortcut.WorkingDirectory = $app
$shortcut.Save()
Write-Host "Relato AI instalado. Pareamento preservado em $base\desktop-agent.json."
Write-Host "Extensao Chrome: $here\Extension"