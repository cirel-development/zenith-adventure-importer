<#
.SYNOPSIS
  Shared helpers for setup.ps1 and start.ps1. Dot-source this file.

.DESCRIPTION
  Targets Windows PowerShell 5.1 and PowerShell 7.
#>

Set-StrictMode -Version Latest

$script:DefaultInstalledApp = 'C:\Program Files\Foundry Virtual Tabletop\resources\app'

function Get-JsonFile {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  Get-Content -Path $Path -Raw | ConvertFrom-Json
}

function Get-JsonProperty {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$InputObject, [Parameter(Mandatory)][string]$Name)
  $prop = $InputObject.PSObject.Properties[$Name]
  if ($prop) { $prop.Value } else { $null }
}

function Get-NodeForFoundry {
  <#
    Returns the path of a node.exe whose major version is at least -MinMajor:
    `node` on PATH first, then fnm installs (newest first).
  #>
  [CmdletBinding()]
  [OutputType([string])]
  param([int]$MinMajor = 0)

  $candidates = @()
  $onPath = Get-Command node -ErrorAction SilentlyContinue
  if ($onPath) { $candidates += $onPath.Source }
  $fnmDir = if ($env:FNM_DIR) { $env:FNM_DIR } else { Join-Path $env:APPDATA 'fnm' }
  $fnmNodes = Get-ChildItem -Path (Join-Path $fnmDir 'node-versions') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^v\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name.TrimStart('v') } -Descending
  foreach ($n in $fnmNodes) {
    $exe = Join-Path $n.FullName 'installation\node.exe'
    if (Test-Path $exe) { $candidates += $exe }
  }

  $seen = @()
  foreach ($exe in $candidates) {
    $ver = (& $exe --version).TrimStart('v')
    $seen += "$ver ($exe)"
    if ([int]$ver.Split('.')[0] -ge $MinMajor) { return $exe }
  }
  throw "Need Node $MinMajor+. Found: $($seen -join '; '). Install it with: fnm install $MinMajor"
}

function Get-FoundryAppInfo {
  <#
    Returns the Foundry v14+ app to run: the newest Node.js build extracted under
    -AppRoot, otherwise the installed desktop app (its resources\app folder runs
    under plain Node with a separate --dataPath, so personal worlds stay apart).
  #>
  [CmdletBinding()]
  [OutputType([pscustomobject])]
  param(
    [Parameter(Mandatory)][string]$AppRoot,
    [string]$InstalledApp = $script:DefaultInstalledApp,
    [int]$MinGeneration = 14
  )

  $candidates = @()
  $builds = Get-ChildItem -Path $AppRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending
  foreach ($b in $builds) {
    $main = Get-ChildItem -Path $b.FullName -Recurse -Filter main.js -Depth 3 |
      Where-Object { Test-Path (Join-Path $_.DirectoryName 'package.json') } |
      Select-Object -First 1
    if ($main) { $candidates += [pscustomobject]@{ Dir = $main.DirectoryName; Source = 'Node.js build' } }
  }
  if ($InstalledApp -and (Test-Path (Join-Path $InstalledApp 'main.js'))) {
    $candidates += [pscustomobject]@{ Dir = $InstalledApp; Source = 'desktop app' }
  }

  $seen = @()
  foreach ($c in $candidates) {
    $pkg = Get-JsonFile (Join-Path $c.Dir 'package.json')
    $gen = [int]$pkg.release.generation
    $build = "$gen.$($pkg.release.build)"
    $seen += "$build ($($c.Source): $($c.Dir))"
    if ($gen -ge $MinGeneration) {
      return [pscustomobject]@{
        Build       = $build
        Generation  = $gen
        MainJs      = Join-Path $c.Dir 'main.js'
        NodeVersion = Get-JsonProperty $pkg.release 'node_version'
        Source      = $c.Source
      }
    }
  }

  $found = if ($seen) { "Found only: $($seen -join '; ')." } else { 'No Foundry install found.' }
  throw "Need Foundry v$MinGeneration or newer. $found Update the desktop app to v14 (Setup screen > Update Software) or pass -FoundryZip with a v14 Node.js zip."
}
