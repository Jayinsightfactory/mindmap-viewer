param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]] $Keywords,

  [int] $MaxResults = 120
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

$targets = @(
  "WORK_MEMORY.md",
  "WORKSPACE.md",
  "PROGRESS.md",
  "CLAUDE.md",
  "README.md",
  "docs",
  "public",
  "routes",
  "src",
  "nenova-erp-ui",
  "scripts"
) | Where-Object { Test-Path $_ }

if (-not $targets) {
  Write-Error "No searchable targets found."
}

$rg = Get-Command rg -ErrorAction SilentlyContinue

foreach ($keyword in $Keywords) {
  Write-Host ""
  Write-Host "=== keyword: $keyword ==="

  if ($rg) {
    $args = @(
      "--line-number",
      "--hidden",
      "--ignore-case",
      "--fixed-strings",
      "--max-count", "3",
      "--glob", "!node_modules/**",
      "--glob", "!.git/**",
      "--glob", "!.next/**",
      "--glob", "!data/**",
      "--glob", "!package-lock.json",
      "--glob", "!public/js-min/**",
      "--glob", "!*.min.js",
      "--glob", "!recorder/screenshots/**",
      "--glob", "!test-screenshots/**",
      "--",
      $keyword
    ) + $targets

    $output = & rg @args
    if ($LASTEXITCODE -eq 1) {
      Write-Host "(no matches)"
    } elseif ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    } elseif ($output) {
      $output | Select-Object -First $MaxResults
      if ($output.Count -gt $MaxResults) {
        Write-Host "... truncated $($output.Count - $MaxResults) more matches. Use rg directly for full results."
      }
    }
  } else {
    Get-ChildItem $targets -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object {
        $_.FullName -notmatch "\\node_modules\\" -and
        $_.FullName -notmatch "\\.git\\" -and
        $_.FullName -notmatch "\\.next\\" -and
        $_.FullName -notmatch "\\data\\" -and
        $_.Name -ne "package-lock.json" -and
        $_.FullName -notmatch "\\public\\js-min\\"
      } |
      Select-String -Pattern $keyword -SimpleMatch -CaseSensitive:$false |
      Select-Object -First $MaxResults
  }
}
