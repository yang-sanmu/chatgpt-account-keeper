[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string] $Version,

    [Parameter(Mandatory = $true)]
    [string] $DesktopPublishDirectory,

    [Parameter(Mandatory = $true)]
    [string] $NodeDirectory,

    [Parameter(Mandatory = $true)]
    [string] $MihomoExecutable,

    [Parameter(Mandatory = $true)]
    [string] $MihomoLicense,

    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$desktopRoot = [System.IO.Path]::GetFullPath($DesktopPublishDirectory)
$nodeRoot = [System.IO.Path]::GetFullPath($NodeDirectory)
$mihomoFile = [System.IO.Path]::GetFullPath($MihomoExecutable)
$mihomoLicenseFile = [System.IO.Path]::GetFullPath($MihomoLicense)
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)

foreach ($required in @($desktopRoot, $nodeRoot, $mihomoFile, $mihomoLicenseFile)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required release input does not exist: $required"
    }
}

$nodeExecutable = Join-Path $nodeRoot 'node.exe'
$nodeLicense = Join-Path $nodeRoot 'LICENSE'
foreach ($required in @($nodeExecutable, $nodeLicense)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required Node.js release input does not exist: $required"
    }
}

& node (Join-Path $repositoryRoot 'scripts\stage-release.mjs') `
    --version $Version `
    --rid win-x64 `
    --desktop $desktopRoot `
    --node $nodeExecutable `
    --node-license $nodeLicense `
    --mihomo $mihomoFile `
    --mihomo-license $mihomoLicenseFile `
    --output $outputRoot
if ($LASTEXITCODE -ne 0) {
    throw "Windows release staging failed with exit code $LASTEXITCODE"
}

Write-Output "Windows release staged at $outputRoot"
