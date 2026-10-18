param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectPath
$wranglerPath = Join-Path $projectPath 'node_modules\wrangler\bin\wrangler.js'
$cliPath = Join-Path $projectPath 'node_modules\wrangler\wrangler-dist\cli.js'
$configPath = Join-Path $projectPath 'wrangler.jsonc'
$serverPort = 8787
$serverUrl = 'http://127.0.0.1:8787/'

try {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath $wranglerPath)) {
        throw 'Dependencies are missing. Run npm ci first.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectPath '.dev.vars.local'))) {
        throw 'Local settings are missing. Run npm run workers:setup first.'
    }
    # Match the actual Wrangler CLI entry point, not arbitrary command text or all Node processes.
    $entryPattern = '^\s*(?:"[^"]*node(?:\.exe)?"|\S*node(?:\.exe)?)\s+(?:--no-warnings\s+)?(?:"' + [regex]::Escape($cliPath) + '"|' + [regex]::Escape($cliPath) + ')\s+dev\s+'
    $processes = @(Get-CimInstance Win32_Process)
    $servers = @($processes | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -match $entryPattern -and
        $_.CommandLine -match '(?:^|\s)--local(?:\s|$)' -and
        $_.CommandLine -match '(?:^|\s)--env\s+local(?:\s|$)'
    })
    $targets = @($servers)
    do {
        $children = @($processes | Where-Object { $_.ParentProcessId -in $targets.ProcessId -and $_.ProcessId -notin $targets.ProcessId })
        $targets += $children
    } while ($children.Count -gt 0)
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $serverPort })
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess -notin $targets.ProcessId) {
            throw "Port $serverPort is used by an unrecognized process (PID $($listener.OwningProcess)). Stop it manually first."
        }
    }
    if ($CheckOnly) {
        Write-Host "Workers local restart check OK: $serverUrl"
        Write-Host "Matching Wrangler servers: $($servers.Count)"
        exit 0
    }
    Write-Host 'Building Workers assets...'
    & $npmPath run build:workers
    if ($LASTEXITCODE -ne 0) { throw 'Build failed; existing server was not stopped.' }
    # Stop supervisors first, then only their captured descendants. Recheck identity against PID reuse.
    foreach ($target in $targets) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.ProcessId)"
        if ($current -and $current.CreationDate -eq $target.CreationDate -and $current.CommandLine -eq $target.CommandLine) {
            Write-Host "Stopping local Workers process PID $($target.ProcessId)..."
            Stop-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
            Wait-Process -Id $target.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
    Write-Host "Starting Workers: $serverUrl"
    Write-Host 'Settings: .dev.vars.local / Database: .wrangler/state'
    Write-Host 'Keep this window open; press Ctrl+C to stop.'
    & $nodePath $wranglerPath dev --local --env local --config $configPath --ip 127.0.0.1 --port $serverPort
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
