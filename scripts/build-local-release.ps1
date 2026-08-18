<#
.SYNOPSIS
Builds a complete Windows release on this machine, without GitHub Actions.

.DESCRIPTION
Builds a Windows inspection package while Actions is unavailable. The formal
release is assembled remotely because Linux and macOS packages and signatures
cannot be produced or attested by this Windows-only script.

Signing is intentionally absent. This output is for local validation only; it
cannot pass the signed cross-platform draft-release gate. See SOURCE.md.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string] $Version,

    # Skips the Node and .NET test suites. Only for re-running a build whose
    # tests already passed on the same commit.
    [switch] $SkipTests,

    # Builds even when the worktree is dirty. The embedded version stamp comes
    # from HEAD, so a dirty build produces a binary that the tagged source tree
    # cannot reproduce -- which is what SOURCE.md promises users.
    [switch] $AllowDirty,

    # Skips downloading the previous release. Without it no delta package is
    # produced and clients fall back to the full package.
    [switch] $SkipDelta,

    [string] $SyftVersion = '1.20.0',

    [string] $VelopackVersion = '1.2.0',

    [string] $Repository = 'yang-sanmu/chatgpt-account-keeper'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = Join-Path $repositoryRoot 'artifacts'
$downloadRoot = Join-Path $artifactRoot 'downloads'
$desktopRoot = Join-Path $artifactRoot 'desktop'
$stageRoot = Join-Path $artifactRoot 'stage'
$releaseRoot = Join-Path $artifactRoot 'Releases'
$complianceRoot = Join-Path $artifactRoot 'compliance'

$script:stepIndex = 0
function Write-Step {
    param([Parameter(Mandatory = $true)][string] $Message)
    $script:stepIndex++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $script:stepIndex, $Message) -ForegroundColor Cyan
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $ArgumentList,
        [string] $ErrorMessage
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        if ([string]::IsNullOrWhiteSpace($ErrorMessage)) {
            throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($ArgumentList -join ' ')"
        }
        throw "${ErrorMessage} (exit code ${LASTEXITCODE})"
    }
}

function Resolve-Tool {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $Hint
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "${Name} was not found on PATH. ${Hint}"
    }
    return $command.Source
}

# NativeAOT shells out to the MSVC linker and locates it through vswhere.exe,
# which the Visual Studio installer does not add to PATH. Without this the
# publish fails late with MSB3073 rather than a readable error.
function Add-VswhereToPath {
    $installerDirectory = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
    $vswhere = Join-Path $installerDirectory 'vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw @'
vswhere.exe was not found. NativeAOT publishing requires Visual Studio with the
"Desktop development with C++" workload (MSVC toolset + Windows SDK).
'@
    }

    if (($env:PATH -split ';') -notcontains $installerDirectory) {
        $env:PATH = "${installerDirectory};${env:PATH}"
    }

    $vcInstall = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($vcInstall)) {
        throw 'No Visual Studio installation with the MSVC x64 toolset was found. Install the "Desktop development with C++" workload.'
    }
    Write-Host "  MSVC toolset: $vcInstall"
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string] $Url,
        [Parameter(Mandatory = $true)][string] $Destination,
        [string] $ExpectedSha256
    )

    if (Test-Path -LiteralPath $Destination) {
        if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
            Write-Host "  cached: $([System.IO.Path]::GetFileName($Destination))"
            return
        }
        $cached = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($cached -eq $ExpectedSha256.ToLowerInvariant()) {
            Write-Host "  cached: $([System.IO.Path]::GetFileName($Destination))"
            return
        }
        Write-Host "  cache mismatch, re-downloading: $([System.IO.Path]::GetFileName($Destination))"
        Remove-Item -LiteralPath $Destination -Force
    }

    Write-Host "  downloading: $Url"
    $previousProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    }
    finally {
        $ProgressPreference = $previousProgress
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
        $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
            Remove-Item -LiteralPath $Destination -Force
            throw "SHA-256 mismatch for ${Url}: expected ${ExpectedSha256}, got ${actual}"
        }
        Write-Host '  SHA-256 verified'
    }
}

function Expand-Fresh {
    param(
        [Parameter(Mandatory = $true)][string] $Archive,
        [Parameter(Mandatory = $true)][string] $Destination
    )

    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
}

$originalLocation = Get-Location
try {
    Set-Location -LiteralPath $repositoryRoot

    Write-Step 'Verifying toolchain'
    $dotnet = Resolve-Tool -Name 'dotnet' -Hint 'Install the .NET SDK matching desktop/global.json.'
    $npm = Resolve-Tool -Name 'npm' -Hint 'Install Node.js matching .node-version.'
    $node = Resolve-Tool -Name 'node' -Hint 'Install Node.js matching .node-version.'
    $git = Resolve-Tool -Name 'git' -Hint 'Install Git.'

    $expectedNode = (Get-Content (Join-Path $repositoryRoot '.node-version') -Raw).Trim()
    $actualNode = (& $node --version).TrimStart('v')
    if ($actualNode -ne $expectedNode) {
        Write-Warning "Local Node is ${actualNode} but .node-version pins ${expectedNode}. The bundled private runtime is downloaded separately and is unaffected."
    }

    if ($null -eq (Get-Command 'vpk' -ErrorAction SilentlyContinue)) {
        Write-Host "  installing VeloPack CLI ${VelopackVersion}"
        Invoke-Native -FilePath $dotnet -ArgumentList @('tool', 'install', '--global', 'vpk', '--version', $VelopackVersion) -ErrorMessage 'VeloPack CLI install failed'
        $env:PATH = "${env:USERPROFILE}\.dotnet\tools;${env:PATH}"
    }
    $vpk = Resolve-Tool -Name 'vpk' -Hint 'Install it with: dotnet tool install --global vpk'
    Add-VswhereToPath

    Write-Step 'Checking release source state'
    & $git diff --quiet --exit-code HEAD
    $isDirty = $LASTEXITCODE -ne 0
    $untracked = & $git ls-files --others --exclude-standard
    if (-not [string]::IsNullOrWhiteSpace(($untracked -join ''))) { $isDirty = $true }
    if ($isDirty) {
        # The publish stamps HEAD's commit into the binary. Releasing a dirty
        # build breaks the promise in SOURCE.md that the tag reproduces it.
        $message = 'The worktree has uncommitted changes. Commit the version bump before building a release, or pass -AllowDirty for a throwaway build.'
        if (-not $AllowDirty) { throw $message }
        Write-Warning $message
    }

    $headCommit = (& $git rev-parse HEAD).Trim()
    Write-Host "  HEAD: $headCommit"

    $packageVersion = (Get-Content (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json).version
    if ($packageVersion -ne $Version) {
        throw "package.json declares ${packageVersion} but -Version is ${Version}. Update package.json, package-lock.json and the csproj <Version>, then commit."
    }

    $projectFile = Join-Path $repositoryRoot 'desktop\src\GptAccountKeeper.Desktop\GptAccountKeeper.Desktop.csproj'
    $projectXml = [xml](Get-Content -LiteralPath $projectFile -Raw)
    $projectVersion = ($projectXml.Project.PropertyGroup | Where-Object { $null -ne $_.Version } | Select-Object -First 1).Version
    if ($projectVersion -ne $Version) {
        throw "The desktop csproj declares ${projectVersion} but -Version is ${Version}."
    }
    Write-Host "  version: ${Version} (package.json and csproj agree)"

    New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

    if ($SkipTests) {
        Write-Warning 'Skipping tests because -SkipTests was supplied.'
    } else {
        Write-Step 'Installing dependencies and running tests'
        $previousSkip = $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
        $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
        try {
            Invoke-Native -FilePath $npm -ArgumentList @('ci', '--ignore-scripts', '--no-audit', '--no-fund') -ErrorMessage 'npm ci failed'
            Invoke-Native -FilePath $npm -ArgumentList @('test') -ErrorMessage 'Node test suite failed'
        }
        finally {
            $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = $previousSkip
        }
        Invoke-Native -FilePath $dotnet -ArgumentList @('test', 'desktop/GptAccountKeeper.Desktop.sln', '-c', 'Release', '--nologo') -ErrorMessage 'Desktop test suite failed'
    }

    Write-Step 'Downloading pinned private runtimes'
    $versions = Get-Content (Join-Path $repositoryRoot 'build\runtime-versions.json') -Raw | ConvertFrom-Json

    $nodeArchive = Join-Path $downloadRoot $versions.node.windowsX64Archive
    Get-VerifiedDownload `
        -Url "https://nodejs.org/dist/v$($versions.node.version)/$($versions.node.windowsX64Archive)" `
        -Destination $nodeArchive `
        -ExpectedSha256 $versions.node.windowsX64Sha256
    Expand-Fresh -Archive $nodeArchive -Destination (Join-Path $downloadRoot 'node')

    $mihomoArchive = Join-Path $downloadRoot $versions.mihomo.windowsX64Archive
    Get-VerifiedDownload `
        -Url "https://github.com/MetaCubeX/mihomo/releases/download/v$($versions.mihomo.version)/$($versions.mihomo.windowsX64Archive)" `
        -Destination $mihomoArchive `
        -ExpectedSha256 $versions.mihomo.windowsX64Sha256
    Expand-Fresh -Archive $mihomoArchive -Destination (Join-Path $downloadRoot 'mihomo')

    $mihomoLicense = Join-Path $downloadRoot 'mihomo-LICENSE.txt'
    Get-VerifiedDownload `
        -Url "https://raw.githubusercontent.com/MetaCubeX/mihomo/v$($versions.mihomo.version)/LICENSE" `
        -Destination $mihomoLicense

    $nodeDirectory = Get-ChildItem (Join-Path $downloadRoot 'node') -Directory | Select-Object -First 1 -ExpandProperty FullName
    $mihomoExecutable = Get-ChildItem (Join-Path $downloadRoot 'mihomo') -File -Filter '*.exe' | Select-Object -First 1 -ExpandProperty FullName
    if ($null -eq $nodeDirectory -or $null -eq $mihomoExecutable) {
        throw 'The private runtime archives did not contain the expected payload.'
    }

    Write-Step 'Publishing Avalonia NativeAOT'
    if (Test-Path -LiteralPath $desktopRoot) { Remove-Item -LiteralPath $desktopRoot -Recurse -Force }
    Invoke-Native `
        -FilePath $dotnet `
        -ArgumentList @(
            'publish', 'desktop/src/GptAccountKeeper.Desktop/GptAccountKeeper.Desktop.csproj',
            '-c', 'Release', '-r', 'win-x64', "-p:Version=${Version}", '-o', $desktopRoot, '--nologo'
        ) `
        -ErrorMessage 'NativeAOT publish failed'

    Write-Step 'Staging the private Agent'
    if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
    & (Join-Path $PSScriptRoot 'stage-windows-release.ps1') `
        -Version $Version `
        -DesktopPublishDirectory $desktopRoot `
        -NodeDirectory $nodeDirectory `
        -MihomoExecutable $mihomoExecutable `
        -MihomoLicense $mihomoLicense `
        -OutputDirectory $stageRoot

    Write-Step 'Generating the Agent SBOM and verifying package contents'
    $agentSbom = & $npm sbom --prefix (Join-Path $stageRoot 'agent') --omit=dev --package-lock-only --sbom-format cyclonedx
    if ($LASTEXITCODE -ne 0) { throw 'Agent SBOM generation failed' }
    [IO.File]::WriteAllText(
        (Join-Path $stageRoot 'licenses\agent.cdx.json'),
        ($agentSbom -join [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false))

    Invoke-Native -FilePath $node -ArgumentList @('scripts/verify-package.mjs', $stageRoot, $Version) -ErrorMessage 'Release package verification failed'
    Invoke-Native -FilePath $node -ArgumentList @('scripts/smoke-staged-agent.mjs', $stageRoot) -ErrorMessage 'Staged Agent smoke test failed'

    Write-Step 'Packaging with VeloPack'
    if (Test-Path -LiteralPath $releaseRoot) { Remove-Item -LiteralPath $releaseRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null

    if ($SkipDelta) {
        Write-Host '  skipping previous-release download; no delta package will be produced'
    } else {
        # A missing previous release is normal for a first release, and clients
        # fall back to the full package, so this must not fail the build.
        $token = $null
        $gh = Get-Command 'gh' -ErrorAction SilentlyContinue
        if ($null -ne $gh) {
            $token = (& $gh.Source auth token) 2>$null
            if ($LASTEXITCODE -ne 0) { $token = $null }
        }
        if ([string]::IsNullOrWhiteSpace($token)) {
            Write-Warning 'No GitHub token available (gh auth login); skipping delta generation.'
        } else {
            & $vpk download github --repoUrl "https://github.com/${Repository}" --token $token.Trim() --outputDir $releaseRoot
            if ($LASTEXITCODE -ne 0) {
                Write-Warning 'Previous release download failed; continuing without a delta package.'
            }
        }
    }

    # Without --icon the Setup.exe, the uninstall entry and the Desktop/Start
    # menu shortcuts all get VeloPack's placeholder icon.
    $packIcon = Join-Path $repositoryRoot 'desktop\src\GptAccountKeeper.Desktop\app-icon.ico'
    if (-not (Test-Path -LiteralPath $packIcon)) {
        throw "The application icon is missing: ${packIcon}. Run: node scripts/generate-app-icon.mjs"
    }

    & $vpk pack `
        --packId GptAccountKeeper.Desktop `
        --packVersion $Version `
        --packTitle 'ChatGPT Account Keeper' `
        --packAuthors 'yang-sanmu' `
        --packDir $stageRoot `
        --mainExe GptAccountKeeper.Desktop.exe `
        --icon $packIcon `
        --runtime win-x64 `
        --outputDir $releaseRoot
    if ($LASTEXITCODE -ne 0) { throw 'VeloPack packaging failed' }

    Write-Step 'Generating the release SBOM'
    if (Test-Path -LiteralPath $complianceRoot) { Remove-Item -LiteralPath $complianceRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $complianceRoot -Force | Out-Null

    # CI uses anchore/sbom-action, which is a wrapper around syft. Pin and verify
    # the same tool here so both paths describe the package identically.
    $syftArchive = Join-Path $downloadRoot "syft_${SyftVersion}_windows_amd64.zip"
    $syftChecksums = Join-Path $downloadRoot "syft_${SyftVersion}_checksums.txt"
    $syftBase = "https://github.com/anchore/syft/releases/download/v${SyftVersion}"
    Get-VerifiedDownload -Url "${syftBase}/syft_${SyftVersion}_checksums.txt" -Destination $syftChecksums
    $checksumLine = Select-String -Path $syftChecksums -Pattern "syft_${SyftVersion}_windows_amd64\.zip" | Select-Object -First 1
    if ($null -eq $checksumLine) { throw "No published checksum for syft ${SyftVersion} windows_amd64." }
    Get-VerifiedDownload `
        -Url "${syftBase}/syft_${SyftVersion}_windows_amd64.zip" `
        -Destination $syftArchive `
        -ExpectedSha256 ($checksumLine.Line -split '\s+')[0]
    Expand-Fresh -Archive $syftArchive -Destination (Join-Path $downloadRoot 'syft')

    $syft = Get-ChildItem (Join-Path $downloadRoot 'syft') -File -Filter 'syft.exe' -Recurse | Select-Object -First 1 -ExpandProperty FullName
    if ($null -eq $syft) { throw 'The syft archive did not contain syft.exe.' }
    $sbomPath = Join-Path $complianceRoot "GptAccountKeeper.Desktop-${Version}.spdx.json"
    Invoke-Native -FilePath $syft -ArgumentList @('scan', "dir:${stageRoot}", '-o', "spdx-json=${sbomPath}", '-q') -ErrorMessage 'Release SBOM generation failed'

    Write-Step 'Bundling corresponding source and checksums'
    $projectSource = Join-Path $complianceRoot "chatgpt-account-keeper-${Version}-source.zip"
    Invoke-Native -FilePath $git -ArgumentList @('archive', '--format=zip', "--output=${projectSource}", 'HEAD') -ErrorMessage 'Project source archive generation failed'

    # mihomo ships under GPL-3.0, so the exact upstream source for the bundled
    # binary has to travel with the release.
    Get-VerifiedDownload `
        -Url "https://github.com/MetaCubeX/mihomo/archive/refs/tags/v$($versions.mihomo.version).zip" `
        -Destination (Join-Path $complianceRoot "mihomo-v$($versions.mihomo.version)-source.zip")

    $checksumTarget = Join-Path $complianceRoot 'SHA256SUMS.release.txt'
    $releaseFiles = @(
        Get-ChildItem $releaseRoot -File | Where-Object {
            $_.Name -in @(
                'GptAccountKeeper.Desktop-win-Setup.exe',
                'GptAccountKeeper.Desktop-win-Portable.zip',
                'RELEASES',
                'releases.win.json',
                'assets.win.json'
            ) -or $_.Name -like "*${Version}*"
        }
        Get-ChildItem $complianceRoot -File | Where-Object { $_.FullName -ne $checksumTarget }
    ) | Sort-Object Name
    if ($releaseFiles.Count -eq 0) { throw 'No release files were available for checksums' }
    $checksumLines = $releaseFiles | ForEach-Object {
        "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
    }
    [IO.File]::WriteAllLines($checksumTarget, $checksumLines, [Text.UTF8Encoding]::new($false))

    Write-Step 'Release summary'
    $stampedExe = Join-Path $stageRoot 'GptAccountKeeper.Desktop.exe'
    $stamped = [Diagnostics.FileVersionInfo]::GetVersionInfo($stampedExe)
    Write-Host "  product   : $($stamped.ProductName)"
    Write-Host "  stamped   : $($stamped.ProductVersion)"
    if ($stamped.ProductVersion -notlike "*${headCommit}*") {
        Write-Warning 'The embedded commit does not match HEAD. Rebuild after committing so the tagged source reproduces this binary.'
    }

    $setup = Join-Path $releaseRoot 'GptAccountKeeper.Desktop-win-Setup.exe'
    if (Test-Path -LiteralPath $setup) {
        Write-Host "  signature : $((Get-AuthenticodeSignature -LiteralPath $setup).Status) (unsigned is expected)"
    }

    Write-Host ''
    Write-Host '  Package assets:' -ForegroundColor Green
    # The previous release downloaded for delta generation also lives here, so
    # flag anything that is not part of this version rather than hiding it.
    Get-ChildItem $releaseRoot -File | Sort-Object Name | ForEach-Object {
        $isOtherVersion = $_.Name -like 'GptAccountKeeper.Desktop-*' -and
            $_.Name -match '\d+\.\d+\.\d+' -and
            $_.Name -notlike "*${Version}*"
        $note = if ($isOtherVersion) { '  <- delta source, not uploaded' } else { '' }
        Write-Host ("    {0,-46} {1,8:N1} MB{2}" -f $_.Name, ($_.Length / 1MB), $note)
    }
    Write-Host '  Compliance assets:' -ForegroundColor Green
    Get-ChildItem $complianceRoot -File | Sort-Object Name | ForEach-Object {
        Write-Host ("    {0,-46} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB))
    }

    Write-Host ''
    Write-Host 'Next: verify an installed N-1 -> N upgrade with this Setup.exe.' -ForegroundColor Yellow
    Write-Host 'For a publishable draft, run the remote Candidate workflow for all platforms, then rerun it in Release mode after verification.' -ForegroundColor Yellow
}
finally {
    Set-Location -LiteralPath $originalLocation
}
