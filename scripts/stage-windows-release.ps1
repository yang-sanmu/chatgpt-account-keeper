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

if (Test-Path -LiteralPath $outputRoot) {
    $existing = @(Get-ChildItem -LiteralPath $outputRoot -Force)
    if ($existing.Count -gt 0) {
        throw "Release stage must be a new or empty directory: $outputRoot"
    }
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
Get-ChildItem -LiteralPath $desktopRoot -File -Recurse | ForEach-Object {
    if ($_.Extension -eq '.pdb') {
        return
    }
    $relative = $_.FullName.Substring($desktopRoot.TrimEnd('\', '/').Length).TrimStart('\', '/')
    $target = Join-Path $outputRoot $relative
    New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
}

$agentRoot = Join-Path $outputRoot 'agent'
$agentSource = Join-Path $agentRoot 'src'
$agentRuntime = Join-Path $agentRoot 'runtime'
$agentBin = Join-Path $agentRoot 'bin'
$agentConfig = Join-Path $agentRoot 'config'
$agentContracts = Join-Path $agentRoot 'contracts'
$licenseRoot = Join-Path $outputRoot 'licenses'
New-Item -ItemType Directory -Path $agentSource, $agentRuntime, $agentBin, $agentConfig, $agentContracts, $licenseRoot -Force | Out-Null

$sourceRoot = Join-Path $repositoryRoot 'src'
Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($sourceRoot.TrimEnd('\', '/').Length).TrimStart('\', '/')
    if ($relative -in @('server.js', 'cli.js')) {
        return
    }
    $target = Join-Path $agentSource $relative
    New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($target)) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
}

Copy-Item -LiteralPath (Join-Path $repositoryRoot 'package.json') -Destination $agentRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'package-lock.json') -Destination $agentRoot
$stagedPackageFile = Join-Path $agentRoot 'package.json'
$stagedLockFile = Join-Path $agentRoot 'package-lock.json'
& node (Join-Path $repositoryRoot 'scripts\stamp-agent-version.mjs') `
    $stagedPackageFile $stagedLockFile $Version
if ($LASTEXITCODE -ne 0) {
    throw "Agent version stamping failed with exit code $LASTEXITCODE"
}
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'config\selectors.json') -Destination $agentConfig
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'contracts\ipc-v1.schema.json') -Destination $agentContracts
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'contracts\ipc-v1.methods.schema.json') -Destination $agentContracts
Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe') -Destination $agentRuntime
Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination (Join-Path $licenseRoot 'Node.js-LICENSE.txt')
Copy-Item -LiteralPath $mihomoFile -Destination (Join-Path $agentBin 'mihomo.exe')
Copy-Item -LiteralPath $mihomoLicenseFile -Destination (Join-Path $licenseRoot 'mihomo-GPL-3.0.txt')
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'build\runtime-versions.json') -Destination (Join-Path $licenseRoot 'runtime-versions.json')

$legalDocuments = @(
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'PRIVACY.md',
    'SOURCE.md'
)
foreach ($document in $legalDocuments) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $document) -Destination (Join-Path $licenseRoot $document) -Force
}

$previousSkip = $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
try {
    # better-sqlite3 13 ships pinned per-RID prebuilds. Release jobs must never
    # execute arbitrary install scripts or compile native code on the user path.
    & npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix $agentRoot
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed with exit code $LASTEXITCODE"
    }
}
finally {
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = $previousSkip
}

& node (Join-Path $repositoryRoot 'scripts\verify-package.mjs') $outputRoot $Version
if ($LASTEXITCODE -ne 0) {
    throw "Release verification failed with exit code $LASTEXITCODE"
}

Write-Output "Windows release staged at $outputRoot"
