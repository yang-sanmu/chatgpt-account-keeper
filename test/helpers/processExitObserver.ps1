param([Parameter(Mandatory = $true)][string]$ProcessIds)

$ErrorActionPreference = 'Stop'
$watched = [System.Collections.Generic.List[object]]::new()

function Write-Snapshot([string]$kind) {
    $items = @($watched | ForEach-Object {
        # The Process owns an already-open handle. Never look up this PID again:
        # a terminated process can leave a retained object or its PID can be reused.
        $exited = $_.Process.WaitForExit(0)
        [pscustomobject]@{
            pid = $_.Id
            creationFileTime = $_.CreationFileTime
            state = $(if ($exited) { 'exited' } else { 'running' })
            exitCode = $(if ($exited) { $_.Process.ExitCode } else { $null })
        }
    })
    [Console]::Out.WriteLine((@{ kind = $kind; processes = $items } | ConvertTo-Json -Depth 4 -Compress))
}

try {
    if ($ProcessIds -notmatch '^[1-9][0-9]*(,[1-9][0-9]*)*$') { throw 'Invalid process list' }
    foreach ($value in $ProcessIds.Split(',')) {
        $observedProcess = [System.Diagnostics.Process]::GetProcessById([int]$value)
        try {
            # Hold only process handles, never Job handles; this cannot prevent
            # KILL_ON_JOB_CLOSE from firing when the broker releases its Job.
            [void]$observedProcess.Handle
            $watched.Add([pscustomobject]@{
                Id = [int]$value
                CreationFileTime = $observedProcess.StartTime.ToFileTimeUtc().ToString()
                Process = $observedProcess
            })
        } catch {
            $observedProcess.Dispose()
            throw
        }
    }
    Write-Snapshot 'ready'
    while ($null -ne ($command = [Console]::In.ReadLine())) {
        if ($command -eq 'close') { break }
        if ($command -ne 'snapshot') { throw 'Unknown observer command' }
        Write-Snapshot 'snapshot'
    }
} catch {
    # No command lines, executable paths, environment variables or profile data.
    [Console]::Out.WriteLine('{"kind":"error","code":"PROCESS_OBSERVATION_FAILED"}')
    exit 1
} finally {
    foreach ($item in $watched) { $item.Process.Dispose() }
}
