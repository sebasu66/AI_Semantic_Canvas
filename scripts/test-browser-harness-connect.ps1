$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dap = Join-Path $env:LOCALAPPDATA 'Google/Chrome/User Data/DevToolsActivePort'
if (-not (Test-Path $dap)) { throw "DevToolsActivePort not found: $dap" }

$lines = Get-Content $dap
if ($lines.Count -lt 2) { throw 'DevToolsActivePort is incomplete' }
$port = [int]$lines[0]
$path = [string]$lines[1]
$wsUrl = "ws://127.0.0.1:$port$path"

$js = @"
await session.connect({wsUrl: '$wsUrl', timeoutMs: 30000});
const targets = await listPageTargets();
({ connected: session.isConnected(), targets })
"@

try {
    $response = Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:9876/eval' -ContentType 'text/plain; charset=utf-8' -Body $js -UseBasicParsing -TimeoutSec 40
    [pscustomobject]@{
        ok = $true
        wsUrl = $wsUrl
        status = [int]$response.StatusCode
        body = $response.Content
    } | ConvertTo-Json -Depth 10
}
catch {
    $status = $null
    $body = ''
    if ($_.Exception.Response) {
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $body = $reader.ReadToEnd()
                $reader.Dispose()
            }
        } catch {}
    }
    [pscustomobject]@{
        ok = $false
        wsUrl = $wsUrl
        status = $status
        error = $_.Exception.Message
        body = $body
    } | ConvertTo-Json -Depth 10
    exit 1
}
