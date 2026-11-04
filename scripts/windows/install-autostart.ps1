#Requires -RunAsAdministrator
# Makes the dashboard start automatically when Windows boots (nobody needs to log in).
# Run from an Administrator PowerShell in the project folder:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1

param([string]$TaskName = "ReviewsDashboard")
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$startScript = Join-Path $PSScriptRoot "start-server.cmd"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js was not found. Install Node.js 22 LTS from https://nodejs.org first." }
if (-not (Test-Path (Join-Path $root "node_modules"))) { throw "Run 'npm install' in $root first." }
if (-not (Test-Path (Join-Path $root ".env"))) { throw "Create $root\.env first (copy .env.example and fill it in)." }
New-Item -ItemType Directory -Force (Join-Path $root "data") | Out-Null

$action = New-ScheduledTaskAction -Execute $startScript -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U = run as you, whether or not you're logged in, without storing your password.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
# ExecutionTimeLimit 0 = run forever (the Windows default would stop it after 3 days).
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Done. '$TaskName' now starts the dashboard every time Windows boots." -ForegroundColor Green
Write-Host "Logs: $root\data\server.log"
Write-Host "Local check: http://localhost:3000/healthz"
