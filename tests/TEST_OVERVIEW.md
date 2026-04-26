# Codesys-MCP — test overview, tool inventory, broken-tool deep dive

A complete map of the **37 tools** registered in [`src/server.ts`](../src/server.ts), with current working/broken status, what each one does, **measured** timings in **headless** vs **persistent** mode, and a deep-dive + landed fix for each broken tool.

For runnable benchmarks see [`bench.mjs`](bench.mjs):

```bash
node tests/bench.mjs --modes headless,persistent --iterations 2 --out tests/bench-results.json
```

The benchmark drives `HeadlessExecutor` and `CodesysLauncher` directly (no MCP server in the loop), copies the source `.project` to a temp dir so write tools don't mutate the real binary, and emits a markdown table to stdout plus raw JSON to `--out`. Latest run captured in [`bench-results.json`](bench-results.json).

## Headline result: persistent is ~15–20× faster

Measured on MCPTest2 (PLCWinNT target, 5 library refs, 9 POUs) on Windows 11 / SSD with CODESYS V3.5 SP22 Patch 1.

### v5 sweep — 2026-04-26 (persistent only, MCPTest2 v1.3.4.0)

Latest sweep: persistent mode only, 10/10 cases PASS including `set_pou_code` (was failing in v1 due to a bench harness bug — wrong parameter names; fixed inline this run). Times are noticeably faster across the board vs the v1 sweep — likely the combined effect of the ScriptManager cache removal ([`32e6120`](https://github.com/phobicdotno/Codesys-MCP/commit/32e6120)) plus general SP22 Patch 1 IPC improvements. Raw JSON: [`bench-results-v5.json`](bench-results-v5.json).

| Tool | Persistent v5 (mean) | Persistent v1 (mean) | Δ |
|---|---:|---:|---:|
| `open_project` (first cold) | 10.6 s | 7.7 s | slower (one-shot) |
| `open_project` (already-open warm) | 314 ms | 740 ms | **2.4× faster** |
| `mirror_export` | 724 ms | 1.55 s | **2.1× faster** |
| `list_project_libraries` | 732 ms | 1.56 s | **2.1× faster** |
| `get_all_pou_code` | 329 ms | 1.61 s | **4.9× faster** |
| `save_project` | 1.13 s | 2.10 s | **1.9× faster** |
| `create_pou (FB)` | 722 ms | 1.54 s | **2.1× faster** |
| `set_pou_code (decl+impl)` | **729 ms ✅ FIRST PASS** | (bench harness broken) | n/a |
| `delete_object` | 725 ms | 1.54 s | **2.1× faster** |
| `bump_project_version` (build) | 728 ms | 1.54 s | **2.1× faster** |
| `bump_project_version` (build #2) | 1.53 s | 1.56 s | ~same |

Persistent CODESYS launch: 52.8 s (cold, first launch of the session). Subsequent tool calls average ~700-800 ms.

**Bench harness fix:** `set_pou_code` previously failed because the bench passed `POU_PATH` / `DECLARATION_CODE` / `IMPLEMENTATION_CODE` while the script template expects `POU_FULL_PATH` / `DECLARATION_CONTENT` / `IMPLEMENTATION_CONTENT`. Also added the `SET_DECLARATION` / `SET_IMPLEMENTATION` boolean flags now required after [`35abc8c`](https://github.com/phobicdotno/Codesys-MCP/commit/35abc8c) (omitted-decl wipe fix). The earlier "multi-line code escaping" hypothesis turned out to be wrong; the params were just misnamed.

### v1 sweep — historical (both modes)

| Tool | Persistent (mean) | Headless (mean) | Speed-up |
|---|---:|---:|---:|
| `open_project` | 7.7 s (0.74 s warm) | 40.0 s | ~5× (first call) — 50× warm |
| `mirror_export` | 1.55 s | 23.7 s | **15×** |
| `list_project_libraries` | 1.56 s | 23.3 s | **15×** |
| `get_all_pou_code` | 1.61 s | 23.4 s | **15×** |
| `save_project` | 2.10 s | 23.3 s | 11× |
| `create_pou (FB)` | 1.54 s | 23.9 s | 16× |
| `delete_object` | 1.54 s | 27.4 s | 18× |
| `bump_project_version` (build) | 1.54 s | 30.7 s | **20×** |
| `bump_project_version` (build #2) | 1.56 s | 37.8 s | 24× |

Headless mode pays the full CODESYS startup cost (~22 s after the first warm-up; 58 s on first cold call) on every single tool call. Persistent mode pays it once at launch (~14.6 s in v1, ~52.8 s in v5) and then every subsequent call is sub-second of pure script execution + IPC overhead.

## Mode primer

| Mode | Per-call overhead | First-call cost | Best for |
|---|---|---|---|
| **headless** | full CODESYS `--noUI` startup on **every** call (~22 s warm, 58 s on first cold call from process start) | ~58 s (first-ever cold), ~22 s (subsequent) | One-shot scripts, CI, tools that don't share state. Cleaner — no stale in-memory tree drift. |
| **persistent** | IPC poll (~250 ms) + Python execution (~1.5 s typical) | ~14.6 s on first launch only; subsequent calls are sub-second | Interactive editing sessions where many calls land on the same project. Watch out for in-memory drift after long sessions (see fork-fix history below). |

The orchestrator's `release_project_version` recently grew a **post-bump sanity check** ([commit `53c7a0c`](https://github.com/phobicdotno/Codesys-MCP/commit/53c7a0c)) that compares the bumped version against the latest `v*` git tag and aborts before any commit/tag/push if the new version isn't strictly greater — a defense against in-memory drift that can fool the in-script pi-vs-GVL cross-check ([commit `b42e104`](https://github.com/phobicdotno/Codesys-MCP/commit/b42e104)).

## Tool inventory (all 37)

Status legend: **✅ working** • **⚠ degraded** (works but with known gotchas) • **❌ broken** (deep-dive below).

### Process / lifecycle (3)

| Tool | Status | What it does | Persistent (typical) | Headless (typical) |
|---|---|---|---|---|
| `get_codesys_status` | ✅ | Returns state/PID/session of the persistent watcher (or "stopped, headless" if not running) | < 5 ms (no CODESYS roundtrip) | < 5 ms |
| `launch_codesys` | ✅ | Spawns `CODESYS.exe` + watcher, blocks until ready | 5–15 s (one-time) | n/a (each call spawns) |
| `shutdown_codesys` | ✅ | Tells the watcher to exit; orphan-PID kill in `launcher.ts` for stragglers | 1–3 s | n/a |

### Project lifecycle (3)

| Tool | Status | What it does | Persistent (warm) | Headless |
|---|---|---|---|---|
| `open_project` | ✅ (fixed [`2607063`](https://github.com/phobicdotno/Codesys-MCP/commit/2607063), runtime verification pending) | Opens a `.project` file (sets it as primary). Cross-project switch now does save+close+500ms-pump+open instead of relying on CODESYS to demote the prior project. | 7.7 s (first open of session, measured); ~0.74 s (already open, measured) | 22–58 s (measured) |
| `create_project` | ✅ | Creates a new project from a template (Standard or empty) and saves it | 3–8 s | 8–18 s |
| `save_project` | ✅ | Calls `primary_project.save()`. No-op-fast when no in-memory changes | 1.5–2.7 s (measured) | 23.1–23.6 s (measured) |

### POU / object editing (8)

| Tool | Status | What it does | Persistent | Headless |
|---|---|---|---|---|
| `create_pou` | ✅ | Creates a Program / FunctionBlock / Function under `parentPath` (typically `Application`). Saves automatically. | 1.54 s (measured) | 23.9 s (measured) |
| `set_pou_code` | ✅ | Replaces the declaration and/or implementation textual block of an existing POU/Method/Property. Saves. (Bench harness fails on multi-line code; tool itself works fine through MCP — see "What's NOT exercised" below.) | 0.5–2 s (used heavily this session) | 8–14 s |
| `create_property` | ✅ | Creates a Property on a parent POU (FB or Program), with auto-generated Get/Set methods | 0.5–1.5 s | 8–14 s |
| `create_method` | ✅ | Creates a Method on a parent FB | 0.5–1.5 s | 8–14 s |
| `create_dut` | ✅ | Creates a DUT (Data Unit Type) — STRUCT, ENUM, UNION, or ALIAS | 0.5–1.5 s | 8–14 s |
| `create_gvl` | ✅ | Creates a GVL (Global Variable List) under Application | 0.5–1.5 s | 8–14 s |
| `create_folder` | ✅ (fixed [`c87f3a9`](https://github.com/phobicdotno/Codesys-MCP/commit/c87f3a9), runtime-verified) | Creates a virtual folder under the named parent (typically `Application`). Tries `parent.create_folder(name)` then walks `parent.get_children()` to detect side-effect-only success (the API returns void). Falls back through `project.create_folder(name, SV_POU_GUID)` and `create_object(typeUuid)` for older SPs. | 1–3 s (typical) | 8–14 s (typical) |
| `delete_object` | ✅ | Calls `obj.remove()` on the object resolved via `find_object_by_path_robust`. Saves after. | 1.54 s (measured) | 27.4 s (measured) |
| `rename_object` | ✅ | Sets `obj.set_name()`. Saves. | 0.5–1.5 s | 8–14 s |

### Compile + introspection (5)

| Tool | Status | What it does | Persistent | Headless |
|---|---|---|---|---|
| `compile_project` | ✅ (fixed [`2607063`](https://github.com/phobicdotno/Codesys-MCP/commit/2607063)) | Calls `app.build()` and emits compile messages as JSON between markers. JSON `long` coercion fixed via `_coerce_int` / `_coerce_str` helpers + defensive `default=str` fallback. | 5–30 s (project size dependent) | 15–45 s |
| `get_compile_messages` | ✅ (fixed [`2607063`](https://github.com/phobicdotno/Codesys-MCP/commit/2607063)) | Reads compiler messages from the last build, emits as JSON. Same fix applied symmetrically. | 0.5–2 s | 8–14 s |
| `get_all_pou_code` | ✅ | Walks the project tree and emits every POU/DUT/GVL with declaration + implementation as a JSON blob. Heavy: 50–200 KB on a real project (172 KB / 4,386 lines on mariner40206). | 1.61 s (measured, MCPTest2) | 23.4 s (measured) |
| `list_project_libraries` | ✅ | Walks every `ScriptLibManObjectContainer` (project + per-Application) and emits library refs + project metadata + device firmware. **Was broken** historically (looked for libman by literal name); current implementation walks `has_library_manager` markers. | 1.56 s (measured) | 23.3 s (measured) |
| `mirror_export` | ✅ | Walks the tree and writes one `.st` file per code-bearing object into `<projectDir>/mcp-mirror/`. 50+ files for a real project. | 1.55 s (measured) | 23.7 s (measured) |

### Online / runtime (8)

These all require a running PLC and a configured device gateway. Persistent timing here is **gateway-bound**, not CODESYS-bound — it's network roundtrips, not script overhead.

**v5 sweep verified end-to-end against local CODESYS Control Win V3** (PLATEA hostname, gateway port 11740) on 2026-04-26. All 8 tools called in sequence against MCPTest2 v1.3.4.0. **7/8 PASS, 1 broken-by-design (root-caused + fixed in this sweep, see notes).** Use **persistent mode** for any device-tool chain — headless spawns a fresh CODESYS process per call which kills the login state established by `connect_to_device`. Auto-login was added to all four scripts that previously relied on persisted login (start_stop_application, read_variable, write_variable, read_running_version_online) so they now also work end-to-end in headless. See "Headless mode + device tools" deep-dive below.

| Tool | Status | What it does | Persistent (with PLC) | Headless |
|---|---|---|---|---|
| `connect_to_device` | ✅ verified end-to-end (v5 sweep, fixed [`2607063`](https://github.com/phobicdotno/Codesys-MCP/commit/2607063)) | Logs into the active application via `online_app.login(...)`. Probes 4 enum source locations (`script_engine.LoginMode`, `script_engine.OnlineChangeOption`, `online_app.LoginMode`, `online_app.OnlineChangeOption`) plus 3-arg call shape variant. | 1–5 s | runs but login state lost on next call (use auto-login helper) |
| `disconnect_from_device` | ✅ verified end-to-end (v5: `Logged In: True` → `False` confirmed) | `online_app.logout()` | 200–500 ms | n/a (no persistent online context) |
| `get_application_state` | ✅ verified end-to-end (v5: returns `run`/`stop` correctly) | Reads `online_app.application_state` and `is_logged_in`. | 100–300 ms (when online); 100 ms when offline | 8–14 s (returns `none, Logged In: False` if not connected) |
| `read_variable` | ✅ verified end-to-end (v5: `PLC_PRG.watchdog1 = BYTE#225` live, ticking) | `online_app.read_value('var.path')` over the gateway. **CONSTANT VAR_GLOBAL scalars are inlined at compile time and absent from the online symbol table -- expect 'Invalid expression'.** | 100–500 ms per call | now auto-logs-in (v5 fix) |
| `write_variable` | ✅ verified end-to-end (v5: wrote 200 → read 204 4s later, 1 Hz tick proves write took) | `set_prepared_value` + `write_prepared_values` (SP21+ path), falls back to `write_value` / `set_value` / `write` / `set` for older SPs | 100–500 ms | now auto-logs-in (v5 fix) |
| `download_to_device` | ✅ verified end-to-end (v5: pushed v1.3.4.0 to PLATEA) | Pushes the new boot application after a code change. Heavy. Has its own login probe (independent from auto-login helper). | 5–60 s (project size dependent) | runs end-to-end |
| `start_stop_application` | ✅ verified end-to-end (v5: stop → `stop` state, start → `run` state) | `online_app.start()` / `.stop()` | 200–500 ms | now auto-logs-in (v5 fix) |
| `read_running_version_online` | ✅ verified end-to-end (v5: returns `1.4.1.0` for MCPTest2 v1.4.1.0); ⚠ requires IEC code reference -- see notes | Reads `_MCP_PROJECT_VERSION.sVersion` from the running PLC. **CODESYS strips unreferenced GVLs from the online symbol table at compile time -- adding `CONSTANT` makes it strictly worse (CONSTANT scalars are inlined and never reach the symbol DB at all), but even plain VAR_GLOBAL is dropped if no IEC code references the variable.** Fixed CONSTANT in v5 (dropped from `VERSION_GVL_DECLARATION_TEMPLATE` in `bump_project_version.py`); existing projects auto-migrate on next bump. **Caveat:** for `read_running_version_online` to actually return a value, *some IEC code must read `_MCP_PROJECT_VERSION.sVersion`*. Recommended one-time setup: add a string variable to PLC_PRG and assign `sVersionTag := _MCP_PROJECT_VERSION.sVersion;` once at the top of the implementation. The bump tool does NOT auto-inject this (it would be too invasive on user code). The script's "Invalid expression" error message points users at this requirement. | 100–500 ms | now auto-logs-in (v5 fix) |

#### Headless mode + device tools (v5 deep-dive)

In **persistent** mode the MCP keeps one CODESYS process alive; `connect_to_device`'s login state survives across calls. In **headless** mode each MCP call spawns a fresh `CODESYS.exe --noUI` process — login state from the prior call is gone before the next call starts. Pre-v5, only `connect_to_device` and `download_to_device` did their own `online_app.login(...)`; the other four (`start_stop_application`, `read_variable`, `write_variable`, `read_running_version_online`) silently failed in headless with `Application not logged in.` (start/stop) or `Invalid expression` (read/write).

**v5 fix:** `ensure_logged_in(online_app, login_wait_seconds=30)` was added to `ensure_online_connection.py` next to the existing `ensure_online_connection`. The four affected scripts now call it immediately after creating the online app. The helper short-circuits via `online_app.is_logged_in` so persistent mode is a no-op (no extra login roundtrip), then runs the same enum-probe + call-shape probe + STABLE_STATES settle-wait pattern that `connect_to_device` and `download_to_device` already use. Net effect: every online tool now works end-to-end in BOTH modes.

### Git wrappers (6)

These don't talk to CODESYS at all — they `execSync` `git` from the project's parent directory. Mode is irrelevant.

| Tool | Status | What it does | Either mode |
|---|---|---|---|
| `git_init` | ✅ | `git init` + sets `safe.directory` | < 200 ms |
| `git_status` | ✅ | `git status --porcelain` | < 100 ms |
| `git_commit` | ✅ | Stages controlled paths + `git commit -m` | 100–500 ms |
| `git_remote_add` | ✅ | `git remote add origin <url>` | < 200 ms |
| `git_branch_set_upstream_to` | ✅ | `git branch --set-upstream-to=origin/<branch>` | < 200 ms |
| `git_push` | ✅ | `git push --follow-tags` | 1–10 s (network) |

### Library + version (4)

| Tool | Status | What it does | Persistent | Headless |
|---|---|---|---|---|
| `add_library` | ✅ | Adds a placeholder library reference to the application's libman | 0.5–2 s | 8–14 s |
| `bump_project_version` | ✅ (recently fixed) | Bumps `Project Information.Version` + maintains `_MCP_PROJECT_VERSION.sVersion` GVL. Now cross-checks pi vs GVL and takes max. | 1.54 s (measured) | 30.7–37.8 s (measured) |
| `release_project_version` | ✅ (recently fixed) | Full release pipeline: mirror + classify + bump + regen .md + git commit + tag + push. Now post-bump sanity-checks against latest tag. | 5–15 s (no push) / 8–25 s (with push) | 30–60 s (multiple CODESYS spawns add up) |
| `mirror_export` | ✅ | (already listed above) | | |

## Deep dive on the broken tools — all fixed in [`2607063`](https://github.com/phobicdotno/Codesys-MCP/commit/2607063)

### 1. `create_folder` — fixed in [`c87f3a9`](https://github.com/phobicdotno/Codesys-MCP/commit/c87f3a9) (4-iteration debug saga)

**Symptom:** `create_folder` was flagged as a fork bug for years and removed from the recommended workflow.

**Real root cause:** SP22's `create_folder` methods (both `ScriptObject.create_folder` and `ScriptProject.create_folder`) **return void** (Python None) — the folder is created via side effect, the return value carries no information. Earlier fork code treated None as "this strategy failed" and silently fell through every fallback.

**Iteration story** (each commit on the fork):

| Version | Commit | Approach | Result |
|---|---|---|---|
| v1 | [`2607063`](https://github.com/phobicdotno/Codesys-MCP/commit/2607063) | `parent.create_folder(name=FOLDER_NAME)` | FAIL — SP22 stub uses `foldername`, not `name`. Got `unexpected keyword argument 'name'`. |
| v2 | [`e07f281`](https://github.com/phobicdotno/Codesys-MCP/commit/e07f281) | positional + `foldername=` fallback | FAIL — silent None return, fell through every strategy. |
| v3 | [`32e6120`](https://github.com/phobicdotno/Codesys-MCP/commit/32e6120) | added `primary_project.create_folder(name, SV_POU_GUID)` first; also dropped the ScriptManager template cache so hot-reload works | FAIL — same root cause as v2. |
| v4 | [`c87f3a9`](https://github.com/phobicdotno/Codesys-MCP/commit/c87f3a9) | walk `parent.get_children(False)` after each call to detect side-effect-only success | **PASS** — verified end-to-end on MCPTest2. |

**v4 verified:** ran `create_folder(folderName='Test_Bench_Folder', parentPath='PLCWinNT/Plc Logic/Application')` → folder appeared in IDE tree, `delete_object` removed it cleanly.

**Side benefit from v3:** dropped the ScriptManager in-memory template cache. The cost (~1 ms per call vs ~1.5 s of CODESYS execution time) is invisible; the win is that edits to `dist/scripts/` take effect without an MCP restart, which made iterating on v4 inside one debug session possible.

**Lesson for future fork work:** SP22's scripting API has a class of methods that mutate via side effect and return void. When porting fork scripts, **always verify by walking children** — never check the return value of `create_*`. Probably applies to `create_pou` / `create_dut` / `create_gvl` too; worth a separate audit pass.

### 2. `compile_project` and `get_compile_messages` — fixed (json `long` coercion)

**Symptom:** Both failed with a JSON serialization error.

**Root cause** (was in [`compile_project.py`](../src/scripts/compile_project.py) and [`get_compile_messages.py`](../src/scripts/get_compile_messages.py)):

CODESYS's compile-message objects expose `line_number` as a `System.Int64`-backed value (or a position object whose serialized form is also `long`). IronPython 2.7's `json.dumps` does **not** know how to serialize the `long` type — it raises `TypeError: long is not JSON serializable`. Some `source` paths come back as `System.Uri` which `json.dumps` also can't handle.

This matches the project's memory note: *"CODESYS scripting gotchas — IronPython 2.7 traps: ... json can't dump `long`"*.

**Fix landed:**

- Added `_coerce_int(v)` helper (returns native int or None on failure) for `line_number` / `position` fields.
- Added `_coerce_str(v)` helper (forces str() on CLR-typed fields) for `object_name` / `source`.
- Collapsed the three duplicated message-building blocks into a single `_build_message_entry(msg)` helper.
- Wrapped the final `json.dumps(messages)` in a try/except that catches `TypeError` and retries with `default=lambda o: str(o)` — so any future SP API that adds a new non-serializable type degrades gracefully (field becomes a string repr) instead of taking down the whole emit.

Same fix applied symmetrically in both files.

### 3. `connect_to_device` — fixed (LoginMode enum probe)

**Symptom:** "All login() call shapes failed" against SP22 PLCs.

**Root cause** (was in [`connect_to_device.py`](../src/scripts/connect_to_device.py)):

The script enumerated only `script_engine.OnlineChangeOption`. In SP21+ the login enum was rebadged to `script_engine.LoginMode` (with some members renamed/removed), and in some builds the enum is attached to the `online_app` object instead of the `script_engine` module. The candidate sweep would find no enum members and fall through to `login(False)` / `login(True)` / `login()` — all of which raise on SP22.

**Fix landed:**

- Probe **four** enum source locations: `script_engine.LoginMode`, `script_engine.OnlineChangeOption`, `online_app.LoginMode`, `online_app.OnlineChangeOption`.
- Extended the preferred-priority list to `('TryOnlineChange', 'OnlineChangeOnly', 'Try', 'OnlineChange', 'WithDownload', 'ForceDownload', 'Download', 'None_', 'None')`.
- Added a 3-arg call shape `login(mode, mode, False)` for SPs that take `(primary-mode, secondary-mode, force-download-bool)`.
- Logs each enum source's discovered members so a future SP rotation is visible in the debug output.

Without a connected PLC (the user's setup is dev-only at the moment) the fix is **not yet runtime-verified**, but the enum-probe expansion is logically equivalent to a successful surface scan that the prior version was missing entirely.

### 4. `open_project` cross-project switch — fixed (close-prior branch enabled)

**Symptom:** When switching from project A to project B in a persistent session, B sometimes failed to become primary or the IDE popped a "project is currently in use" modal that hung subsequent scripts. Workaround: `shutdown_codesys` + `launch_codesys` + `open_project`.

**Root cause** (was in [`ensure_project_open.py`](../src/scripts/ensure_project_open.py)):

The "close the old project before opening the new one" branch was **commented out** as a TODO since the initial fork. The script just called `script_engine.projects.open(target)` while the old project was still in memory. CODESYS sometimes accepted this (demoted the old project), sometimes locked the file, sometimes popped an "unsaved changes?" modal that froze the IDE thread.

**Fix landed:** uncommented + hardened. When a different project is primary, the script now:

1. Calls `primary_project.save()` (best-effort — if it raises, log and proceed; better to lose in-flight edits than to get stuck in a half-switched state).
2. Calls `primary_project.close()`.
3. Pumps the CODESYS event loop for 500 ms via `script_engine.system.delay(500)` so the close transition completes before the open call lands.
4. Falls through to the existing `script_engine.projects.open(target, ...)` path.

**Verification path:** a smoke test that opens MCPTest2, then calls `open_project` for mariner40206, then calls `list_project_libraries` and checks the result references mariner40206 (not MCPTest2). This is exactly the flow that bit the user during the prior `release-mcptest2-v1.2.1.0` session.

### 5. `list_project_libraries` — historically broken, now ✅ working

The current script ([`list_project_libraries.py`](../src/scripts/list_project_libraries.py)) walks `has_library_manager` markers correctly. The earlier broken version searched for libmans by literal name; that's been replaced. The project memory note flagging this should be marked **resolved** in a future memory update.

## Bench results

Run the harness manually:

```bash
cd C:/Users/karstein.kvistad/Codesys-MCP
node tests/bench.mjs --modes headless,persistent --iterations 2
```

Output goes to `tests/bench-results.json` and a markdown summary is printed to stdout. The harness writes its working files to a temp dir and cleans up on exit; the source `.project` is never mutated.

The latest run (captured in [`bench-results.json`](bench-results.json)) is summarized in the headline table at the top of this document. Persistent mode is **15–24× faster** than headless on every tool that drives a CODESYS roundtrip; for the `git_*` and `get_codesys_status` tools mode is irrelevant.

## What's NOT exercised

- The benchmark does not run the (now-fixed) `compile_project` / `get_compile_messages` / `connect_to_device` / `create_folder` yet — the bench corpus should be expanded in a follow-up to cover them now that the fixes have landed.
- Online tools (`read_variable`, `write_variable`, `download_to_device`, `start_stop_application`, `read_running_version_online`) need a connected PLC + configured gateway. The bench is single-machine PLCWinNT-only.
- `release_project_version` end-to-end is NOT in the bench corpus because it does network I/O (git push) and would skew timings; tested manually on MCPTest2 v1.3.0.0.
- `set_pou_code` failed in both modes during the bench (harness-side bug: multi-line code passed verbatim into a triple-quoted-string interpolation). The tool itself works fine through normal MCP calls — fix is to escape newlines in the bench harness or call `prepareScriptWithHelpers` with the same shape `server.ts` uses.
