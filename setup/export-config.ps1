$ErrorActionPreference = 'SilentlyContinue'
$exportDir = Join-Path $PSScriptRoot 'claude-portable'
$claudeHome = Join-Path $env:USERPROFILE '.claude'

Write-Host ''
Write-Host '  Claude Code Export' -ForegroundColor Cyan
Write-Host ''

if (Test-Path $exportDir) { Remove-Item $exportDir -Recurse -Force }
New-Item -ItemType Directory -Path $exportDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $exportDir 'memories') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $exportDir 'plans') -Force | Out-Null

$count = 0

# 1. settings.json
$src = Join-Path $claudeHome 'settings.json'
if (Test-Path $src) {
    Copy-Item $src (Join-Path $exportDir 'settings.json')
    $count++
    Write-Host '  [OK] hooks settings.json' -ForegroundColor Green
}

# 2. settings.local.json
$src = Join-Path $claudeHome 'settings.local.json'
if (Test-Path $src) {
    Copy-Item $src (Join-Path $exportDir 'settings.local.json')
    $count++
    Write-Host '  [OK] global permissions' -ForegroundColor Green
}

# 3. MEMORY.md
$projDir = Join-Path $claudeHome 'projects'
if (Test-Path $projDir) {
    $memFiles = Get-ChildItem -Path $projDir -Filter 'MEMORY.md' -Recurse
    foreach ($mem in $memFiles) {
        $pName = $mem.Directory.Parent.Name
        $dest = Join-Path $exportDir 'memories' ($pName + '.md')
        Copy-Item $mem.FullName $dest
        $count++
        Write-Host ('  [OK] memory: ' + $pName) -ForegroundColor Green
    }
}

# 4. plans
$planDir = Join-Path $claudeHome 'plans'
if (Test-Path $planDir) {
    $plans = Get-ChildItem -Path $planDir -Filter '*.md'
    foreach ($plan in $plans) {
        Copy-Item $plan.FullName (Join-Path $exportDir 'plans' $plan.Name)
        $count++
    }
    Write-Host ('  [OK] plans: ' + $plans.Count) -ForegroundColor Green
}

# 5. project settings.local.json
if (Test-Path $projDir) {
    $projSettings = Get-ChildItem -Path $projDir -Filter 'settings.local.json' -Recurse
    foreach ($ps in $projSettings) {
        $base = $projDir + [IO.Path]::DirectorySeparatorChar
        $rel = $ps.FullName.Replace($base, '')
        $pName = $rel.Split([IO.Path]::DirectorySeparatorChar)[0]
        $destDir = Join-Path $exportDir 'project-settings' $pName
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        Copy-Item $ps.FullName (Join-Path $destDir 'settings.local.json')
        $count++
        Write-Host ('  [OK] project perms: ' + $pName) -ForegroundColor Green
    }
}

# 6. meta
$meta = @{
    exportedAt = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
    sourcePC = $env:COMPUTERNAME
    sourceUser = $env:USERNAME
    gitRemote = 'https://github.com/Jayinsightfactory/mindmap-viewer.git'
    fileCount = $count
}
$meta | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $exportDir 'meta.json') -Encoding UTF8

Write-Host ''
Write-Host ('  Done! ' + $count + ' files exported') -ForegroundColor Cyan
Write-Host ('  Location: ' + $exportDir) -ForegroundColor White
Write-Host ''
Write-Host '  Next: upload claude-portable to Google Drive' -ForegroundColor Yellow
Write-Host '  Then: git clone + run import-config.ps1 on other PC' -ForegroundColor Yellow
Write-Host ''
