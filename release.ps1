<#
.SYNOPSIS
Cut a release of the EmDash site image.

.DESCRIPTION
Bumps package.json + package-lock.json with `npm version`, which also creates the
release commit and the vX.Y.Z tag. The tag is what triggers the GHCR image build
(.github/workflows/image.yml); pushing the branch alone only publishes :edge.

Bump rules for this repo:
  major  content/data action required (DB or storage adapter change, route/seed format change)
  minor  template/theme/feature changes, adopting upstream template changes
  patch  dependency bumps (emdash, astro, plugins) and fixes without model changes

.PARAMETER Bump
patch, minor or major.

.PARAMETER Push
Run `git push` and `git push --tags` after tagging. Alias: -p

.EXAMPLE
./release.ps1 patch

.EXAMPLE
./release.ps1 minor -p
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump,

    [Alias('p')]
    [switch]$Push
)

$ErrorActionPreference = 'Stop'

function Invoke-Native {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm not found' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git not found' }

Invoke-Native git @('rev-parse', '--is-inside-work-tree') | Out-Null

$dirty = git status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
if ($dirty) {
    $dirty | Write-Error
    throw 'working tree is not clean; commit or stash first'
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') {
    Write-Warning "on branch $branch, not main"
}

$current = (npm pkg get version).Trim().Trim('"')
Write-Host "release: current version $current, bumping $Bump"

# Creates the version commit and the vX.Y.Z tag (matches the workflow's tag trigger).
Invoke-Native npm @('version', $Bump, '-m', 'chore(release): v%s')

$version = (npm pkg get version).Trim().Trim('"')
Write-Host "release: tagged v$version" -ForegroundColor Green

if ($Push) {
    Invoke-Native git @('push')
    Invoke-Native git @('push', '--tags')
    Write-Host "release: pushed v$version - the image workflow will publish $version"
}
else {
    Write-Host 'release: not pushed. Run: git push; git push --tags'
}
