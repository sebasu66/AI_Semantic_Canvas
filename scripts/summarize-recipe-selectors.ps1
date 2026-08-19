$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4318'

function Get-Targets($provider) { (Invoke-RestMethod "$base/api/providers/$provider/targets" -TimeoutSec 30).targets }
function Pick($provider, $pattern) { Get-Targets $provider | Where-Object { $_.url -match $pattern } | Select-Object -First 1 }
function Query($provider, $target, $name, $selectors) {
    $body = @{ targetId = $target.targetId; selectors = $selectors } | ConvertTo-Json -Depth 5 -Compress
    $r = Invoke-RestMethod -Method Post "$base/api/providers/$provider/structure-query" -ContentType 'application/json' -Body $body -TimeoutSec 45
    [pscustomobject]@{
        name = $name
        url = $target.url
        queries = @($r.queries | ForEach-Object {
            $s = @($_.samples | Select-Object -First 1)[0]
            [pscustomobject]@{
                selector = $_.selector
                count = $_.count
                visibleCount = $_.visibleCount
                sample = if ($s) { [pscustomobject]@{ tag=$s.tag; role=$s.role; id=$s.id; classTokens=$s.classTokens; bbox=$s.bbox; childCount=$s.childCount; interactiveCount=$s.interactiveCount; textLength=$s.textLength } } else { $null }
            }
        })
    }
}

$gmail = Pick 'chrome-personal' 'mail\.google\.com'
$drive = Pick 'chrome-personal' 'drive\.google\.com'
$search = Pick 'edge-worker' 'google\..*/search'
$youtube = Pick 'edge-worker' 'youtube\.com/watch'

$result = @(
    Query 'chrome-personal' $gmail 'gmail' @('[role="main"] [role="grid"]','[role="main"] [role="grid"] [role="row"]','form[role="search"]','input[aria-label="Search mail"]')
    Query 'chrome-personal' $drive 'drive' @('[role="main"]','[role="main"] [role="grid"]','[role="main"] [role="grid"] [role="row"]','[role="main"] [role="grid"] [role="gridcell"]','[role="main"] [role="listitem"]')
    Query 'edge-worker' $search 'google-search' @('#search','#search a:has(h3)','#search h3','form[role="search"]','textarea[name="q"]','input[name="q"]')
    Query 'edge-worker' $youtube 'youtube-watch' @('#movie_player','video','ytd-watch-metadata','ytd-watch-metadata h1','#secondary')
)
$result | ConvertTo-Json -Depth 8
