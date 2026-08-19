$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4318'
$now = (Get-Date).ToUniversalTime().ToString('o')

$recipes = @(
    @{
        schemaVersion = 1
        id = 'gmail-inbox-v1'
        host = 'mail.google.com'
        routePattern = '/mail/u/:id/#inbox'
        generatedBy = 'ai'
        generatedAt = $now
        model = 'GPT-5.6 Sol'
        notes = 'Learned from structural roles on the authenticated Gmail inbox. Uses ARIA grid/row landmarks rather than Gmail CSS classes.'
        validation = @{ mustExist = @('[role="main"] [role="grid"]','[role="main"] [role="grid"] [role="row"]','form[role="search"]'); minWidgetCount = 2 }
        widgets = @(
            @{
                id='gmail-search'; type='form'; label='Search'; representation='data'; root='form[role="search"]'
                title=@{ static='Search mail' }
                description=@{ selector='input[aria-label="Search mail"]'; property='value'; fallback='Search your mail' }
            },
            @{
                id='gmail-inbox'; type='mail-list'; label='Inbox'; representation='data'; root='[role="main"] [role="grid"]'
                title=@{ static='Inbox' }; description=@{ static='Visible conversations' }
                itemSelector='[role="row"]'; fields=@(@{name='thread';maxLength=280}); displayFields=@('thread')
                itemAction=@{kind='click';selector='[role="main"] [role="grid"] [role="row"]';label='Open conversation'}
                maxItems=20; minItems=3
            }
        )
    },
    @{
        schemaVersion = 1
        id = 'google-drive-my-drive-v1'
        host = 'drive.google.com'
        routePattern = '/drive/my-drive'
        generatedBy = 'ai'
        generatedAt = $now
        model = 'GPT-5.6 Sol'
        notes = 'Learned from the authenticated Drive grid. Each visible gridcell is a file/folder tile or row item.'
        validation = @{ mustExist = @('[role="main"] [role="grid"]','[role="main"] [role="grid"] [role="gridcell"]'); minWidgetCount = 1 }
        widgets = @(
            @{
                id='drive-files'; type='drive-grid'; label='Google Drive'; representation='data'; root='[role="main"] [role="grid"]'
                title=@{ static='My Drive' }; description=@{ static='Visible files and folders' }
                itemSelector='[role="gridcell"]'; fields=@(@{name='file';maxLength=180}); displayFields=@('file')
                itemAction=@{kind='click';selector='[role="main"] [role="grid"] [role="gridcell"]';label='Open item'}
                maxItems=30; minItems=3
            }
        )
    },
    @{
        schemaVersion = 1
        id = 'google-search-v1'
        host = 'www.google.com'
        routePattern = '/search'
        generatedBy = 'ai'
        generatedAt = $now
        model = 'GPT-5.6 Sol'
        notes = 'Learned from Google Search. Separates the query control from organic result anchors containing h3 titles.'
        validation = @{ mustExist = @('form[role="search"]','textarea[name="q"]','#search','#search a:has(h3)'); minWidgetCount = 2 }
        widgets = @(
            @{
                id='google-query'; type='form'; label='Search'; representation='data'; root='form[role="search"]'
                title=@{ static='Google Search' }
                description=@{ selector='textarea[name="q"]'; property='value'; fallback='Search query' }
            },
            @{
                id='google-results'; type='search-results'; label='Results'; representation='data'; root='#search'
                title=@{ static='Search results' }; description=@{ static='Organic results' }
                itemSelector='a:has(h3)'
                fields=@(@{name='title';selector='h3';maxLength=140},@{name='href';attribute='href';maxLength=400})
                displayFields=@('title')
                itemAction=@{kind='navigate';hrefField='href';labelField='title'}
                maxItems=12; minItems=3
            }
        )
    },
    @{
        schemaVersion = 1
        id = 'youtube-watch-v1'
        host = 'www.youtube.com'
        routePattern = '/watch'
        generatedBy = 'ai'
        generatedAt = $now
        model = 'GPT-5.6 Sol'
        notes = 'Learned as a complex visual source: player should be imported as a live browser region while metadata remains semantic data.'
        validation = @{ mustExist = @('#movie_player','video','ytd-watch-metadata'); minWidgetCount = 2 }
        widgets = @(
            @{
                id='youtube-player'; type='video'; label='Video'; representation='live-region'; root='#movie_player'
                title=@{ static='YouTube player' }
            },
            @{
                id='youtube-metadata'; type='document'; label='Video details'; representation='data'; root='ytd-watch-metadata'
                title=@{ selector='h1'; fallback='YouTube video'; maxLength=180 }
            }
        )
    }
)

$saved = @()
foreach($recipe in $recipes) {
    $json = $recipe | ConvertTo-Json -Depth 12 -Compress
    $r = Invoke-RestMethod -Method Post "$base/api/recipes" -ContentType 'application/json' -Body $json -TimeoutSec 20
    $saved += $r.recipe.id
}

function Pick($provider, $pattern) {
    (Invoke-RestMethod "$base/api/providers/$provider/targets" -TimeoutSec 20).targets | Where-Object { $_.url -match $pattern } | Select-Object -First 1
}
function Test-Recipe($provider, $target, $name) {
    $body = @{targetId=$target.targetId} | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Method Post "$base/api/providers/$provider/snapshot" -ContentType 'application/json' -Body $body -TimeoutSec 45
    [pscustomobject]@{
        name=$name
        url=$r.snapshot.url
        recipe=$r.recipe
        objects=@($r.semanticObjects | ForEach-Object { [pscustomobject]@{id=$_.id;type=$_.type;label=$_.label;representation=$_.representation;title=$_.title;itemsCount=@($_.items).Count;actionsCount=@($_.actions).Count} })
    }
}

$gmail=Pick 'chrome-personal' 'mail\.google\.com'
$drive=Pick 'chrome-personal' 'drive\.google\.com'
$search=Pick 'edge-worker' 'google\..*/search'
$youtube=Pick 'edge-worker' 'youtube\.com/watch'

[pscustomobject]@{
    saved=$saved
    tests=@(
        Test-Recipe 'chrome-personal' $gmail 'gmail'
        Test-Recipe 'chrome-personal' $drive 'drive'
        Test-Recipe 'edge-worker' $search 'google-search'
        Test-Recipe 'edge-worker' $youtube 'youtube-watch'
    )
} | ConvertTo-Json -Depth 10
