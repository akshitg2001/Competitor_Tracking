param(
  [ValidateSet("open", "start", "stop", "status")]
  [string]$Action = "open"
)

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$runtimeConfigPath = Join-Path $projectRoot "data\local-runtime.json"
$supervisorPath = Join-Path $projectRoot "scripts\local\supervisor.mjs"
$supervisorStatePath = Join-Path $projectRoot "data\runtime\supervisor.json"
$dashboardTaskName = "Market Pulse - Dashboard"
$dashboardUrl = "http://localhost:5173/"
$dashboardHealthUrl = "http://127.0.0.1:5173/health"
$dataHealthUrl = "http://127.0.0.1:8787/api/health"

function Get-NodePath {
  if (Test-Path -LiteralPath $runtimeConfigPath) {
    $configuration = Get-Content -Raw -LiteralPath $runtimeConfigPath | ConvertFrom-Json
    if ($configuration.nodePath -and (Test-Path -LiteralPath $configuration.nodePath)) { return $configuration.nodePath }
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { return $node.Source }
  throw "Node.js could not be found. Re-run scripts\windows\install-market-pulse.ps1."
}

function Test-Url([string]$Url) {
  try { return (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}

function Get-RuntimeStatus {
  [pscustomobject]@{
    Dashboard = if (Test-Url $dashboardHealthUrl) { "Running" } else { "Stopped" }
    DataService = if (Test-Url $dataHealthUrl) { "Running" } else { "Stopped" }
    Address = $dashboardUrl
  }
}

function Wait-ForRuntime([int]$Seconds = 45) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if ((Test-Url $dashboardHealthUrl) -and (Test-Url $dataHealthUrl)) { return $true }
    Start-Sleep -Milliseconds 750
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Start-Runtime {
  if ((Test-Url $dashboardHealthUrl) -and (Test-Url $dataHealthUrl)) { return }
  $task = Get-ScheduledTask -TaskName $dashboardTaskName -ErrorAction SilentlyContinue
  if ($task) {
    if ($task.State -ne "Running") { Start-ScheduledTask -TaskName $dashboardTaskName }
  } else {
    $nodePath = Get-NodePath
    Start-Process -FilePath $nodePath -ArgumentList @($supervisorPath) -WorkingDirectory $projectRoot -WindowStyle Hidden
  }
  if (-not (Wait-ForRuntime)) {
    throw "Market Pulse did not become healthy within 45 seconds. Check data\logs for details."
  }
}

function Stop-Runtime {
  $processIds = @()
  if (Test-Path -LiteralPath $supervisorStatePath) {
    try {
      $state = Get-Content -Raw -LiteralPath $supervisorStatePath | ConvertFrom-Json
      foreach ($service in $state.services.PSObject.Properties.Value) {
        if ($service.pid) { $processIds += [int]$service.pid }
      }
      if ($state.pid) { $processIds += [int]$state.pid }
    } catch { }
  }
  $task = Get-ScheduledTask -TaskName $dashboardTaskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq "Running") { Stop-ScheduledTask -TaskName $dashboardTaskName }
  foreach ($processId in $processIds) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  foreach ($fileName in "supervisor.lock", "supervisor.json", "supervisor-heartbeat.json") {
    Remove-Item -LiteralPath (Join-Path $projectRoot "data\runtime\$fileName") -Force -ErrorAction SilentlyContinue
  }
}

switch ($Action) {
  "start" { Start-Runtime; Get-RuntimeStatus | Format-List }
  "open" { Start-Runtime; Start-Process $dashboardUrl }
  "stop" { Stop-Runtime; Start-Sleep -Seconds 1; Get-RuntimeStatus | Format-List }
  "status" { Get-RuntimeStatus | Format-List }
}
