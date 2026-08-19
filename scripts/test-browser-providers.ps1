$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

$report = [ordered]@{
    build = $null
    bridge = $null
    providers = $null
    chrome = $null
    edge = $null
    edgeOpen = $null
}

function Capture-Step([string]$name, [scriptblock]$action) {
    try {
        $value = & $action
        $report[$name] = [ordered]@{ ok = $true; value = $value }
        return $value
    }
    catch {
        $report[$name] = [ordered]@{
            ok = $false
            error = $_.Exception.Message
            detail = ($_ | Out-String)
        }
        return $null
    }
}

# Clean only the dedicated isolated Edge worker from prior attempts.
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*edge-worker-profile*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Stop the dedicated Edge Browser Harness REPL if it exists.
try { Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:9877/quit' -UseBasicParsing -TimeoutSec 2 | Out-Null } catch {}
Start-Sleep -Milliseconds 400

$buildOutput = Capture-Step 'build' {
    Push-Location $root
    try {
        $out = & npm.cmd run build 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
        return ($out | Select-Object -Last 12) -join "`n"
    }
    finally { Pop-Location }
}
if (-not $report.build.ok) {
    $report | ConvertTo-Json -Depth 12
    exit 1
}

# Restart bridge on the freshly-built code.
Get-NetTCPConnection -LocalPort 4318 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400

Start-Process -FilePath 'node.exe' `
    -ArgumentList @('apps/bridge/dist/index.js') `
    -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $runtime 'bridge-provider.log') `
    -RedirectStandardError (Join-Path $runtime 'bridge-provider.err.log') `
    -WindowStyle Hidden | Out-Null

$bridgeHealth = Capture-Step 'bridge' {
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $h = Invoke-RestMethod 'http://127.0.0.1:4318/api/health' -TimeoutSec 2
            if ($h.ok) { return $h }
        } catch {}
        Start-Sleep -Milliseconds 250
    }
    throw 'Bridge did not become healthy'
}
if (-not $report.bridge.ok) {
    $report | ConvertTo-Json -Depth 12
    exit 1
}

Capture-Step 'providers' {
    return (Invoke-RestMethod 'http://127.0.0.1:4318/api/providers' -TimeoutSec 10).providers
} | Out-Null

Capture-Step 'chrome' {
    $r = Invoke-RestMethod -Method Post `
        -Uri 'http://127.0.0.1:4318/api/providers/chrome-personal/connect' `
        -ContentType 'application/json' -Body '{}' -TimeoutSec 45
    return [ordered]@{ status = $r.status; targets = $r.targets }
} | Out-Null

Capture-Step 'edge' {
    $r = Invoke-RestMethod -Method Post `
        -Uri 'http://127.0.0.1:4318/api/providers/edge-worker/connect' `
        -ContentType 'application/json' -Body '{}' -TimeoutSec 60
    return [ordered]@{ status = $r.status; targets = $r.targets }
} | Out-Null

if ($report.edge.ok) {
    Capture-Step 'edgeOpen' {
        $r = Invoke-RestMethod -Method Post `
            -Uri 'http://127.0.0.1:4318/api/providers/edge-worker/open' `
            -ContentType 'application/json' `
            -Body '{"url":"https://example.com"}' -TimeoutSec 60
        return [ordered]@{
            target = $r.target
            sourceKind = $r.sourceKind
            semanticCount = @($r.semanticObjects).Count
            title = $r.snapshot.title
            url = $r.snapshot.url
        }
    } | Out-Null
}

$report | ConvertTo-Json -Depth 12
if (-not $report.chrome.ok -or -not $report.edge.ok -or -not $report.edgeOpen.ok) { exit 1 }
