$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectPath
$serverPath = Join-Path $projectPath 'server.js'

try {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath (Join-Path $projectPath 'node_modules'))) {
        throw 'Dependencies are missing. Run npm ci first.'
    }
    if (-not $env:PORT) { $env:PORT = '3000' }
    $serverPort = 0
    if (-not [int]::TryParse($env:PORT, [ref]$serverPort) -or $serverPort -lt 1 -or $serverPort -gt 65535) {
        throw 'PORT must be between 1 and 65535.'
    }
    if (-not $env:ADMIN_PASSWORD) {
        Write-Host 'ADMIN_PASSWORD is unset. Enter the development password (e.g. 1234).'
        Write-Host 'Leave empty to disable administrator login.'
        $passwordInput = Read-Host 'Admin password' -AsSecureString
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($passwordInput)
        try { $env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
    }

    # Match only the absolute entry point used by this launcher; never kill all Node processes.
    $entryPattern = '^\s*(?:"[^"]*node\.exe"|\S*node(?:\.exe)?)\s+(?:"' + [regex]::Escape($serverPath) + '"|' + [regex]::Escape($serverPath) + ')\s*$'
    $servers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match $entryPattern })
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $serverPort })
    foreach ($listener in $listeners) {
        if ($listener.OwningProcess -notin $servers.ProcessId) {
            throw "Port $serverPort is used by another process (PID $($listener.OwningProcess)). Stop it manually first."
        }
    }

    Write-Host 'Building browser files...'
    & $npmPath run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed; existing server was not stopped.' }
    foreach ($server in $servers) {
        Write-Host "Stopping server PID $($server.ProcessId)..."
        Stop-Process -Id $server.ProcessId -ErrorAction Stop
        Wait-Process -Id $server.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
    Write-Host 'Starting server. Keep this window open; press Ctrl+C to stop.'
    & $nodePath $serverPath
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
