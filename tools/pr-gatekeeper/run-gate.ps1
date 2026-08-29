<#
    Gatekeeper runner.

    Runs one gate pass over every open pull request from the dedicated
    worktree. Wire it into Task Scheduler for a watcher that survives this
    machine rebooting and does not depend on any editor session staying open.

    Setup, once, from an elevated PowerShell:

      $action  = New-ScheduledTaskAction -Execute "pwsh.exe" `
                   -Argument "-NoProfile -File <checkout>\tools\pr-gatekeeper\run-gate.ps1"
      $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
                   -RepetitionInterval (New-TimeSpan -Minutes 10)
      Register-ScheduledTask -TaskName "farlands-pr-gatekeeper" -Action $action -Trigger $trigger

    Every run appends to gate.log next to this script.
#>

$ErrorActionPreference = "Stop"

# Override with FARLANDS_GATE_WORKTREE if the worktree lives elsewhere.
$Worktree = if ($env:FARLANDS_GATE_WORKTREE) { $env:FARLANDS_GATE_WORKTREE } else { Join-Path (Split-Path (Split-Path (Split-Path $PSScriptRoot))) "pr-gatekeeper" }
$LogFile  = Join-Path $PSScriptRoot "gate.log"

function Write-Log([string]$Message) {
    $stamp = (Get-Date).ToString("s")
    Add-Content -Path $LogFile -Value "$stamp  $Message" -Encoding utf8
}

if (-not (Test-Path $Worktree)) {
    Write-Log "worktree missing at $Worktree, create it with: git worktree add --detach $Worktree main"
    exit 1
}

Set-Location $Worktree

# Always gate against current main. The worktree is detached, so this is a
# fast forward of the checkout rather than a branch update.
& git fetch --quiet origin main
& git checkout --quiet --detach origin/main
& bun install --frozen-lockfile 2>&1 | Out-Null

$output = & bun run tools/pr-gatekeeper/src/index.ts 2>&1
$code = $LASTEXITCODE

foreach ($line in $output) { Write-Log $line }
Write-Log "exit $code"

exit $code
