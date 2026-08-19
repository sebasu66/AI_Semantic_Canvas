$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4318'

function Get-Targets($provider) {
    (Invoke-RestMethod "$base/api/providers/$provider/targets" -TimeoutSec 30).targets
}

function Ensure-Target($provider, $pattern, $url) {
    $targets = Get-Targets $provider
    $found = $targets | Where-Object { $_.url -match $pattern } | Select-Object -First 1
    if ($found) { return $found }
    $body = @{ url = $url } | ConvertTo-Json -Compress
    return (Invoke-RestMethod -Method Post "$base/api/providers/$provider/open" -ContentType 'application/json' -Body $body -TimeoutSec 60).target
}

function Probe($provider, $target, $name, $selectors) {
    $body = @{ targetId = $target.targetId; selectors = $selectors } | ConvertTo-Json -Depth 5 -Compress
    $r = Invoke-RestMethod -Method Post "$base/api/providers/$provider/structure-query" -ContentType 'application/json' -Body $body -TimeoutSec 45
    [pscustomobject]@{
        name = $name
        provider = $provider
        targetId = $target.targetId
        url = $target.url
        queries = $r.queries
    }
}

$gmail = Ensure-Target 'chrome-personal' 'mail\.google\.com' 'https://mail.google.com/mail/u/0/#inbox'
$drive = Ensure-Target 'chrome-personal' 'drive\.google\.com' 'https://drive.google.com/drive/my-drive'
$search = Ensure-Target 'edge-worker' 'google\..*/search' 'https://www.google.com/search?q=AI+semantic+canvas'
$youtube = Ensure-Target 'edge-worker' 'youtube\.com/watch' 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

$result = @(
    Probe 'chrome-personal' $gmail 'gmail' @(
        '[role="main"]',
        '[role="main"] [role="grid"]',
        '[role="main"] [role="grid"] [role="row"]',
        '[role="main"] [role="grid"] [role="gridcell"]',
        'form[role="search"]',
        'input[aria-label="Search mail"]'
    )
    Probe 'chrome-personal' $drive 'drive' @(
        '[role="main"]',
        '[role="main"] [role="grid"]',
        '[role="main"] [role="grid"] [role="row"]',
        '[role="main"] [role="grid"] [role="gridcell"]',
        '[role="main"] [role="list"]',
        '[role="main"] [role="listitem"]'
    )
    Probe 'edge-worker' $search 'google-search' @(
        '#search',
        '#search a:has(h3)',
        '#search h3',
        'form[role="search"]',
        'textarea[name="q"]',
        'input[name="q"]'
    )
    Probe 'edge-worker' $youtube 'youtube-watch' @(
        '#movie_player',
        'video',
        'ytd-watch-metadata',
        'ytd-watch-metadata h1',
        '#secondary'
    )
)

$result | ConvertTo-Json -Depth 10
