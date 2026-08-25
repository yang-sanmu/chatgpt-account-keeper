[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string] $Version,

    [Parameter(Mandatory = $true)]
    [string] $NodeDirectory,

    [Parameter(Mandatory = $true)]
    [string] $MihomoExecutable,

    [Parameter(Mandatory = $true)]
    [string] $MihomoLicense,

    [Parameter(Mandatory = $true)]
    [string] $ChromeLauncherExecutable,

    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeRoot = [IO.Path]::GetFullPath($NodeDirectory)
$nodeExecutable = Join-Path $nodeRoot 'node.exe'
$nodeLicense = Join-Path $nodeRoot 'LICENSE'

$arguments = @(
    '--version', $Version,
    '--rid', 'win-x64',
    '--node', $nodeExecutable,
    '--node-license', $nodeLicense,
    '--mihomo', ([IO.Path]::GetFullPath($MihomoExecutable)),
    '--mihomo-license', ([IO.Path]::GetFullPath($MihomoLicense)),
    '--chrome-launcher', ([IO.Path]::GetFullPath($ChromeLauncherExecutable)),
    '--output', ([IO.Path]::GetFullPath($OutputDirectory))
)
& node (Join-Path $repositoryRoot 'scripts\stage-release.mjs') @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Windows Tauri resource staging failed with exit code $LASTEXITCODE"
}

Write-Output "Windows Tauri resources staged at $([IO.Path]::GetFullPath($OutputDirectory))"
