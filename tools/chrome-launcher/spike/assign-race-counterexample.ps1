# §10.3 counter-example, kept as a permanent regression artifact.
#
# Proves that "ordinary spawn, then AssignProcessToJobObject" leaks descendants, which
# is why the plan mandates creation-time containment (PROC_THREAD_ATTRIBUTE_JOB_LIST).
#
# Critically, the assign must happen only AFTER the child is confirmed to have spawned
# its own grandchild. Sampling with a fixed delay systematically hides the window:
# interpreter/runtime startup can be slower than the delay, so the grandchild does not
# exist yet and the test reports a false pass.
#
# Expected: EXPECTED_ESCAPE=True (the old approach is broken).
# If this ever prints False, the counter-example has stopped being valid and the
# containment argument must be re-derived before trusting it.

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Race -Name K -MemberDefinition '
[DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateJobObject(IntPtr j, uint c);
[DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(int a, bool b, int p);
[DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
'

function New-KillJob {
  $j = [Race.K]::CreateJobObject([IntPtr]::Zero, $null)
  $b = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
  0..17 | ForEach-Object { [Runtime.InteropServices.Marshal]::WriteInt64($b, $_ * 8, 0) }
  [Runtime.InteropServices.Marshal]::WriteInt32($b, 16, 0x2000)  # KILL_ON_JOB_CLOSE
  [void][Race.K]::SetInformationJobObject($j, 9, $b, 144)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($b)
  return $j
}

function Test-InJob($job, $processId) {
  $h = [Race.K]::OpenProcess(0x1000, $false, $processId)
  if ($h -eq [IntPtr]::Zero) { return 'gone' }
  $r = $false
  [void][Race.K]::IsProcessInJob($h, $job, [ref]$r)
  [void][Race.K]::CloseHandle($h)
  return $r
}

$job = New-KillJob
# "Agent" stub whose first action is to spawn a "broker" grandchild.
$inner = 'Start-Process powershell.exe -ArgumentList ''-NoProfile'',''-Command'',''Start-Sleep -Seconds 45'' -WindowStyle Hidden; Start-Sleep -Seconds 45'
$agent = Start-Process powershell.exe -ArgumentList '-NoProfile', '-Command', $inner -PassThru -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(25)
$broker = $null
while ((Get-Date) -lt $deadline) {
  $broker = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.ParentProcessId -eq $agent.Id })
  if ($broker.Count -gt 0) { break }
  Start-Sleep -Milliseconds 100
}
if (-not $broker -or $broker.Count -eq 0) { throw "grandchild never spawned; cannot exercise the window" }
$brokerPid = [int]$broker[0].ProcessId

# The production sequence being refuted: assign the parent AFTER the grandchild exists.
$agentHandle = [Race.K]::OpenProcess(0x1F0FFF, $false, $agent.Id)
$assigned = [Race.K]::AssignProcessToJobObject($job, $agentHandle)
Start-Sleep -Seconds 2

$agentInJob = Test-InJob $job $agent.Id
$brokerInJob = Test-InJob $job $brokerPid

Write-Host "assignOk        = $assigned"
Write-Host "agentInJob      = $agentInJob"
Write-Host "brokerInJob     = $brokerInJob"

# Also show that the outer job cannot reclaim what never joined it.
[void][Race.K]::TerminateJobObject($job, 1)
Start-Sleep -Seconds 2
$brokerSurvived = [bool](Get-CimInstance Win32_Process -Filter "ProcessId=$brokerPid" -EA SilentlyContinue)
Write-Host "brokerSurvivedJobTerminate = $brokerSurvived"
Write-Host "EXPECTED_ESCAPE = $(($brokerInJob -eq $false) -and $brokerSurvived)"

Get-Process -Id $agent.Id -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Get-Process -Id $brokerPid -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
[void][Race.K]::CloseHandle($agentHandle)
[void][Race.K]::CloseHandle($job)
if (($brokerInJob -eq $false) -and $brokerSurvived) { exit 0 } else { exit 1 }
