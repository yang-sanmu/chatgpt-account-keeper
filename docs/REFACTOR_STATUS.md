# Native C/S refactor requirement status

This document is the executable acceptance ledger for the Avalonia/Agent
refactor. A build, NativeAOT publish, or package smoke test is not sufficient to
mark a product requirement complete.

Status values:

- `DONE`: implemented and covered by an automated or explicit acceptance test.
- `PARTIAL`: foundation exists, but the user workflow or release gate is not
  complete.
- `OPEN`: not implemented.
- `EXTERNAL`: implemented as far as the repository can go, but requires a
  certificate, release approval, or a target-platform machine.
- `DEFERRED`: deliberately moved out of v1 by the revised plan.

A build, NativeAOT publish, or "the page renders" is never sufficient evidence for
a UI row. Score those against `docs/PLAN.md` section 一之二 instead.

## Product acceptance

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Native cross-platform management window | PARTIAL | Windows x64 native window is functional; macOS/Linux release acceptance remains. |
| Interaction is not a regression from the legacy web panel | PARTIAL | Inline account editing, batch operations, route/rotation/stale fields, toasts, a login progress window, per-node latency and structured history are implemented and covered by ViewModel tests. Real multi-account daily use on the packaged build has not been re-run since the rework. |
| No browser/WebView management panel | DONE | Desktop contains native Avalonia controls only; release verifier rejects the legacy web panel. |
| No management `localhost` listener | DONE | Installed Agent uses Named Pipe/Unix socket. Express is a development-only legacy adapter and is excluded from releases. |
| User does not install Node/npm/Git/.NET | DONE | Windows stage includes private Node and NativeAOT Desktop; packaged Agent smoke test covers startup. |
| Background automation survives hidden UI | DONE | Agent is an independent process, owns its diagnostic file, and no longer depends on a Desktop stdout pipe. |
| “Open page” uses the account's real Google Chrome | DONE | Agent uses `playwright-core` with system Chrome only and returns `CHROME_NOT_FOUND`; browser tests cover no-bundled-browser behavior. |
| Visual Studio F5 is usable | DONE | Development launch profile isolates data/IPC, source Agent discovery is tested, and logs are visible from the overview. |

## M0 — baseline and feasibility

| Item | Status | Notes |
| --- | --- | --- |
| Preserve legacy Node behavior tests | DONE | Full Node suite is retained and expanded. |
| Pin Node 24 and Playwright 1.61.1 | DONE | `.node-version`, lock file, and release runtime manifest are pinned. |
| NativeAOT publish gate | DONE | CI and local Windows `dotnet publish` gate warnings as errors. |
| Tray/IPC/VeloPack AOT proof | PARTIAL | NativeAOT startup, tray, packaged IPC lifecycle, private Agent handoff, and VeloPack packaging pass; installer update still needs an N-1 → N installed acceptance run. |

## M1 — application services

| Item | Status | Notes |
| --- | --- | --- |
| Express-independent application services | DONE | Node service dispatcher is independent of Express. |
| Strict account update fields | DONE | Agent allowlist and tests exist. |
| Validate group proxy availability | DONE | Agent fails explicitly instead of silently connecting direct. |
| Force login is the only session-clearing path | DONE | Covered by login-provider tests. |
| Account view exposes every field the UI needs | DONE | `publicAccount` adds rotation progress, group name, resolved exit node (including a missing-node flag) and scheduler next/last/result. The per-list context is computed once instead of once per account. |
| Scheduler state transitions are consistent | DONE | Normal start/stop updates `running` and persisted `enabled` together. Update drain restores the persisted user intent only after manager/account work has settled; a timeout remains stopped instead of starting overlapping work. |
| Store backend cannot swap mid-flight | DONE | Swapping after a write throws instead of silently forking state between JSON and SQLite. |
| Legacy REST equivalence | PARTIAL | Core service tests exist; a complete route-by-route equivalence matrix is still open. |

## M2 — data and migration

| Item | Status | Notes |
| --- | --- | --- |
| Per-user data/cache/state separation | DONE | Node and Desktop platform paths are implemented. |
| SQLite schema and repository | DONE | WAL, foreign keys, busy timeout, migrations, receipts, and backups exist. Schema v2 adds the durable `operations` table; the migration ledger test now asserts version/ledger consistency rather than a frozen count. |
| Custom local fixed-disk data directory | DONE | First-run native picker validates local fixed storage and atomically writes/consumes the bootstrap pointer. |
| Lossless legacy import | PARTIAL | Native preview/progress/lock confirmation and an end-to-end fixture migration pass. A full live copy is intentionally left to the user-confirmed first-run flow. Acceptance is fixture-driven; a specific one-off disk count is deliberately not treated as a repeatable baseline. |
| Persistent scheduler recovery | DONE | Enabled/next/last state and the last result are restored from SQLite; recovery tests cover all four. |

## M3 — Agent and IPC

| Item | Status | Notes |
| --- | --- | --- |
| Per-user single-instance local IPC | DONE | Named Pipe/Unix socket and private credential are implemented. |
| Enforced single Agent per data directory | DONE | A data-directory-scoped Named Pipe/Unix socket is the kernel-held lock; `agent.lock` is diagnostic metadata only. The lock is acquired before migration/database access, survives PID reuse safely, and never kills by process name. |
| Length framing and 8 MiB limit | DONE | Both sides and tests enforce the limit. |
| Hello negotiation and stable errors | DONE | Major/minor hello and stable error codes are implemented. |
| Durable command idempotency | DONE | SQLite receipts are method-scoped and survive restart. |
| Operations and events | DONE | Operations persist in SQLite (schema v2) and survive Agent restarts; long tasks report real `stage` and numeric `progress`; disconnect, sequence-gap and Agent-instance changes trigger reconnect/full bootstrap. |
| Event coverage replaces polling | DONE | Added `scheduler.accountChanged`, `proxyNode.tested` and `history.appended`; open-page state now comes from a browser observer instead of a one-second poll loop. |
| Canonical method input/output schemas | DONE | Separate canonical method schema validates every request parameter and Agent result at runtime, including the newly added `operations.list`, `browser.getTask` and structured history entries. |
| Event continuity detection | DONE | `seq` is scoped to `instanceId` and detects gaps; a gap or instance change deliberately triggers a full bootstrap rather than persistent replay. `revision` remains a candidate for removal in the next protocol major if no snapshot-consistency consumer is added. |

## M4 — native management UI

The first pass marked most of this section DONE against a meaningless bar ("eight
navigation entries show eight distinct pages"). That assertion is testable, passed,
and told us nothing about whether the UI was usable. The rows below are re-scored
against `docs/PLAN.md` section 一之二.

| Item | Status | Notes |
| --- | --- | --- |
| Compiled bindings/source-generated JSON/no reflection DI | DONE | Project gates are enabled and NativeAOT publish succeeds with zero trim/AOT warnings. ViewModels expose `IBrush` rather than requiring runtime colour-string conversion. |
| Layout without nested scrolling | DONE | Each page is its own `UserControl` + ViewModel with a single scroll container; the previous eight-pages-in-one-StackPanel tree and its hardcoded list `MinHeight` values are gone. |
| Refresh never discards in-flight edits | DONE | `EditableField<T>` keeps dirty drafts across refreshes and `CollectionSync` diffs by id, preserving row instances, selection and check state. Both are covered by regression tests. |
| Incremental event application | DONE | Account/status/schedule/open-page/latency/history events update only the affected row; a full `system.bootstrap` is reserved for reconnects, sequence gaps and coarse changes. |
| Complete account management | PARTIAL | Inline editing and batch operations are implemented. Incremental status/open-page changes reapply active filters, immediate saves are serialized, and batch browser operations run one at a time and count terminal successes. Packaged multi-account daily-use acceptance is still required. |
| Group/proxy management | DONE | Create and edit are distinct states. Node rows show server:port, group-local port and colour-graded latency; test results are written back onto the row instead of only reaching the task centre. |
| Conversation management | DONE | Create/edit are distinct states; the non-atomic rename (upsert then remove) now warns about its failure mode before running. |
| Profile management | DONE | The page scans on first activation, supports an orphan-only filter, and archive/purge confirmations state the concrete consequences. |
| History including deleted accounts | DONE | Agent returns a canonical `{time, ok, setName, totalRounds, rounds:[{question, answer}]}` shape; the Desktop renders Q&A bubbles with copy support and never dumps raw JSON at the user. |
| Agent settings | DONE | Settings use dirty-tracked fields, validate before submit, and support reverting. |
| Activity/error center | DONE | Operations are persisted in SQLite, survive Agent restarts, filter by state, and expose copyable stable error codes. Interrupted work from a previous run is marked cancelled rather than appearing to still run. |
| Feedback, confirmation and keyboard | PARTIAL | Top-level toasts, login progress, path actions and primary empty states exist. History/group/filter empty states were repaired; the packaged UI still needs a complete page-by-page visual acceptance pass. |
| Tray and safe exit | DONE | Tray scheduler items follow real scheduler state; close choice can be remembered, window placement persists, blockers prevent unsafe exit, and “Exit all” reconnects an existing Agent without starting a new one merely to stop it. |
| Desktop/Agent data-root isolation | DONE | Mutex and custom-root IPC endpoints are data-directory scoped; the default root keeps the v1 endpoint for upgrade compatibility and hello verifies the canonical data root. Window activation uses a matching data-root signal, so coexisting roots cannot activate each other's window. |

## M5 — Windows install/update

| Item | Status | Notes |
| --- | --- | --- |
| Private runtime stage and no Chromium | DONE | Package verifier, private Agent smoke, and the exact staged Desktop lifecycle pass without a bundled browser or legacy panel. |
| Notify/download/safe-point policies | PARTIAL | The monitor remains alive before a download exists, waits for zero blockers, and failed drain/checkpoint attempts restore status monitoring, scheduling and write availability. Installed N-1 → N acceptance still belongs to the signed-release phase. |
| Signed stable release gate | DEFERRED | Moved out of v1 per the revised plan: it needs Authenticode credentials. The workflow already refuses distributable builds without them. |
| Draft GitHub Release workflow/SBOM/licenses | DONE | The workflow, package verifier, private-runtime licenses and CycloneDX/SPDX SBOM generation are implemented. Upload remains gated by signing and an attested N-1 → N run. |

## M6 — macOS/Linux

| Item | Status | Notes |
| --- | --- | --- |
| Cross-platform paths, sockets, Chrome/mihomo discovery | PARTIAL | Code paths and unit tests exist. |
| macOS arm64/x64 signing, notarization, stapling | DEFERRED | Out of v1: requires macOS runners, Developer ID, and real-machine acceptance. |
| Linux AppImage, Minisign, XDG autostart | DEFERRED | Out of v1. Runtime code exists; release packaging is a separate phase. |

## Windows Alpha gate

The following gate is now automated or explicitly exercised locally:

1. Visual Studio F5 starts a source Agent with isolated development data and
   visible diagnostics.
2. Every navigation item is a separate page ViewModel with its own scroll
   container. (Note: this replaced the old "eight entries show eight distinct
   pages" item, which passed while the UI was still unusable.)
3. First run can preview and migrate a legacy project with progress and clear
   failures.
4. Accounts, groups, proxies, conversations, profiles, history, Agent settings,
   and operations have complete primary workflows, scored against
   `docs/PLAN.md` section 一之二 rather than against "the page renders".
5. Desktop reconnects and takes a full bootstrap snapshot after an event gap or
   Agent instance change; ordinary events are applied incrementally.
6. Full Node (230 tests) and Desktop (38 tests) suites, zero-warning Release
   build, Windows NativeAOT publish, package verification, and private Agent
   smoke all pass.
7. The exact staged Desktop shows its native window, creates a new SQLite data
   root, negotiates protocol 1.1 with the bundled private Agent, reconnects to
   that same Agent after a forced Desktop termination, and stops both processes
   through "Exit all".

During packaged acceptance an invalid embedded icon was found to crash the
NativeAOT executable before the first window. The resource was replaced and a
PNG regression test was added before the final alpha package was generated.

Alpha 2 removed debugger cancellation-exception flooding during legacy import: the
Desktop now waits for the migration-success progress state before probing IPC,
and Windows named-pipe availability timeouts no longer use a cancellation token
as their timeout mechanism. Both the isolated pipe timeout and the complete
native migration workflow assert zero first-chance cancellation exceptions.

Alpha 3 fixes a Windows progress-file sharing race discovered by a real 2.4 GB
migration. Progress is now throttled append-only JSONL, readers permit concurrent
write/delete sharing and ignore an incomplete final record, progress failures
cannot terminate verified migration work, and a normal child exit no longer uses
`ArgumentException` for control flow. The interrupted live migration reused all
27 already-promoted Profiles, copied zero bytes again, promoted a healthy SQLite
database, and passed native Desktop bootstrap/exit acceptance.

Alpha 4 additionally passes the Desktop-selected data/cache/state/runtime roots
through the private Agent launcher, so Visual Studio development mode is fully
isolated from installed runtime caches as well as its database and IPC channel.

Alpha 5 is a presentation-layer rewrite plus the Agent-side gaps it depended on.
It exists because alpha 1–4 shipped a UI that passed every gate in this document
and was still worse to use than the web panel it replaced.

Root cause: the plan contained no verifiable UI or interaction requirements, so
M4 was accepted against technical gates only. Everything below was a real defect
that the old ledger recorded as `DONE`.

Presentation layer (the 2081-line `MainWindowViewModel` and its single 258-line
window were removed):

- Eight pages shared one `StackPanel` behind `IsVisible`, with lists pinned to
  `MinHeight` inside an outer `ScrollViewer`. That produced nested scrolling, no
  scroll reset on navigation, and every control permanently bound. Each page is
  now an independent `UserControl` + ViewModel with one scroll container.
- Every event triggered a full bootstrap that did `Clear()` + `Add()` on each
  collection, which cleared `SelectedItem`, and the selection setter then
  overwrote the right-hand draft fields. With 26 accounts and a 15-minute status
  sweep, editing a note and losing it was routine. Collections now diff by id
  (`CollectionSync`) and drafts are dirty-tracked (`EditableField<T>`); both have
  regression tests.
- Account rows regained inline editing (note, enabled, group, switch rule, window
  counts) and multi-select batch operations. The previous select-then-edit-right-
  panel design made any bulk intent a per-account click.
- Fields the Agent already returned but the UI dropped are now shown: stale
  ("待复核") marker, relative check time with full-timestamp tooltip, exit node
  including a missing-node state, rotation progress, next/last run.
- Login opens a foreground progress window that consumes the `waiting_user`
  stage. Previously the only feedback was "登录已提交：queued · <guid>", with the
  actual state visible only on another page.
- History returns a canonical question/answer shape and renders Q&A bubbles with
  copy support, instead of a single line that fell back to dumping raw JSON.
- Proxy rows show server:port, group-local port and colour-graded latency, with
  test results written back onto the row.
- Toasts replaced the page-bottom status text, which was off-screen on the
  accounts page — the one page where actions are triggered.
- Create and edit are distinct states for groups and conversation sets; combined
  forms silently turned "new" into "edit that row" on a stray click.
- Filters and dropdowns no longer use Chinese display strings as model values.

Agent side:

- Operations are persisted (schema v2) and long tasks report real stage and
  progress. Previously only login reported stages, results lived in memory with a
  200-item cap, and a task that reported intermediate progress finished at that
  last intermediate value, so the progress bar never filled.
- Added `scheduler.accountChanged`, `proxyNode.tested` and `history.appended`;
  removed the one-second open-page poll in favour of a browser observer.
- `running` and the persisted scheduler `enabled` flag now change together, so a
  killed process cannot leave the UI claiming the scheduler runs when it does not.
- Swapping the store backend after a write now throws instead of silently forking
  state between JSON and SQLite.
- The Agent takes a kernel-held data-directory-scoped Named Pipe/Unix socket lock
  before migration or opening the database; `agent.lock` is diagnostic metadata.
  The Desktop holds a matching mutex and activation signal. "Single instance" was
  previously only an assertion in the plan.

Alpha 6 fixes four defects found by actually running the installed layout. All of
them share one root cause the test suite could not see: after installation
`DATA_ROOT` points at `%LOCALAPPDATA%\...\data` while `ROOT` stays at the install
directory, and several call sites mixed the two. Under the CLI/development layout
the two roots are identical, so 208 passing tests never exercised the split.

- `config/selectors.json` is a read-only asset shipped with the version, but four
  call sites read it from the data root, so "open page" and "login" failed with
  `ENOENT` while automated conversations (which used the install root) worked.
  Added `readResourceJson()` with a single resolution order — data-directory
  override first, install-directory default second — and pointed all five call
  sites at it.
- Migration captured `selectorsOverride` and never consumed it, silently dropping
  any selector the user had customised. It is now written into the data directory,
  which is also what makes the override branch above reachable.
- The `profileManager` singleton combined `workspaceRoot: ROOT` with
  `profilesRoot: fromRoot("profiles")`. Since account `profileDir` values are
  relative, every account resolved outside the profiles root and reported
  "Profile 路径不在 profiles 直接子目录中" — breaking account deletion, cache
  cleanup and the background Profile maintenance sweep. `createProfileManager` now
  requires `workspaceRoot` and asserts that `profilesRoot` lives inside it, so the
  same mistake fails at construction rather than when the user clicks delete.
- The SQLite history backend stringified the raw `runOnce` result, which has no
  `time` field, while the JSON backend added one on write. Every record showed
  "未知时间". Both backends now produce the same shape, and the read path falls
  back to the `finished_at` column for rows written before the fix.

Two further defects were found while diagnosing the above:

- `ensureRunning` waited only on `cfg.listeners[0]` before reporting success, but
  mihomo binds its inbound ports one at a time. An account whose exit node was, say,
  the fourth of nine got `ERR_PROXY_CONNECTION_FAILED` — intermittently, and only
  for some accounts, which is why it looked like a proxy configuration problem.
  Readiness now waits for every inbound port (extracted as `waitAllPortsReady` so
  it is directly testable) and gives up immediately if our own process exited,
  rather than mistaking a third party's listener on the same port for success.
- The default port block (21000+) can collide with the user's Clash Verge inbound
  ports. The sidecar now probes and steps aside to a free block instead of starting
  on top of the collision. It never terminates the occupying process: killing
  mihomo by image name would cut the user's own network.

`test/installedLayout.test.js`, `test/proxyReadiness.test.js` and
`test/resourcePaths.test.js` cover these in a genuinely split layout. Because
`paths.js` freezes the roots into module-level constants and the module cache
cannot be reset in-process, those cases run the code in a child process with an
injected data root. Each new test was verified by temporarily reverting its fix and
confirming it goes red — which caught two tests that had been passing vacuously.

The generated artifact remains an unsigned internal build. SBOM and license
generation are automated; signing, the installed N-1 → N update run, macOS
notarization and Linux AppImage/Minisign remain separate release phases and are
not implied by the Windows Alpha label.

The Alpha 6 review follow-up closes lifecycle and release-integrity gaps found by
the full Git review: safe-point monitoring no longer exits before the delayed
update check, failed update preparation restores the previous runtime state,
“Exit all” reconnects before deciding no Agent exists, incremental account events
reapply filters, batch browser operations are explicitly sequential, concurrent
cross-method command-id reuse is rejected, release staging stamps one version into
the Desktop and private Agent, data-root-scoped activation reaches only the matching
Desktop instance, and Visual Studio/TestResults artifacts are ignored.

A final submission review then removed release-only fallbacks to source files and
PATH `node`, made update-drain timeouts real instead of waiting indefinitely during
recovery, delayed scheduler-intent restoration until drain completion, preserved
the shutdown reason through the Agent wrapper, reported asynchronous shutdown
failures, normalized durable cross-method command-id reuse as validation, retried
only transient Windows Profile rename failures, and canonicalized the Desktop
single-instance scope. Exit/update lifecycle probes now reconnect only to an
already-running Agent and never launch one as a side effect.

The final Alpha 6 gate is 230 Node tests (passed twice), 38 Desktop tests, a
zero-warning NativeAOT publish, release-content verification, and an
installed-layout private-Agent IPC/SQLite smoke test.

Still open after this pass: `seq`/`revision` replay semantics, the route-by-route
legacy REST equivalence matrix, and real multi-account daily use of the packaged
build. The install-layout defects above are a reminder that the packaged build is
the only place several of these problems are observable.
