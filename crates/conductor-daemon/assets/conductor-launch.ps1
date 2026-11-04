# conductor-launch.ps1 (ADR-0021 section 3): what the Windows Scheduled Task runs (MR-T13c). It
# lives in <root>\bin, outside every daemon version, and finds <root> from its own path, so the same
# bytes serve any root. Written by `conductor-daemon service install` (and, from MR-T15, by
# install.ps1) from crates/conductor-daemon/assets/conductor-launch.ps1.
#
# The stopgap of U-114 (MW-T10's .ps1): it supervises, nothing more. MR-T14 adds trial and
# rollback. Task Scheduler has no "restart on this exit code" rule, so the restart policy lives
# here, as systemd's and launchd's do in their units:
#   0 (stopped) and 78 (EXIT_FATAL_AUTH) stop; 75 (restart for update) and anything else restart.
# The loop is unbounded on purpose, like systemd Restart=on-failure and launchd KeepAlive.
# daemon\current is resolved again before every start, so a switched junction takes effect.
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less script as ANSI.
param([int]$RestartDelaySeconds = 5)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$env:CONDUCTOR_ROOT = $root
$env:CONDUCTOR_SUPERVISED = 'schtasks'
$logs = Join-Path $root 'logs'
if (-not (Test-Path -LiteralPath $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$pidFile = Join-Path $logs 'daemon.pid'
$launcherLog = Join-Path $logs 'launcher.log'

function Note([string]$msg) {
  $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  try { [IO.File]::AppendAllText($launcherLog, "[conductor-launch] $now $msg`r`n") } catch { }
}

while ($true) {
  $exe = Join-Path $root 'daemon\current\bin\conductor-daemon.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Note "$exe is missing; retrying in 30s"
    Start-Sleep -Seconds 30
    continue
  }
  # Keep the previous run's log (the crash that caused this restart) as daemon.log.1.
  $log = Join-Path $logs 'daemon.log'
  if (Test-Path -LiteralPath $log) {
    try { Move-Item -LiteralPath $log -Destination ($log + '.1') -Force } catch { Note "cannot rotate ${log}: $_" }
  }
  try {
    $p = Start-Process -FilePath $exe -ArgumentList 'run' -NoNewWindow -PassThru `
      -RedirectStandardError $log -RedirectStandardOutput (Join-Path $logs 'daemon.out.log')
    $null = $p.Handle # without a cached handle, ExitCode can come back empty
    [IO.File]::WriteAllText($pidFile, [string]$p.Id)
    $p.WaitForExit()
    $code = $p.ExitCode
  } catch {
    Note "cannot start ${exe}: $_; retrying in ${RestartDelaySeconds}s"
    Start-Sleep -Seconds $RestartDelaySeconds
    continue
  }
  if ($code -eq 0 -or $code -eq 78) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    exit $code
  }
  Note "daemon exited $code; restarting in ${RestartDelaySeconds}s"
  Start-Sleep -Seconds $RestartDelaySeconds
}
