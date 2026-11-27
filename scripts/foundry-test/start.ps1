<#
.SYNOPSIS
  Rebuilds the module and test bundle, refreshes the fixture, and starts the
  local Foundry v14 test instance on http://localhost:30001.

.DESCRIPTION
  Targets Windows PowerShell 5.1 and PowerShell 7. Run setup.ps1 first.

.PARAMETER NoBuild
  Skip `pnpm build` and the test-bundle rebuild.

.PARAMETER NoWorld
  Start on the Setup screen instead of auto-launching the zenith-test world.
#>
[CmdletBinding()]
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'FoundryTest'),
  [string]$InstalledApp = 'C:\Program Files\Foundry Virtual Tabletop\resources\app',
  [int]$Port = 30001,
  [switch]$NoBuild,
  [switch]$NoWorld
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'
. (Join-Path $PSScriptRoot 'FoundryTest.Common.ps1')

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataPath = Join-Path $Root 'data'
$DataDir = Join-Path $DataPath 'Data'
$AppRoot = Join-Path $Root 'app'

if (-not $NoBuild) {
  Push-Location $RepoRoot
  try {
    Write-Information '==> pnpm build'
    $buildArgs = @('build')
    & pnpm @buildArgs
    if ($LASTEXITCODE -ne 0) { throw 'pnpm build failed' }
    Write-Information '==> test bundle'
    $bundleArgs = @('--filter', '@ai-adventure/worker', 'test:bundle')
    & pnpm @bundleArgs
    if ($LASTEXITCODE -ne 0) { throw 'test:bundle failed' }
  } finally {
    Pop-Location
  }
}

$fixture = Join-Path $RepoRoot 'packages\worker\test-bundle.zip'
if (Test-Path $fixture) {
  Copy-Item $fixture (Join-Path $DataDir 'zenith-fixtures\test-bundle.zip') -Force
}

if (-not (Test-Path (Join-Path $DataDir 'worlds\zenith-test\world.json'))) {
  throw 'Test instance not set up yet. Run setup.ps1 first.'
}
$app = Get-FoundryAppInfo -AppRoot $AppRoot -InstalledApp $InstalledApp

$needMajor = if ($app.NodeVersion) { [int]$app.NodeVersion } else { 0 }
$nodeExe = Get-NodeForFoundry -MinMajor $needMajor
$nodeArgs = @($app.MainJs, "--dataPath=$DataPath", "--port=$Port", '--noupnp')
if (-not $NoWorld) { $nodeArgs += '--world=zenith-test' }

Write-Information "==> Foundry $($app.Build) ($($app.Source)) on http://localhost:$Port  (Ctrl+C to stop)"
Write-Information "    data: $DataPath  (separate from your personal worlds)"
Write-Information '    Run tests in the browser console (F12):'
Write-Information "      await game.modules.get('zenith-adventure-importer').api.selfTest()"
& $nodeExe @nodeArgs
