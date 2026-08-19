$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tools = Join-Path $root '.tools'
$harness = Join-Path $tools 'browser-harness-js'
$runtime = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force -Path $tools, $runtime | Out-Null

if (-not (Test-Path (Join-Path $harness '.git'))) {
    git.exe clone --depth 1 https://github.com/browser-use/browser-harness-js.git $harness
    if ($LASTEXITCODE -ne 0) { throw 'browser-harness-js clone failed' }
} else {
    git.exe -C $harness fetch origin main
    git.exe -C $harness reset --hard origin/main
}

$bunCmd = Get-Command bun.exe -ErrorAction SilentlyContinue
$bunPath = if ($bunCmd) { $bunCmd.Source } else { Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
if (-not (Test-Path $bunPath)) {
    $installer = Invoke-RestMethod -Uri 'https://bun.sh/install.ps1' -TimeoutSec 30
    Invoke-Expression $installer
    $bunPath = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
}
if (-not (Test-Path $bunPath)) { throw 'Bun installation not found after setup' }

$replPort = 9876
$existing = Get-NetTCPConnection -LocalPort $replPort -State Listen -ErrorAction SilentlyContinue
if (-not $existing) {
    $stdout = Join-Path $runtime 'browser-harness-js.log'
    $stderr = Join-Path $runtime 'browser-harness-js.err.log'
    Start-Process -FilePath $bunPath `
        -ArgumentList @((Join-Path $harness 'sdk\repl.ts')) `
        -WorkingDirectory (Join-Path $harness 'sdk') `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -WindowStyle Hidden | Out-Null
}

$health = $null
for ($i = 0; $i -lt 60; $i++) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$replPort/health" -TimeoutSec 2
        if ($health.ok) { break }
    } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $health -or -not $health.ok) {
    $errFile = Join-Path $runtime 'browser-harness-js.err.log'
    $detail = if (Test-Path $errFile) { Get-Content $errFile -Raw } else { 'no stderr' }
    throw "Browser Harness REPL failed to start: $detail"
}

$code = @'
await session.connect({timeoutMs:30000});
const targets = await listPageTargets();
({ connected: session.isConnected(), targets })
'@

$response = Invoke-WebRequest `
    -Method Post `
    -Uri "http://127.0.0.1:$replPort/eval" `
    -ContentType 'text/plain; charset=utf-8' `
    -Body $code `
    -UseBasicParsing `
    -TimeoutSec 45

[pscustomobject]@{
    ok = $true
    bun = (& $bunPath --version)
    harness_dir = $harness
    health = $health
    response = $response.Content
} | ConvertTo-Json -Depth 8
