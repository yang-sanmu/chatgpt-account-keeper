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

    # Windows 专属：创建时纳管 Chrome 的 broker。它是 per-run Job 的唯一持有者，
    # 缺了它 Windows Agent 会在接受 IPC 前 fail-closed。
    [Parameter(Mandatory = $true)]
    [string] $ChromeLauncherExecutable,

    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$desktopRoot = [System.IO.Path]::GetFullPath($DesktopPublishDirectory)
$nodeRoot = [System.IO.Path]::GetFullPath($NodeDirectory)
$mihomoFile = [System.IO.Path]::GetFullPath($MihomoExecutable)
$mihomoLicenseFile = [System.IO.Path]::GetFullPath($MihomoLicense)
$chromeLauncherFile = [System.IO.Path]::GetFullPath($ChromeLauncherExecutable)
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)

foreach ($required in @($desktopRoot, $nodeRoot, $mihomoFile, $mihomoLicenseFile, $chromeLauncherFile)) {
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
    --chrome-launcher $chromeLauncherFile `
    --output $outputRoot
if ($LASTEXITCODE -ne 0) {
    throw "Windows release staging failed with exit code $LASTEXITCODE"
}

Write-Output "Windows release staged at $outputRoot"
