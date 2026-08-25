<#
.SYNOPSIS
Builds an unsigned Windows Tauri inspection candidate on this machine.

.DESCRIPTION
Uses the same pinned private Node, Agent resource layout, package verifier and
Tauri updater signature as the four-platform workflow. It cannot create or
publish a GitHub Release and does not satisfy macOS/Linux acceptance gates.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string] $Version,

    [switch] $SkipTests,
    [switch] $AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = Join-Path $repositoryRoot 'artifacts'
$runtimeRoot = Join-Path $artifactRoot 'local-runtime-win-x64'
$brokerRoot = Join-Path $artifactRoot 'local-chrome-launcher'
$targetRoot = Join-Path $artifactRoot 'local-tauri-target-win-x64'
$outputRoot = Join-Path $artifactRoot "local-tauri-win-x64-$Version"
$resourceRoot = Join-Path $repositoryRoot 'app\src-tauri\release-resources'

function Reset-WorkspaceDirectory {
    param([Parameter(Mandatory = $true)][string] $Path)

    $resolved = [IO.Path]::GetFullPath($Path)
    $prefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset a directory outside the repository: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    New-Item -ItemType Directory -Path $resolved -Force | Out-Null
}

function Resolve-Tool {
    param([Parameter(Mandatory = $true)][string] $Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw "Required command was not found: $Name" }
    return $command.Source
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $ArgumentList,
        [Parameter(Mandatory = $true)][string] $Failure
    )
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) { throw "$Failure (exit code $LASTEXITCODE)" }
}

$node = Resolve-Tool 'node.exe'
$npm = Resolve-Tool 'npm.cmd'
$dotnet = Resolve-Tool 'dotnet.exe'
$cargo = Resolve-Tool 'cargo.exe'

if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
    throw 'TAURI_SIGNING_PRIVATE_KEY must contain the updater private-key path or content.'
}
if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
    throw 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required for the encrypted updater key.'
}

$tauriConfig = Get-Content (Join-Path $repositoryRoot 'app\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($tauriConfig.plugins.updater.pubkey) -or
    $tauriConfig.plugins.updater.pubkey -match 'PLACEHOLDER') {
    throw 'Replace the M5 updater public-key placeholder before building a release candidate.'
}

if (-not $AllowDirty) {
    $status = & git.exe status --porcelain
    if ($LASTEXITCODE -ne 0) { throw 'git status failed.' }
    if (-not [string]::IsNullOrWhiteSpace(($status -join [Environment]::NewLine))) {
        throw 'The worktree is dirty. Commit the release source or pass -AllowDirty for an inspection-only build.'
    }
}

Invoke-Native $node @('scripts/verify-release-version.mjs', $Version) 'Release version verification failed'

Reset-WorkspaceDirectory $runtimeRoot
Reset-WorkspaceDirectory $brokerRoot
Reset-WorkspaceDirectory $targetRoot
Reset-WorkspaceDirectory $outputRoot
Reset-WorkspaceDirectory $resourceRoot

Invoke-Native $npm @('ci', '--ignore-scripts', '--no-audit', '--no-fund') 'Agent dependency installation failed'
Invoke-Native $npm @('ci', '--prefix', 'app', '--ignore-scripts', '--no-audit', '--no-fund') 'Tauri frontend dependency installation failed'
Invoke-Native $dotnet @('publish', 'tools/chrome-launcher/ChromeLauncher.csproj', '-c', 'Release', '-r', 'win-x64', '-o', $brokerRoot) 'chrome-launcher publish failed'

if (-not $SkipTests) {
    $previousBroker = $env:GPT_ACCOUNT_KEEPER_CHROME_LAUNCHER
    try {
        $env:GPT_ACCOUNT_KEEPER_CHROME_LAUNCHER = Join-Path $brokerRoot 'chrome-launcher.exe'
        Invoke-Native $npm @('test') 'Agent tests failed'
    }
    finally {
        $env:GPT_ACCOUNT_KEEPER_CHROME_LAUNCHER = $previousBroker
    }
    Invoke-Native $npm @('test', '--prefix', 'app') 'Tauri frontend tests failed'
    Push-Location (Join-Path $repositoryRoot 'app\src-tauri')
    try {
        Invoke-Native $cargo @('fmt', '--all', '--', '--check') 'Rust formatting gate failed'
        Invoke-Native $cargo @('clippy', '--all-targets', '--all-features', '--', '-D', 'warnings') 'Rust lint gate failed'
        Invoke-Native $cargo @('test', '--all-targets', '--all-features') 'Rust tests failed'
    }
    finally {
        Pop-Location
    }
}

Invoke-Native $node @('scripts/download-release-runtime.mjs', '--rid', 'win-x64', '--output', $runtimeRoot) 'Pinned runtime download failed'
Invoke-Native $node @(
    'scripts/stage-release.mjs',
    '--version', $Version,
    '--rid', 'win-x64',
    '--node', (Join-Path $runtimeRoot 'node\node.exe'),
    '--node-license', (Join-Path $runtimeRoot 'node\LICENSE'),
    '--mihomo', (Join-Path $runtimeRoot 'mihomo\mihomo.exe'),
    '--mihomo-license', (Join-Path $runtimeRoot 'mihomo\LICENSE'),
    '--chrome-launcher', (Join-Path $brokerRoot 'chrome-launcher.exe'),
    '--output', $resourceRoot
) 'Tauri resource staging failed'

$sbom = & $npm sbom --prefix (Join-Path $resourceRoot 'agent') --omit=dev --package-lock-only --sbom-format cyclonedx
if ($LASTEXITCODE -ne 0) { throw 'Agent SBOM generation failed.' }
[IO.File]::WriteAllText(
    (Join-Path $resourceRoot 'licenses\agent.cdx.json'),
    (($sbom -join [Environment]::NewLine) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)
Invoke-Native $node @('scripts/verify-package.mjs', $resourceRoot, $Version, 'win-x64') 'Resource verification failed'
Invoke-Native $node @('scripts/smoke-staged-agent.mjs', $resourceRoot) 'Staged Agent smoke test failed'

$previousTarget = $env:CARGO_TARGET_DIR
try {
    $env:CARGO_TARGET_DIR = $targetRoot
    Push-Location (Join-Path $repositoryRoot 'app')
    try {
        Invoke-Native $npm @(
            'run', 'tauri:build:release', '--',
            '--target', 'x86_64-pc-windows-msvc',
            '--bundles', 'nsis'
        ) 'Tauri NSIS build failed'
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:CARGO_TARGET_DIR = $previousTarget
}

Invoke-Native $node @(
    'scripts/collect-tauri-artifacts.mjs',
    '--bundles', $targetRoot,
    '--version', $Version,
    '--rid', 'win-x64',
    '--sbom', (Join-Path $resourceRoot 'licenses\agent.cdx.json'),
    '--output', $outputRoot
) 'Tauri artifact collection failed'

[IO.File]::WriteAllText(
    (Join-Path $outputRoot 'UNSIGNED-win-x64.txt'),
    "Local inspection build; Authenticode was not configured.$([Environment]::NewLine)",
    [Text.UTF8Encoding]::new($false)
)

Write-Host ''
Write-Host "Windows Tauri inspection candidate: $outputRoot" -ForegroundColor Green
Write-Host 'This local candidate cannot satisfy the four-platform Draft gate.'
