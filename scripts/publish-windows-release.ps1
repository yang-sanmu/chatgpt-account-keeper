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

    # One-time authorization for v0.2.1. This publishes directly while retaining
    # updater signatures and all build and asset-integrity gates.
    [switch] $PublishUnsignedV021,

    # Required when making the Draft public. Covers the real Tauri updater run
    # plus the deb/rpm no-self-update and Linux compatibility checks.
    [switch] $UpdaterVerified,

    [string] $Repository = 'yang-sanmu/chatgpt-account-keeper',

    [string] $Ref = 'main',

    [string] $CandidateOutputDirectory,

    # Required when Candidate/Release starts a build. The Markdown is embedded
    # in latest.json and shown in the Tauri update prompt.
    [string] $ReleaseNotesFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workflow = 'windows-release.yml'
$tag = "v$Version"
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
        [string] $GitHubCli
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
        throw "Release $tag already exists. Delete the failed Draft or use a new version number."
    }

    $existingTag = Invoke-NativeCommand `
        -FilePath 'git.exe' `
        -ArgumentList @('ls-remote', '--tags', 'origin', "refs/tags/$tag") `
        -CaptureOutput
    if (-not [string]::IsNullOrWhiteSpace($existingTag.Output)) {
        throw "Tag $tag already exists on origin. Use a new version number."
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
        [bool] $Verified,

        [Parameter(Mandatory = $true)]
        [bool] $PublishUnsignedV021
    )

    $arguments = @(
        'workflow', 'run', $workflow,
        '--repo', $Repository,
        '--ref', $Ref,
        '--raw-field', "version=$Version",
        '--raw-field', "release_notes=$releaseNotes",
        '--raw-field', "publish_draft=$($PublishDraft.ToString().ToLowerInvariant())",
        '--raw-field', "n_minus_one_verified=$($Verified.ToString().ToLowerInvariant())",
        '--raw-field', "publish_unsigned_v0_2_1=$($PublishUnsignedV021.ToString().ToLowerInvariant())"
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
        "ChatGPT-Account-Keeper_${Version}_windows_x86_64-setup.exe",
        "ChatGPT-Account-Keeper_${Version}_windows_x86_64-setup.exe.sig",
        "ChatGPT-Account-Keeper_${Version}_win-x64-agent.cdx.json",

        "ChatGPT-Account-Keeper_${Version}_darwin_aarch64.dmg",
        "ChatGPT-Account-Keeper_${Version}_darwin_aarch64.app.tar.gz",
        "ChatGPT-Account-Keeper_${Version}_darwin_aarch64.app.tar.gz.sig",
        "ChatGPT-Account-Keeper_${Version}_osx-arm64-agent.cdx.json",

        "ChatGPT-Account-Keeper_${Version}_darwin_x86_64.dmg",
        "ChatGPT-Account-Keeper_${Version}_darwin_x86_64.app.tar.gz",
        "ChatGPT-Account-Keeper_${Version}_darwin_x86_64.app.tar.gz.sig",
        "ChatGPT-Account-Keeper_${Version}_osx-x64-agent.cdx.json",

        "ChatGPT-Account-Keeper_${Version}_linux_x86_64.AppImage",
        "ChatGPT-Account-Keeper_${Version}_linux_x86_64.AppImage.sig",
        "ChatGPT-Account-Keeper_${Version}_linux_x86_64.AppImage.minisig",
        "ChatGPT-Account-Keeper_${Version}_linux_x86_64.deb",
        "ChatGPT-Account-Keeper_${Version}_linux_x86_64.rpm",
        "ChatGPT-Account-Keeper_${Version}_linux-x64-agent.cdx.json",
        'SHA256SUMS.linux-x64.txt',
        'SHA256SUMS.linux-x64.txt.minisig',
        'minisign.pub',

        "chatgpt-account-keeper-$Version-source.zip",
        "mihomo-v$($runtimeVersions.mihomo.version)-source.zip",
        'latest.json',
        'SHA256SUMS.release.txt'
    )
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

    $setup = @($release.assets | Where-Object { $_.name -eq "ChatGPT-Account-Keeper_${Version}_windows_x86_64-setup.exe" })
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

$attestingModes = @('Release')
if ($Mode -eq 'UploadDraft') {
    throw 'UploadDraft is no longer supported: a Windows-only local build cannot satisfy the four-platform release gate. Use -Mode Release.'
}
if ($PublishUnsignedV021 -and $Mode -ne 'Release') {
    throw '-PublishUnsignedV021 is only valid with -Mode Release.'
}
if ($PublishUnsignedV021 -and $Version -ne '0.2.1') {
    throw '-PublishUnsignedV021 is permanently restricted to version 0.2.1.'
}
if ($PublishUnsignedV021 -and $NMinusOneVerified) {
    throw '-PublishUnsignedV021 cannot be combined with -NMinusOneVerified.'
}
if ($Mode -in $attestingModes -and -not $NMinusOneVerified -and -not $PublishUnsignedV021) {
    throw "$Mode mode requires -NMinusOneVerified after the installed previous version has been upgraded to this candidate with Agent restart and data intact."
}
if ($Mode -notin $attestingModes -and $NMinusOneVerified) {
    throw "-NMinusOneVerified is only valid with -Mode $($attestingModes -join ' or ')."
}
if ($Mode -eq 'PublishDraft' -and -not $UpdaterVerified) {
    throw 'PublishDraft requires -UpdaterVerified after Windows, macOS and AppImage have completed a real N to N+1 updater run.'
}
if ($Mode -ne 'PublishDraft' -and $UpdaterVerified) {
    throw '-UpdaterVerified is only valid with -Mode PublishDraft.'
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

    $releaseNotes = Read-ReleaseNotes
    Assert-ReleaseSourceReady -GitHubCli $githubCli

    if ($Mode -eq 'Candidate') {
        $runId = Invoke-ReleaseWorkflow `
            -GitHubCli $githubCli `
            -PublishDraft $false `
            -Verified $false `
            -PublishUnsignedV021 $false
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
                '--name', "ChatGPT-Account-Keeper-all-$Version",
                '--dir', $candidateRoot
            ) | Out-Null
        Write-Host "Candidate downloaded to: $candidateRoot"
        return
    }

    $runId = Invoke-ReleaseWorkflow `
        -GitHubCli $githubCli `
        -PublishDraft (-not $PublishUnsignedV021.IsPresent) `
        -Verified $NMinusOneVerified.IsPresent `
        -PublishUnsignedV021 $PublishUnsignedV021.IsPresent
    if ($null -ne $runId) {
        if ($PublishUnsignedV021) {
            Write-Host "Public unsigned release created: https://github.com/$Repository/releases/tag/$tag"
        }
        else {
            Write-Host "Draft created for $tag. Review it, then run:"
            Write-Host ".\scripts\publish-windows-release.ps1 -Version $Version -Mode PublishDraft -UpdaterVerified"
        }
    }
}
finally {
    Set-Location -LiteralPath $originalLocation
}
