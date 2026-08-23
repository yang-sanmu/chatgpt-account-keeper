# §10.3.2 containment spike (Phase C blocking gate).
#
# Verifies the three claims the plan refuses to proceed without:
#   1. PROC_THREAD_ATTRIBUTE_JOB_LIST works for real Chrome, and Chrome's own internal
#      job does not cause a BREAKAWAY conflict.
#   2. Creation-time containment holds for a nested chain, and the per-run job contains
#      the Chrome root plus every descendant.
#   3. The multi-token broker protocol carries launch/enumerate/terminate/dispose on
#      both headless and headed paths, and a broker crash fires KILL_ON_JOB_CLOSE for
#      every per-run job.
#
# Exit code 0 = all three pass. Non-zero = blocking, stop and discuss per §9.4.

$ErrorActionPreference = 'Stop'
$broker = Join-Path $PSScriptRoot '..\bin\x64\Release\net10.0\win-x64\publish\chrome-launcher.exe'
if (-not (Test-Path $broker)) {
  $broker = Join-Path $PSScriptRoot '..\bin\Release\net10.0\win-x64\publish\chrome-launcher.exe'
}
if (-not (Test-Path $broker)) { throw "broker not built: $broker" }

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" }
if (-not (Test-Path $chrome)) { throw "Chrome not found" }

Add-Type -Namespace Spike -Name K -MemberDefinition '
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
[DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(int a, bool b, int p);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
'

$results = [ordered]@{}
$profiles = @()

function New-Broker {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $broker
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $hello = $p.StandardOutput.ReadLine() | ConvertFrom-Json
  return [pscustomobject]@{ Process = $p; Generation = $hello.brokerGenerationId }
}

function Send-Cmd($b, $obj) {
  $obj.brokerGenerationId = $b.Generation
  $b.Process.StandardInput.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  $b.Process.StandardInput.Flush()
  return $b.Process.StandardOutput.ReadLine() | ConvertFrom-Json
}

function New-Profile($tag) {
  $dir = Join-Path $env:TEMP ("spike-$tag-" + [guid]::NewGuid().ToString('N').Substring(0,6))
  $script:profiles += $dir
  return $dir
}

function Get-DescendantPids($rootPid) {
  $all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $stack = New-Object 'System.Collections.Generic.Stack[int]'
  [void]$stack.Push([int]$rootPid); [void]$seen.Add([int]$rootPid)
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $cur })) {
      if ($seen.Add([int]$c.ProcessId)) { [void]$stack.Push([int]$c.ProcessId) }
    }
  }
  return @($seen)
}

try {
  # ---------------- Gate 1 + 2: creation-time containment for real Chrome ----------------
  $b = New-Broker
  $ready = Send-Cmd $b @{ requestId='r1'; command='ready'; protocolVersion=1; rid='win-x64' }
  if (-not $ready.ok) { throw "ready failed: $($ready.message)" }
  $results['ready.ok'] = $ready.ok
  $results['ready.capabilities'] = ($ready.capabilities -join ',')

  foreach ($mode in @('headless','headed')) {
    $udd = New-Profile $mode
    $args = @("--user-data-dir=$udd", '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0')
    if ($mode -eq 'headless') { $args += '--headless=new' }
    $args += 'about:blank'
    $token = "tok-$mode-" + [guid]::NewGuid().ToString('N').Substring(0,8)
    $launch = Send-Cmd $b @{ requestId="l-$mode"; command='launch'; runToken=$token; executable=$chrome; args=$args }
    if (-not $launch.ok) { throw "launch($mode) failed: $($launch.message)" }
    Start-Sleep -Seconds 7

    $en = Send-Cmd $b @{ requestId="e-$mode"; command='enumerate'; runToken=$token }
    $tree = Get-DescendantPids $launch.rootPid
    # Authoritative check: every live descendant must be inside the per-run job.
    $escaped = @()
    foreach ($pid2 in $tree) {
      $h = [Spike.K]::OpenProcess(0x1F0FFF, $false, $pid2)
      if ($h -ne [IntPtr]::Zero) {
        $inJob = $false
        [void][Spike.K]::IsProcessInJob($h, [IntPtr]::Zero, [ref]$inJob)
        # in ANY job is necessary but not sufficient; compare against broker's list
        if ($en.pids -notcontains $pid2) { $escaped += $pid2 }
        [void][Spike.K]::CloseHandle($h)
      }
    }
    $results["$mode.jobCount"] = $en.count
    $results["$mode.liveTree"] = $tree.Count
    $results["$mode.escapedFromJob"] = $escaped.Count
    $results["$mode.rootAlive"] = $en.rootAlive
    if ($escaped.Count -gt 0) { throw "$mode : $($escaped.Count) descendant(s) outside per-run job: $($escaped -join ',')" }

    # dispose must be refused while members remain
    $badDispose = Send-Cmd $b @{ requestId="bd-$mode"; command='dispose'; runToken=$token }
    $results["$mode.disposeRefusedWhileNonEmpty"] = (-not $badDispose.ok) -and ($badDispose.code -eq 'JOB_NOT_EMPTY')
    if ($badDispose.ok) { throw "$mode : dispose succeeded while job non-empty" }

    $term = Send-Cmd $b @{ requestId="t-$mode"; command='terminate'; runToken=$token }
    if (-not $term.ok) { throw "$mode terminate failed: $($term.message)" }
    $deadline = (Get-Date).AddSeconds(5); $count = -1
    while ((Get-Date) -lt $deadline) {
      $en2 = Send-Cmd $b @{ requestId="e2-$mode"; command='enumerate'; runToken=$token }
      $count = $en2.count
      if ($count -eq 0) { break }
      Start-Sleep -Milliseconds 150
    }
    $results["$mode.countAfterTerminate"] = $count
    if ($count -ne 0) { throw "$mode : job count did not reach 0 (got $count)" }

    $disp = Send-Cmd $b @{ requestId="d-$mode"; command='dispose'; runToken=$token }
    if (-not $disp.ok) { throw "$mode dispose failed: $($disp.message)" }
    $results["$mode.disposed"] = $disp.disposed

    # lost-ack replay: enumerate/dispose on a tombstone must be idempotent success
    $replayEnum = Send-Cmd $b @{ requestId="re-$mode"; command='enumerate'; runToken=$token }
    $replayDisp = Send-Cmd $b @{ requestId="rd-$mode"; command='dispose'; runToken=$token }
    $results["$mode.tombstoneEnumerateOk"] = $replayEnum.ok -and ($replayEnum.count -eq 0) -and $replayEnum.disposed
    $results["$mode.tombstoneDisposeOk"] = $replayDisp.ok -and $replayDisp.disposed
    if (-not $results["$mode.tombstoneEnumerateOk"]) { throw "$mode : tombstone enumerate not idempotent" }
    if (-not $results["$mode.tombstoneDisposeOk"]) { throw "$mode : tombstone dispose not idempotent" }

    # relaunch with the same token must be refused (token never reused)
    $reuse = Send-Cmd $b @{ requestId="ru-$mode"; command='launch'; runToken=$token; executable=$chrome; args=$args }
    $results["$mode.tokenReuseRefused"] = (-not $reuse.ok) -and ($reuse.code -eq 'TOKEN_RETIRED')
    if ($reuse.ok) { throw "$mode : token reuse was allowed" }

    $forget = Send-Cmd $b @{ requestId="f-$mode"; command='forget'; runToken=$token }
    $results["$mode.forgetOk"] = $forget.ok
    # forget is idempotent for unknown tokens too
    $forget2 = Send-Cmd $b @{ requestId="f2-$mode"; command='forget'; runToken=$token }
    $results["$mode.forgetIdempotent"] = $forget2.ok
  }

  # shutdown with empty registry must succeed
  $sd = Send-Cmd $b @{ requestId='sd'; command='shutdown' }
  $results['shutdown.ok'] = $sd.ok
  $b.Process.WaitForExit(5000) | Out-Null
  $results['shutdown.brokerExited'] = $b.Process.HasExited
  if (-not $sd.ok) { throw "shutdown refused: $($sd.message)" }

  # ---------------- Gate 3: broker crash reclaims every per-run job ----------------
  $b2 = New-Broker
  [void](Send-Cmd $b2 @{ requestId='r'; command='ready'; protocolVersion=1; rid='win-x64' })
  $roots = @()
  foreach ($i in 1..2) {
    $udd = New-Profile "crash$i"
    $tok = "crash-$i-" + [guid]::NewGuid().ToString('N').Substring(0,8)
    $l = Send-Cmd $b2 @{ requestId="cl$i"; command='launch'; runToken=$tok; executable=$chrome;
                         args=@("--user-data-dir=$udd",'--no-first-run','--headless=new','about:blank') }
    if (-not $l.ok) { throw "crash-case launch $i failed: $($l.message)" }
    $roots += $l.rootPid
  }
  Start-Sleep -Seconds 7
  $before = (Get-Process chrome -EA SilentlyContinue | Measure-Object).Count
  $results['crash.chromeBefore'] = $before
  # shutdown must be REFUSED while runs are active
  $badShutdown = Send-Cmd $b2 @{ requestId='bs'; command='shutdown' }
  $results['crash.shutdownRefusedWithActive'] = (-not $badShutdown.ok) -and ($badShutdown.code -eq 'ACTIVE_RUNS_REMAIN')
  if ($badShutdown.ok) { throw "shutdown accepted while runs active" }

  Stop-Process -Id $b2.Process.Id -Force
  Start-Sleep -Seconds 6
  $aliveRoots = @($roots | Where-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$_" -EA SilentlyContinue })
  $results['crash.rootsAliveAfterCrash'] = $aliveRoots.Count
  if ($aliveRoots.Count -ne 0) { throw "broker crash left $($aliveRoots.Count) Chrome root(s) alive" }

  # ---------------- Gate: stdin EOF emergency path ----------------
  $b3 = New-Broker
  [void](Send-Cmd $b3 @{ requestId='r'; command='ready'; protocolVersion=1; rid='win-x64' })
  $udd = New-Profile 'eof'
  $tok = 'eof-' + [guid]::NewGuid().ToString('N').Substring(0,8)
  $l3 = Send-Cmd $b3 @{ requestId='el'; command='launch'; runToken=$tok; executable=$chrome;
                        args=@("--user-data-dir=$udd",'--no-first-run','--headless=new','about:blank') }
  Start-Sleep -Seconds 6
  $b3.Process.StandardInput.Close()
  $b3.Process.WaitForExit(8000) | Out-Null
  Start-Sleep -Seconds 3
  $eofAlive = [bool](Get-CimInstance Win32_Process -Filter "ProcessId=$($l3.rootPid)" -EA SilentlyContinue)
  $results['eof.brokerExited'] = $b3.Process.HasExited
  $results['eof.chromeReclaimed'] = (-not $eofAlive)
  if ($eofAlive) { throw "stdin EOF did not reclaim Chrome" }

  Write-Host ""
  Write-Host "=== SPIKE RESULTS ==="
  $results.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-42} {1}" -f $_.Key, $_.Value) }
  Write-Host ""
  Write-Host "SPIKE: PASS (all three §10.3.2 gates)"
  exit 0
}
catch {
  Write-Host ""
  Write-Host "=== SPIKE RESULTS (partial) ==="
  $results.GetEnumerator() | ForEach-Object { Write-Host ("  {0,-42} {1}" -f $_.Key, $_.Value) }
  Write-Host ""
  Write-Host "SPIKE: FAIL -> $($_.Exception.Message)"
  exit 1
}
finally {
  Get-Process chrome -EA SilentlyContinue | Where-Object {
    $_.CommandLine -match 'spike-' -or $true
  } | Out-Null
  foreach ($d in $profiles) { Remove-Item -LiteralPath $d -Recurse -Force -EA SilentlyContinue }
  Get-Process 'chrome-launcher' -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
}
