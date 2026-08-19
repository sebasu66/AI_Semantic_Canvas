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

function Get-Structure($provider, $target, $name) {
    $body = @{ targetId = $target.targetId } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Method Post "$base/api/providers/$provider/discovery" -ContentType 'application/json' -Body $body -TimeoutSec 45
    $landmarks = @($r.discovery.landmarks | Select-Object -First 140 | ForEach-Object {
        [pscustomobject]@{
            tag = $_.tag
            role = $_.role
            ariaLabel = $_.ariaLabel
            id = $_.id
            classTokens = $_.classTokens
            bbox = $_.bbox
            childCount = $_.childCount
            interactiveCount = $_.interactiveCount
            # Deliberately omit textSample so personal message/file content is not exported.
        }
    })
    return [pscustomobject]@{
        name = $name
        provider = $provider
        targetId = $target.targetId
        url = $r.discovery.url
        title = $r.discovery.title
        viewport = $r.discovery.viewport
        roleCounts = $r.discovery.roleCounts
        tagCounts = $r.discovery.tagCounts
        landmarks = $landmarks
        cache = $r.cache
        hasCachedRecipe = [bool]$r.cachedRecipe
    }
}

$gmail = Ensure-Target 'chrome-personal' 'mail\.google\.com' 'https://mail.google.com/mail/u/0/#inbox'
$drive = Ensure-Target 'chrome-personal' 'drive\.google\.com' 'https://drive.google.com/drive/my-drive'
$search = Ensure-Target 'edge-worker' 'google\..*/search' 'https://www.google.com/search?q=AI+semantic+canvas'
$youtube = Ensure-Target 'edge-worker' 'youtube\.com/watch' 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

$result = @(
    Get-Structure 'chrome-personal' $gmail 'gmail'
    Get-Structure 'chrome-personal' $drive 'drive'
    Get-Structure 'edge-worker' $search 'google-search'
    Get-Structure 'edge-worker' $youtube 'youtube-watch'
)

$result | ConvertTo-Json -Depth 9
