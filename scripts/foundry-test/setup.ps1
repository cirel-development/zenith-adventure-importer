<#
.SYNOPSIS
  Sets up a disposable local Foundry v14 + PF2e instance for testing the
  Zenith Adventure Importer. Safe to re-run.

.DESCRIPTION
  Targets Windows PowerShell 5.1 and PowerShell 7 (5.1 is the default shell here).

  Everything lives under -Root (default: "$env:USERPROFILE\FoundryTest").
  It never touches the desktop Foundry app or "$env:LOCALAPPDATA\FoundryVTT".

    <Root>\app\<build>\                    Foundry Node.js build (from your zip)
    <Root>\data\Config\options.json        port 30001, no UPnP
    <Root>\data\Data\systems\pf2e          PF2e system (GitHub release)
    <Root>\data\Data\modules\quench        Quench test runner (GitHub release)
    <Root>\data\Data\modules\zenith-adventure-importer  junction -> packages\foundry-module\dist
    <Root>\data\Data\worlds\zenith-test    disposable PF2e world
    <Root>\data\Data\zenith-fixtures\      test-bundle.zip, served at /zenith-fixtures/

.PARAMETER FoundryZip
  Path to the Foundry "Node.js" zip from foundryvtt.com
  (Purchased Licenses -> Version 14 -> Operating System: Node.js).
  Required on the first run; optional after.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ".\scripts\foundry-test\setup.ps1"
  (uses the installed desktop app when it is v14+)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ".\scripts\foundry-test\setup.ps1" -FoundryZip "$env:USERPROFILE\Downloads\FoundryVTT-Node-14.371.zip"
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$FoundryZip,
  [string]$InstalledApp = 'C:\Program Files\Foundry Virtual Tabletop\resources\app',
  [string]$Root = (Join-Path $env:USERPROFILE 'FoundryTest'),
  [string]$Pf2eVersion = '8.7.2',
  [string]$QuenchVersion = '0.10.0',
  [int]$Port = 30001,
  [switch]$SkipQuench,
  [switch]$ForcePf2e
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ModuleDist = Join-Path $RepoRoot 'packages\foundry-module\dist'
$FixtureSrc = Join-Path $RepoRoot 'packages\worker\test-bundle.zip'

$AppRoot = Join-Path $Root 'app'
$DataPath = Join-Path $Root 'data'
$DataDir = Join-Path $DataPath 'Data'
$Downloads = Join-Path $Root 'downloads'

. (Join-Path $PSScriptRoot 'FoundryTest.Common.ps1')

# Guard: never point at the personal desktop data folder.
$personal = Join-Path $env:LOCALAPPDATA 'FoundryVTT'
if ($Root.TrimEnd('\') -ieq $personal.TrimEnd('\')) {
  throw "Refusing to use $personal - that is your personal Foundry data folder."
}

$dirs = @(
  $AppRoot, $DataPath, $DataDir, $Downloads,
  (Join-Path $DataPath 'Config'), (Join-Path $DataPath 'Logs'),
  (Join-Path $DataDir 'systems'), (Join-Path $DataDir 'modules'),
  (Join-Path $DataDir 'worlds'), (Join-Path $DataDir 'zenith-fixtures')
)
foreach ($d in $dirs) {
  if (-not (Test-Path $d) -and $PSCmdlet.ShouldProcess($d, 'Create directory')) {
    New-Item -ItemType Directory -Path $d | Out-Null
  }
}

# ---------------------------------------------------------------------------
# 1. Foundry Node.js build
# ---------------------------------------------------------------------------
Write-Information '==> Foundry application'
if ($FoundryZip) {
  if (-not (Test-Path $FoundryZip)) { throw "Foundry zip not found: $FoundryZip" }
  $staging = Join-Path $AppRoot '_staging'
  if ($PSCmdlet.ShouldProcess($FoundryZip, "Extract to $AppRoot")) {
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    Expand-Archive -Path $FoundryZip -DestinationPath $staging -Force

    $pkgFile = Get-ChildItem -Path $staging -Recurse -Filter package.json -Depth 3 |
      Where-Object { (Get-Content $_.FullName -Raw) -match '"name"\s*:\s*"foundryvtt"' } |
      Select-Object -First 1
    if (-not $pkgFile) { throw 'This zip is not a Foundry build (no foundryvtt package.json). Download the Node.js build.' }
    $pkg = Get-JsonFile $pkgFile.FullName
    $build = "$($pkg.release.generation).$($pkg.release.build)"
    if ([int]$pkg.release.generation -lt 14) { throw "Zip is Foundry $build. This test instance targets v14." }

    $target = Join-Path $AppRoot $build
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Move-Item -Path $staging -Destination $target
    Write-Information "    ok: installed Foundry $build to $target"
  }
}

$app = Get-FoundryAppInfo -AppRoot $AppRoot -InstalledApp $InstalledApp
Write-Information "    ok: using Foundry $($app.Build) from the $($app.Source) ($($app.MainJs))"

$needMajor = if ($app.NodeVersion) { [int]$app.NodeVersion } else { 0 }
$nodeExe = Get-NodeForFoundry -MinMajor $needMajor
$nodeVer = (& $nodeExe --version).TrimStart('v')
Write-Information "    ok: node $nodeVer at $nodeExe"
Write-Information "    ok: node $nodeVer (Foundry wants $needMajor+)"

# ---------------------------------------------------------------------------
# 2. options.json
# ---------------------------------------------------------------------------
Write-Information '==> Config\options.json'
$optionsFile = Join-Path $DataPath 'Config\options.json'
$options = [ordered]@{
  port = $Port; upnp = $false; fullscreen = $false
  hostname = $null; localHostname = $null; routePrefix = $null
  sslCert = $null; sslKey = $null; awsConfig = $null
  dataPath = $DataPath; compressStatic = $true
  proxySSL = $false; proxyPort = $null
  language = 'en.core'; updateChannel = 'stable'
}
if (Test-Path $optionsFile) {
  # Keep anything Foundry added, override only what this instance depends on.
  $existing = Get-JsonFile $optionsFile
  foreach ($p in $existing.PSObject.Properties) {
    if ($p.Name -notin @('port', 'upnp', 'dataPath')) { $options[$p.Name] = $p.Value }
  }
}
if ($PSCmdlet.ShouldProcess($optionsFile, 'Write options.json')) {
  $options | ConvertTo-Json -Depth 5 | Out-File -FilePath $optionsFile -Encoding ascii
}
Write-Information "    ok: port $Port, dataPath $DataPath"

# ---------------------------------------------------------------------------
# 3. PF2e system
# ---------------------------------------------------------------------------
Write-Information "==> PF2e system $Pf2eVersion"
$pf2eDir = Join-Path $DataDir 'systems\pf2e'
$pf2eManifest = Join-Path $pf2eDir 'system.json'
$haveVersion = $null
if (Test-Path $pf2eManifest) { $haveVersion = (Get-JsonFile $pf2eManifest).version }
if ($haveVersion -eq $Pf2eVersion -and -not $ForcePf2e) {
  Write-Information "    ok: already installed ($haveVersion)"
} elseif ($PSCmdlet.ShouldProcess($pf2eDir, "Install PF2e $Pf2eVersion")) {
  $zip = Join-Path $Downloads "pf2e-$Pf2eVersion.zip"
  if (-not (Test-Path $zip)) {
    $url = "https://github.com/foundryvtt/pf2e/releases/download/pf2e-$Pf2eVersion/system.zip"
    Write-Information "    downloading $url (about 117 MB)"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  }
  if (Test-Path $pf2eDir) { Remove-Item -Recurse -Force $pf2eDir }
  Expand-Archive -Path $zip -DestinationPath $pf2eDir -Force
  if (-not (Test-Path $pf2eManifest)) {
    # Flatten if the zip nests a folder.
    $nested = Get-ChildItem $pf2eDir -Recurse -Filter system.json -Depth 2 | Select-Object -First 1
    if (-not $nested) { throw 'system.json not found in PF2e zip' }
    Get-ChildItem $nested.DirectoryName | Move-Item -Destination $pf2eDir
  }
  $sys = Get-JsonFile $pf2eManifest
  Write-Information "    ok: installed pf2e $($sys.version) (Foundry $($sys.compatibility.minimum) to $($sys.compatibility.maximum))"
}

# ---------------------------------------------------------------------------
# 4. Quench (optional in-Foundry test runner)
# ---------------------------------------------------------------------------
if (-not $SkipQuench) {
  Write-Information "==> Quench $QuenchVersion"
  $quenchDir = Join-Path $DataDir 'modules\quench'
  $quenchManifest = Join-Path $quenchDir 'module.json'
  $haveQ = $null
  if (Test-Path $quenchManifest) { $haveQ = (Get-JsonFile $quenchManifest).version }
  if ($haveQ -eq $QuenchVersion) {
    Write-Information "    ok: already installed ($haveQ)"
  } elseif ($PSCmdlet.ShouldProcess($quenchDir, "Install Quench $QuenchVersion")) {
    $qzip = Join-Path $Downloads "quench-$QuenchVersion.zip"
    if (-not (Test-Path $qzip)) {
      $qurl = "https://github.com/Ethaks/FVTT-Quench/releases/download/v$QuenchVersion/module.zip"
      Invoke-WebRequest -Uri $qurl -OutFile $qzip -UseBasicParsing
    }
    if (Test-Path $quenchDir) { Remove-Item -Recurse -Force $quenchDir }
    Expand-Archive -Path $qzip -DestinationPath $quenchDir -Force
    if (-not (Test-Path $quenchManifest)) {
      # The Quench release zip nests everything under dist\; flatten it.
      $nestedQ = Get-ChildItem $quenchDir -Recurse -Filter module.json -Depth 2 | Select-Object -First 1
      if (-not $nestedQ) { throw 'module.json not found in Quench zip' }
      $nestedDir = $nestedQ.DirectoryName
      Get-ChildItem $nestedDir | Move-Item -Destination $quenchDir
      Remove-Item -Recurse -Force $nestedDir
    }
    Write-Information "    ok: installed quench $QuenchVersion (verified for v13 only; api.selfTest() works without it)"
  }
}

# ---------------------------------------------------------------------------
# 5. Zenith module: junction to the repo build output
# ---------------------------------------------------------------------------
Write-Information '==> Zenith module (junction to repo dist)'
if (-not (Test-Path (Join-Path $ModuleDist 'module.json'))) {
  Write-Warning 'dist not built yet - run: pnpm --filter zenith-adventure-importer build'
  if (-not (Test-Path $ModuleDist)) { New-Item -ItemType Directory -Path $ModuleDist | Out-Null }
}
$link = Join-Path $DataDir 'modules\zenith-adventure-importer'
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "$link exists and is a real folder, not a junction. Move it away and re-run."
  }
} elseif ($PSCmdlet.ShouldProcess($link, "Create junction to $ModuleDist")) {
  New-Item -ItemType Junction -Path $link -Target $ModuleDist | Out-Null
}
Write-Information "    ok: $link -> $ModuleDist"

# ---------------------------------------------------------------------------
# 6. Test fixture
# ---------------------------------------------------------------------------
Write-Information '==> Fixtures'
if (Test-Path $FixtureSrc) {
  $fixtureDst = Join-Path $DataDir 'zenith-fixtures\test-bundle.zip'
  if ($PSCmdlet.ShouldProcess($fixtureDst, 'Copy test bundle')) {
    Copy-Item $FixtureSrc $fixtureDst -Force
    Write-Information '    ok: test-bundle.zip -> /zenith-fixtures/test-bundle.zip'
  }
} else {
  Write-Warning 'packages\worker\test-bundle.zip missing - run: pnpm --filter @ai-adventure/worker test:bundle'
}

# ---------------------------------------------------------------------------
# 7. Disposable world
# ---------------------------------------------------------------------------
Write-Information '==> World zenith-test'
$worldDir = Join-Path $DataDir 'worlds\zenith-test'
$worldJson = Join-Path $worldDir 'world.json'
if (Test-Path $worldJson) {
  Write-Information '    ok: already exists'
} elseif ($PSCmdlet.ShouldProcess($worldJson, 'Create world')) {
  New-Item -ItemType Directory -Path $worldDir -Force | Out-Null
  [ordered]@{
    id = 'zenith-test'
    title = 'Zenith Test (v14)'
    description = '<p>Disposable world for Zenith Adventure Importer tests. Safe to delete.</p>'
    system = 'pf2e'
    coreVersion = $app.Build
    compatibility = [ordered]@{ minimum = '14'; verified = $app.Build }
  } | ConvertTo-Json -Depth 5 | Out-File -FilePath $worldJson -Encoding ascii
  Write-Information "    ok: created $worldJson"
}

Write-Information ''
Write-Information 'Setup complete. Next:'
Write-Information '  powershell -ExecutionPolicy Bypass -File ".\scripts\foundry-test\start.ps1"'
Write-Information "  First launch only: accept the license screen, open 'Zenith Test (v14)',"
Write-Information '  join as Gamemaster, Manage Modules -> enable Zenith Adventure Importer (and Quench).'

[pscustomobject]@{
  FoundryBuild = $app.Build
  DataPath     = $DataPath
  Url          = "http://localhost:$Port"
  World        = 'zenith-test'
}
