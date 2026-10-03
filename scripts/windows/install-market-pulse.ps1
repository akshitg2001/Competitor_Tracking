param(
  [switch]$Uninstall,
  [switch]$SkipDesktopShortcut,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$dashboardTaskName = "Market Pulse - Dashboard"
$scanTaskName = "Market Pulse - Scheduled Scan"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Market Pulse.lnk"
$managerPath = Join-Path $PSScriptRoot "market-pulse.ps1"
$runtimeConfigPath = Join-Path $projectRoot "data\local-runtime.json"
$runtimeNodeDirectory = Join-Path $projectRoot "data\local-runtime"
$runtimeNodePath = Join-Path $runtimeNodeDirectory "node.exe"

if ($Uninstall) {
  & $managerPath stop | Out-Null
  foreach ($taskName in $dashboardTaskName, $scanTaskName) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  }
  if (Test-Path -LiteralPath $desktopShortcut) { Remove-Item -LiteralPath $desktopShortcut -Force }
  Write-Host "Market Pulse automation was removed. Dashboard data and source files were preserved."
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js is required but was not found." }
$sourceNodePath = $node.Source
$buildScript = Join-Path $projectRoot "scripts\build-local-dashboard.mjs"
$supervisorPath = Join-Path $projectRoot "scripts\local\supervisor.mjs"
$scanRunnerPath = Join-Path $projectRoot "scripts\local\run-scheduled-scan.mjs"

Write-Host "Building the Market Pulse production dashboard..."
& $sourceNodePath $buildScript
if ($LASTEXITCODE -ne 0) { throw "The dashboard production build failed." }

New-Item -ItemType Directory -Force -Path $runtimeNodeDirectory | Out-Null
if (-not (Test-Path -LiteralPath $runtimeNodePath)) {
  Copy-Item -LiteralPath $sourceNodePath -Destination $runtimeNodePath -Force
}
$nodePath = $runtimeNodePath
New-Item -ItemType Directory -Force -Path (Split-Path $runtimeConfigPath) | Out-Null
@{
  nodePath = $nodePath
  projectRoot = $projectRoot
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath $runtimeConfigPath -Encoding UTF8

# Make repeated installs deterministic: stop the previous supervisor and its children
# before replacing the task definitions, then start the new definition below.
& $managerPath stop | Out-Null

$userId = "$env:USERDOMAIN\$env:USERNAME"
$dashboardAction = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$supervisorPath`"" -WorkingDirectory $projectRoot
$dashboardTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$dashboardSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$dashboardPrincipal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$dashboardTask = New-ScheduledTask -Action $dashboardAction -Trigger $dashboardTrigger -Settings $dashboardSettings -Principal $dashboardPrincipal -Description "Keeps the local Market Pulse dashboard and data service running."
Register-ScheduledTask -TaskName $dashboardTaskName -InputObject $dashboardTask -Force | Out-Null

$scanAction = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$scanRunnerPath`"" -WorkingDirectory $projectRoot
$scanTrigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Monday,Wednesday,Friday -At "09:00"
$scanSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10) -ExecutionTimeLimit (New-TimeSpan -Hours 4)
$scanPrincipal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$scanTask = New-ScheduledTask -Action $scanAction -Trigger $scanTrigger -Settings $scanSettings -Principal $scanPrincipal -Description "Runs sequential competitor catalogue scans every Monday, Wednesday and Friday at 9:00 AM."
Register-ScheduledTask -TaskName $scanTaskName -InputObject $scanTask -Force | Out-Null

if (-not $SkipDesktopShortcut) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($desktopShortcut)
  $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$managerPath`" open"
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.Description = "Open Market Pulse"
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,14"
  $shortcut.Save()
}

if (-not $NoStart) {
  & $managerPath start
}

Write-Host ""
Write-Host "Market Pulse automation installed successfully."
Write-Host "Dashboard: http://localhost:5173/"
Write-Host "Scheduled scans: Monday, Wednesday and Friday at 9:00 AM"
Write-Host "Desktop shortcut: $desktopShortcut"
