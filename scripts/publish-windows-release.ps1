[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string] $Version,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Candidate', 'Release', 'PublishDraft')]
    [string] $Mode,

    [switch] $NMinusOneVerified,

    [string] $Repository = 'yang-sanmu/chatgpt-account-keeper',

    [string] $Ref = 'main',

    [string] $CandidateOutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$workflow = 'windows-release.yml'
$tag = "v$Version"
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

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
        $output = & $FilePath @ArgumentList 2>&1
        $exitCode = $LASTEXITCODE
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
        -ArgumentList @('release', 'view', $tag, '--repo', $Repository, '--json', 'tagName') `
        -CaptureOutput `
        -AllowFailure
    if ($existingRelease.ExitCode -eq 0) {
        throw "Release $tag already exists. Use a new version number."
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
        [bool] $Verified
    )

    $arguments = @(
        'workflow', 'run', $workflow,
        '--repo', $Repository,
        '--ref', $Ref,
        '--raw-field', "version=$Version",
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
    $runtimeVersions = Get-Content (Join-Path $repositoryRoot 'build\runtime-versions.json') -Raw | ConvertFrom-Json
    $requiredAssets = @(
        "GptAccountKeeper.Desktop-$Version-full.nupkg",
        'GptAccountKeeper.Desktop-win-Setup.exe',
        'RELEASES',
        'releases.win.json',
        "GptAccountKeeper.Desktop-$Version.spdx.json",
        "chatgpt-account-keeper-$Version-source.zip",
        "mihomo-v$($runtimeVersions.mihomo.version)-source.zip",
        'SHA256SUMS.release.txt'
    )
    $missingAssets = @($requiredAssets | Where-Object { $_ -notin $assetNames })
    if ($missingAssets.Count -gt 0) {
        throw "Release $tag is missing required assets: $($missingAssets -join ', ')"
    }

    Write-Host "Draft release: $($release.url)"
    Write-Host "Target commit: $($release.targetCommitish)"
    Write-Host "Assets: $($assetNames -join ', ')"

    $setup = @($release.assets | Where-Object { $_.name -eq 'GptAccountKeeper.Desktop-win-Setup.exe' })
    if ($setup.Count -eq 1) {
        Write-Host ''
        Write-Host 'Reminder: releases are published unsigned unless a signing certificate is configured.'
        Write-Host 'Verify the installer locally with Get-AuthenticodeSignature if you expect a signature.'
    }

    if (-not $PSCmdlet.ShouldProcess("$Repository $tag", 'Publish stable GitHub Release')) {
        return
    }

    Invoke-NativeCommand `
        -FilePath $GitHubCli `
        -ArgumentList @('release', 'edit', $tag, '--repo', $Repository, '--draft=false', '--latest') | Out-Null
    Write-Host "Published: https://github.com/$Repository/releases/tag/$tag"
}

if ($Mode -eq 'Release' -and -not $NMinusOneVerified) {
    throw 'Release mode requires -NMinusOneVerified after the installed previous version has been upgraded to this candidate with Agent restart and data intact.'
}
if ($Mode -ne 'Release' -and $NMinusOneVerified) {
    throw '-NMinusOneVerified is only valid with -Mode Release.'
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
                '--name', "GptAccountKeeper.Desktop-win-x64-$Version",
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
