[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string] $Version,

    # Candidate/Release dispatch the cross-platform GitHub Actions workflow.
    # UploadDraft is retained only to produce a clear migration error for callers
    # of the former Windows-only local release path.
    [Parameter(Mandatory = $true)]
    [ValidateSet('Candidate', 'Release', 'UploadDraft', 'PublishDraft')]
    [string] $Mode,

    [switch] $NMinusOneVerified,

    [string] $Repository = 'yang-sanmu/chatgpt-account-keeper',

    [string] $Ref = 'main',

    [string] $CandidateOutputDirectory,

    # Required when Candidate/Release starts a build. The Markdown is embedded
    # in every VeloPack feed and shown in the desktop update prompt.
    [string] $ReleaseNotesFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workflow = 'windows-release.yml'
$tag = "v$Version"
$script:ReplaceExistingDraft = $false
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseNotes = ''

function Read-ReleaseNotes {
    if ([string]::IsNullOrWhiteSpace($ReleaseNotesFile)) {
        throw '-ReleaseNotesFile is required with -Mode Candidate or -Mode Release.'
    }

    $resolvedPath = [System.IO.Path]::GetFullPath($ReleaseNotesFile)
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "Release notes file does not exist: $resolvedPath"
    }

    $notes = [System.IO.File]::ReadAllText($resolvedPath)
    $notes = $notes.Replace("`r`n", "`n").Replace("`r", "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($notes)) {
        throw "Release notes file is empty: $resolvedPath"
    }

    return $notes
}

function Resolve-GitHubCli {
    $command = Get-Command gh.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $fallback = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
    if (Test-Path -LiteralPath $fallback) {
        return $fallback
    }

    throw 'GitHub CLI was not found. Install gh and run "gh auth login" first.'
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FilePath,

        [Parameter(Mandatory = $true)]
        [string[]] $ArgumentList,

        [switch] $CaptureOutput,

        [switch] $AllowFailure
    )

    if ($CaptureOutput) {
        # Windows PowerShell wraps a native command's stderr in an ErrorRecord, so
        # under $ErrorActionPreference = 'Stop' the 2>&1 redirect turns any stderr
        # output into a terminating error before -AllowFailure can be honoured.
        # `gh release view` writes "release not found" to stderr for a version that
        # does not exist yet, which is the normal case for a new release.
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & $FilePath @ArgumentList 2>&1
            $exitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousPreference
        }
        $output = @($output | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { $_ }
        })
        if (-not $AllowFailure -and $exitCode -ne 0) {
            throw "Command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')`n$($output -join [Environment]::NewLine)"
        }

        return [pscustomobject]@{
            ExitCode = $exitCode
            Output = ($output -join [Environment]::NewLine).Trim()
        }
    }

    & $FilePath @ArgumentList
    $exitCode = $LASTEXITCODE
    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "Command failed with exit code ${exitCode}: $FilePath $($ArgumentList -join ' ')"
    }

    return $exitCode
}

function Assert-ReleaseSourceReady {
    param(
        [Parameter(Mandatory = $true)]
        [string] $GitHubCli,

        [switch] $AllowExistingTag
    )

    $status = Invoke-NativeCommand -FilePath 'git.exe' -ArgumentList @('status', '--porcelain') -CaptureOutput
    if (-not [string]::IsNullOrWhiteSpace($status.Output)) {
        throw 'The worktree is not clean. Commit or stash changes before starting a release build.'
    }

    $branch = Invoke-NativeCommand -FilePath 'git.exe' -ArgumentList @('branch', '--show-current') -CaptureOutput
    if ($branch.Output -ne $Ref) {
        throw "The current branch is '$($branch.Output)'; switch to '$Ref' before releasing."
    }

    Invoke-NativeCommand -FilePath 'git.exe' -ArgumentList @('fetch', '--quiet', 'origin', $Ref) | Out-Null
    $localCommit = Invoke-NativeCommand -FilePath 'git.exe' -ArgumentList @('rev-parse', 'HEAD') -CaptureOutput
    $remoteCommit = Invoke-NativeCommand -FilePath 'git.exe' -ArgumentList @('rev-parse', "origin/$Ref") -CaptureOutput
    if ($localCommit.Output -ne $remoteCommit.Output) {
        throw "Local HEAD does not match origin/$Ref. Push or pull before releasing."
    }

    $existingRelease = Invoke-NativeCommand `
        -FilePath $GitHubCli `
        -ArgumentList @('release', 'view', $tag, '--repo', $Repository, '--json', 'tagName,isDraft') `
        -CaptureOutput `
        -AllowFailure
    if ($existingRelease.ExitCode -eq 0) {
        # A leftover draft is recoverable: re-uploading replaces its assets and
        # nothing has reached update clients yet. A public release is not.
        $isDraft = ($existingRelease.Output | ConvertFrom-Json).isDraft
        if (-not ($AllowExistingTag -and $isDraft)) {
            throw "Release $tag already exists. Use a new version number."
        }
        Write-Warning "Draft release $tag already exists; its assets will be replaced."
        $script:ReplaceExistingDraft = $true
    }

    if (-not $AllowExistingTag) {
        $existingTag = Invoke-NativeCommand `
            -FilePath 'git.exe' `
            -ArgumentList @('ls-remote', '--tags', 'origin', "refs/tags/$tag") `
            -CaptureOutput
        if (-not [string]::IsNullOrWhiteSpace($existingTag.Output)) {
            throw "Tag $tag already exists on origin. Use a new version number."
        }
    }
}

function Get-ReleaseRunId {
    param(
        [Parameter(Mandatory = $true)]
        [string] $DispatchOutput
    )

    $match = [regex]::Match($DispatchOutput, '/actions/runs/(?<id>\d+)')
    if (-not $match.Success) {
        throw "The workflow was dispatched, but its run id could not be read from:`n$DispatchOutput"
    }

    return $match.Groups['id'].Value
}

function Invoke-ReleaseWorkflow {
    param(
        [Parameter(Mandatory = $true)]
        [string] $GitHubCli,

        [Parameter(Mandatory = $true)]
        [bool] $PublishDraft,

        [Parameter(Mandatory = $true)]
        [bool] $Verified
    )

    $arguments = @(
        'workflow', 'run', $workflow,
        '--repo', $Repository,
        '--ref', $Ref,
        '--raw-field', "version=$Version",
        '--raw-field', "release_notes=$releaseNotes",
        '--raw-field', "publish_draft=$($PublishDraft.ToString().ToLowerInvariant())",
        '--raw-field', "n_minus_one_verified=$($Verified.ToString().ToLowerInvariant())"
    )

    if (-not $PSCmdlet.ShouldProcess("$Repository $tag", "Dispatch $workflow")) {
        Write-Host "$GitHubCli $($arguments -join ' ')"
        return $null
    }

    $dispatch = Invoke-NativeCommand -FilePath $GitHubCli -ArgumentList $arguments -CaptureOutput
    $runId = Get-ReleaseRunId -DispatchOutput $dispatch.Output
    $runUrl = "https://github.com/$Repository/actions/runs/$runId"
    Write-Host "Workflow run: $runUrl"

    Invoke-NativeCommand `
        -FilePath $GitHubCli `
        -ArgumentList @('run', 'watch', $runId, '--repo', $Repository, '--exit-status') | Out-Null

    return $runId
}

function Get-RequiredAssetName {
    $runtimeVersions = Get-Content (Join-Path $repositoryRoot 'build\runtime-versions.json') -Raw | ConvertFrom-Json
    return @(
        "GptAccountKeeper.Desktop-$Version-full.nupkg",
        'GptAccountKeeper.Desktop-win-Setup.exe',
        'GptAccountKeeper.Desktop-win-Portable.zip',
        'RELEASES',
        'releases.win.json',
        "GptAccountKeeper.Desktop-$Version-win-x64.spdx.json",

        "GptAccountKeeper.Desktop-$Version-osx-arm64-full.nupkg",
        'GptAccountKeeper.Desktop-osx-arm64-Setup.pkg',
        'GptAccountKeeper.Desktop-osx-arm64-Portable.zip',
        "GptAccountKeeper.Desktop-$Version-osx-arm64.dmg",
        'RELEASES-osx-arm64',
        'releases.osx-arm64.json',
        "GptAccountKeeper.Desktop-$Version-osx-arm64.spdx.json",

        "GptAccountKeeper.Desktop-$Version-osx-x64-full.nupkg",
        'GptAccountKeeper.Desktop-osx-x64-Setup.pkg',
        'GptAccountKeeper.Desktop-osx-x64-Portable.zip',
        "GptAccountKeeper.Desktop-$Version-osx-x64.dmg",
        'RELEASES-osx-x64',
        'releases.osx-x64.json',
        "GptAccountKeeper.Desktop-$Version-osx-x64.spdx.json",

        "GptAccountKeeper.Desktop-$Version-linux-x64-full.nupkg",
        'GptAccountKeeper.Desktop-linux-x64.AppImage',
        'GptAccountKeeper.Desktop-linux-x64.AppImage.minisig',
        'RELEASES-linux-x64',
        'releases.linux-x64.json',
        'releases.linux-x64.json.minisig',
        "GptAccountKeeper.Desktop-$Version-linux-x64.spdx.json",
        'SHA256SUMS.linux-x64.txt',
        'SHA256SUMS.linux-x64.txt.minisig',
        'minisign.pub',

        "chatgpt-account-keeper-$Version-source.zip",
        "mihomo-v$($runtimeVersions.mihomo.version)-source.zip",
        'SHA256SUMS.release.txt'
    )
}

# Uploads artifacts produced locally by build-local-release.ps1. Creates the tag
# and a draft Release, so nothing reaches update clients until PublishDraft runs.
function Send-LocalBuild {
    param(
        [Parameter(Mandatory = $true)]
        [string] $GitHubCli
    )

    $releaseRoot = Join-Path $repositoryRoot 'artifacts\Releases'
    $complianceRoot = Join-Path $repositoryRoot 'artifacts\compliance'
    foreach ($directory in @($releaseRoot, $complianceRoot)) {
        if (-not (Test-Path -LiteralPath $directory)) {
            throw "${directory} does not exist. Run scripts\build-local-release.ps1 -Version $Version first."
        }
    }

    # Only assets for this exact version may ship. A stale delta or full package
    # left over from an earlier build would otherwise be published silently.
    $candidates = @(
        Get-ChildItem $releaseRoot -File | Where-Object {
            $_.Name -in @(
                'GptAccountKeeper.Desktop-win-Setup.exe',
                'GptAccountKeeper.Desktop-win-Portable.zip',
                'RELEASES',
                'releases.win.json',
                'assets.win.json'
            ) -or $_.Name -like "*$Version*"
        }
        Get-ChildItem $complianceRoot -File
    ) | Sort-Object FullName -Unique

    $assetNames = @($candidates | ForEach-Object { $_.Name })
    $missing = @(Get-RequiredAssetName | Where-Object { $_ -notin $assetNames })
    if ($missing.Count -gt 0) {
        throw "The local build is missing required assets: $($missing -join ', ')"
    }

    # Only project-produced files carry the release version. Third-party source
    # archives (mihomo) carry their own upstream version and must not be treated
    # as leftovers from an earlier build.
    $stray = @($candidates | Where-Object {
        ($_.Name -like 'GptAccountKeeper.Desktop-*' -or $_.Name -like 'chatgpt-account-keeper-*') -and
        $_.Name -match '\d+\.\d+\.\d+' -and
        $_.Name -notlike "*$Version*"
    })
    if ($stray.Count -gt 0) {
        throw "artifacts contain files from another version: $(($stray | ForEach-Object { $_.Name }) -join ', '). Rebuild to clear them."
    }

    $setup = $candidates | Where-Object { $_.Name -eq 'GptAccountKeeper.Desktop-win-Setup.exe' } | Select-Object -First 1
    $signature = (Get-AuthenticodeSignature -LiteralPath $setup.FullName).Status
    Write-Host "Installer signature: ${signature} (unsigned is expected)"
    Write-Host "Uploading $($candidates.Count) asset(s) for $tag :"
    $candidates | ForEach-Object { Write-Host ("  {0,-46} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB)) }

    if (-not $PSCmdlet.ShouldProcess("$Repository $tag", 'Create tag and draft GitHub Release from local artifacts')) {
        return
    }

    $existingTag = Invoke-NativeCommand `
        -FilePath 'git.exe' `
        -ArgumentList @('ls-remote', '--tags', 'origin', "refs/tags/$tag") `
        -CaptureOutput
    if ([string]::IsNullOrWhiteSpace($existingTag.Output)) {
        Invoke-NativeCommand -FilePath 'git.exe' -ArgumentList @('tag', '-a', $tag, '-m', "ChatGPT Account Keeper $Version") | Out-Null
        Invoke-NativeCommand -FilePath 'git.exe' -ArgumentList @('push', 'origin', $tag) | Out-Null
        Write-Host "Pushed tag $tag"
    } else {
        Write-Host "Tag $tag already exists on origin; reusing it."
    }

    $notes = @(
        '本版本采用 GNU AGPL-3.0-only，安装包内附许可证、第三方组件声明、隐私说明与对应源码说明（`licenses/` 目录，也可在设置页「关于与许可」打开）。',
        '',
        '**安装包未经数字签名。** Windows 首次运行可能提示「未知发布者」，需点击「更多信息 → 仍要运行」。可用 `SHA256SUMS.release.txt` 核对下载完整性。',
        '',
        '附带项目与 mihomo 对应源码归档及 SPDX SBOM。'
    ) -join [Environment]::NewLine
    $notesFile = Join-Path ([IO.Path]::GetTempPath()) "keeper-notes-$Version.md"
    [IO.File]::WriteAllText($notesFile, $notes, [Text.UTF8Encoding]::new($false))
    try {
        if ($script:ReplaceExistingDraft) {
            $arguments = @(
                'release', 'upload', $tag,
                '--repo', $Repository,
                '--clobber'
            ) + @($candidates | ForEach-Object { $_.FullName })
        } else {
            $arguments = @(
                'release', 'create', $tag,
                '--repo', $Repository,
                '--title', "ChatGPT Account Keeper $Version",
                '--draft',
                '--notes-file', $notesFile
            ) + @($candidates | ForEach-Object { $_.FullName })
        }
        Invoke-NativeCommand -FilePath $GitHubCli -ArgumentList $arguments | Out-Null
    }
    finally {
        Remove-Item -LiteralPath $notesFile -Force -ErrorAction SilentlyContinue
    }

    Write-Host ''
    Write-Host "Draft created: https://github.com/$Repository/releases/tag/$tag"
    Write-Host 'Verify an installed N-1 -> N upgrade, then run:'
    Write-Host "  .\scripts\publish-windows-release.ps1 -Version $Version -Mode PublishDraft"
}

function Publish-ReleaseDraft {
    param(
        [Parameter(Mandatory = $true)]
        [string] $GitHubCli
    )

    $releaseResult = Invoke-NativeCommand `
        -FilePath $GitHubCli `
        -ArgumentList @(
            'release', 'view', $tag,
            '--repo', $Repository,
            '--json', 'assets,isDraft,isPrerelease,url,targetCommitish'
        ) `
        -CaptureOutput
    $release = $releaseResult.Output | ConvertFrom-Json

    if (-not $release.isDraft) {
        throw "Release $tag is already public."
    }
    if ($release.isPrerelease) {
        throw "Release $tag is marked as a prerelease; the stable updater will ignore it."
    }

    $assetNames = @($release.assets | ForEach-Object { $_.name })
    $missingAssets = @(Get-RequiredAssetName | Where-Object { $_ -notin $assetNames })
    if ($missingAssets.Count -gt 0) {
        throw "Release $tag is missing required assets: $($missingAssets -join ', ')"
    }

    Write-Host "Draft release: $($release.url)"
    Write-Host "Target commit: $($release.targetCommitish)"
    Write-Host "Assets: $($assetNames -join ', ')"

    $setup = @($release.assets | Where-Object { $_.name -eq 'GptAccountKeeper.Desktop-win-Setup.exe' })
    if ($setup.Count -eq 1) {
        Write-Host ''
        Write-Host 'All workflow-produced release candidates passed their platform signing gates.'
        Write-Host 'You can independently verify the Windows installer with Get-AuthenticodeSignature.'
    }

    if (-not $PSCmdlet.ShouldProcess("$Repository $tag", 'Publish stable GitHub Release')) {
        return
    }

    Invoke-NativeCommand `
        -FilePath $GitHubCli `
        -ArgumentList @('release', 'edit', $tag, '--repo', $Repository, '--draft=false', '--latest') | Out-Null
    Write-Host "Published: https://github.com/$Repository/releases/tag/$tag"
}

$attestingModes = @('Release', 'UploadDraft')
if ($Mode -in $attestingModes -and -not $NMinusOneVerified) {
    throw "$Mode mode requires -NMinusOneVerified after the installed previous version has been upgraded to this candidate with Agent restart and data intact."
}
if ($Mode -notin $attestingModes -and $NMinusOneVerified) {
    throw "-NMinusOneVerified is only valid with -Mode $($attestingModes -join ' or ')."
}

$githubCli = Resolve-GitHubCli
$originalLocation = Get-Location
try {
    Set-Location -LiteralPath $repositoryRoot
    Invoke-NativeCommand -FilePath $githubCli -ArgumentList @('auth', 'status', '--hostname', 'github.com') | Out-Null

    if ($Mode -eq 'PublishDraft') {
        Publish-ReleaseDraft -GitHubCli $githubCli
        return
    }

    if ($Mode -eq 'UploadDraft') {
        throw 'UploadDraft is no longer supported: a Windows-only local build cannot satisfy the four-platform release gate. Use -Mode Release.'
    }

    $releaseNotes = Read-ReleaseNotes
    Assert-ReleaseSourceReady -GitHubCli $githubCli

    if ($Mode -eq 'Candidate') {
        $runId = Invoke-ReleaseWorkflow `
            -GitHubCli $githubCli `
            -PublishDraft $false `
            -Verified $false
        if ($null -eq $runId) {
            return
        }

        if ([string]::IsNullOrWhiteSpace($CandidateOutputDirectory)) {
            $CandidateOutputDirectory = Join-Path $repositoryRoot "artifacts\candidate-$Version"
        }
        $candidateRoot = [System.IO.Path]::GetFullPath($CandidateOutputDirectory)
        if (Test-Path -LiteralPath $candidateRoot) {
            throw "Candidate output already exists: $candidateRoot"
        }

        Invoke-NativeCommand `
            -FilePath $githubCli `
            -ArgumentList @(
                'run', 'download', $runId,
                '--repo', $Repository,
                '--name', "GptAccountKeeper.Desktop-all-$Version",
                '--dir', $candidateRoot
            ) | Out-Null
        Write-Host "Candidate downloaded to: $candidateRoot"
        return
    }

    $runId = Invoke-ReleaseWorkflow `
        -GitHubCli $githubCli `
        -PublishDraft $true `
        -Verified $true
    if ($null -ne $runId) {
        Write-Host "Draft created for $tag. Review it, then run:"
        Write-Host ".\scripts\publish-windows-release.ps1 -Version $Version -Mode PublishDraft"
    }
}
finally {
    Set-Location -LiteralPath $originalLocation
}
