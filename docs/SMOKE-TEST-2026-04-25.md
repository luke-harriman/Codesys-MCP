# Smoke test — 2026-04-25 (post SP21+/SP22 watcher fix)

End-to-end test of every MCP tool exposed by `codesys-mcp-persistent` after the watcher rewrite on the [`sp21-plus-migration-notes`](https://github.com/phobicdotno/Codesys-MCP/tree/sp21-plus-migration-notes) branch.

## Environment

- MCP server source: this fork @ `sp21-plus-migration-notes`, `dist/` rebuilt from the rewritten `src/scripts/watcher.py` (single-thread design, no `execute_on_primary_thread`).
- CODESYS actually launched: **`3.5.21.50` (SP21 Patch 5)** — even though the MCP server config was set for SP22. Cause: the Claude Code session held three concurrent MCP child processes (two SP22-bound, one SP21-bound) from earlier re-registration churn, and call routing landed on the SP21-bound child. Did not re-test on SP22 in-session because that requires a Claude Code restart.
- Why this is still a useful test: the API removed in CODESYS V3.5 SP21+ (`system.execute_on_primary_thread`) is the **same** removal that affects SP22. Watcher code that runs cleanly on SP21 will run cleanly on SP22.
- Sandbox project used for destructive ops: `C:\Users\karstein.kvistad\codesys-mcp-smoketest\Smoke_Test_001.project` (created from CODESYS Standard.project template).

## Result table

| # | Tool                                | Result                | Notes                                                                                                          |
| - | ----------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1 | `get_codesys_status`                | ✅ Pass                | Returned `State: ready, Mode: persistent, PID: …`.                                                             |
| 2 | `launch_codesys`                    | ✅ Pass                | "CODESYS launched successfully in persistent mode."                                                            |
| 3 | `shutdown_codesys`                  | ⚠️ Partial             | Kills the CODESYS process tracked by *this* MCP child only. Orphaned CODESYS processes from prior MCP children remain — needs upstream fix. |
| 4 | `open_project`                      | ✅ Pass                | Opened X33 (`MRCodesysX33_0021.project`) over UNC; opened Smoke_Test_001 over local path. Reproducible — no longer the marshal-error fluke. |
| 5 | `create_project`                    | ✅ Pass                | "Project created from template …". Template resolved from SP21 install path (note below).                       |
| 6 | `save_project`                      | ✅ Pass                | "Project saved …".                                                                                             |
| 7 | `create_folder`                     | ❌ Fail                | `TypeError: create_folder() got an unexpected keyword argument 'name'`. **Upstream bug**, unrelated to this fix — the underlying CODESYS API rejects the keyword the script uses. |
| 8 | `create_pou` (Program / ST)         | ✅ Pass                | Created `Application/PLC_PRG2`.                                                                                |
| 9 | `create_pou` (FunctionBlock / ST)   | ✅ Pass                | Created `Application/MyFB`.                                                                                    |
|10 | `create_dut` (Structure)            | ✅ Pass                | Created `Application/MyStruct`.                                                                                |
|11 | `create_gvl`                        | ✅ Pass                | Created `Application/MyGVL` with declarationCode populated.                                                    |
|12 | `create_method`                     | ✅ Pass                | Created `Application/MyFB/DoSomething : BOOL`.                                                                 |
|13 | `create_property`                   | ✅ Pass                | Created `Application/MyFB/IsActive : BOOL` (Get/Set sub-objects auto-created).                                 |
|14 | `set_pou_code`                      | ✅ Pass                | Wrote declaration + implementation to `Application/PLC_PRG2`; verified via `get_all_pou_code`.                  |
|15 | `get_all_pou_code`                  | ✅ Pass                | Returned full code dump for all 9 objects in the project.                                                      |
|16 | `rename_object`                     | ✅ Pass                | `Application/PLC_PRG2 → PLC_PRG2_Renamed`.                                                                      |
|17 | `delete_object`                     | ✅ Pass                | Deleted `Application/MyStruct`.                                                                                |
|18 | `list_project_libraries`            | ⚠️ Empty               | Returns "No libraries found in the project (or Library Manager not found)" both before and after `add_library` — **soft inconsistency** (see #19). |
|19 | `add_library`                       | ⚠️ Inconsistent        | Returns "Library 'Standard' added …" but `list_project_libraries` afterwards still shows nothing. Either the add silently no-ops, or the list query misses the just-added entry. |
|20 | `compile_project`                   | ❌ Fail                | Build itself runs ("Build command executed for application 'Application'") but the message-serialiser then dies: `TypeError: 281474976710655L is not JSON serializable` (an IronPython 2.7 `long` from the message Severity bitmask). **Upstream bug** in the compile_project script's JSON encoder. |
|21 | `get_compile_messages`              | ❌ Fail                | Same `long` JSON-serialization bug as #20.                                                                     |
|22 | `get_application_state`             | ✅ Pass                | Returned `Application: Application, State: none, Logged In: False` for both X33 and the sandbox.                |
|23 | `connect_to_device`                 | ❌ Fail                | Two layered failures — `OnlineChangeOption.TryOnlineChange` attribute is missing, and the fallback plain `login()` now requires 2 args. **Upstream API drift** — would block all device ops even with a real PLC. |
|24 | `download_to_device`                | ❌ Fail                | Same `login()` signature change as #23.                                                                         |
|25 | `start_stop_application` (start)    | ❌ Fail                | "Application not logged in." (downstream of the broken `connect_to_device`.)                                    |
|26 | `read_variable`                     | ❌ Fail                | "Application not found" — online-app object created, but `read_value` path can't resolve target.                |
|27 | `write_variable`                    | ❌ Fail                | "Online application does not support write_value() or write()." Method on the online-app object renamed/removed in newer CODESYS scripting. |
|28 | `disconnect_from_device`            | ✅ Pass                | "Disconnected from device …" — succeeds even when not currently connected.                                      |

**Tally: 17 ✅ pass, 8 ❌ fail, 3 ⚠️ partial / inconsistent (out of 28 tool invocations across 26 distinct tools).**

## What this proves about the watcher fix

Every passing entry above is direct proof the new watcher works on SP21+. Before the fix, all of these tools returned identical `Marshal error: The functionality 'system.execute_on_primary_thread(...) is no longer supported`. After the fix, the underlying CODESYS scripting work runs and the tool either succeeds or fails for **its own** (unrelated) reason. The threading regression is closed.

## Bugs found that are NOT this fix

These are pre-existing upstream issues exposed once scripting actually runs. Each is worth filing back to upstream as a separate issue / PR after this one merges:

1. **`create_folder` keyword mismatch** (#7) — `create_folder(name=…)` call site needs to match the current CODESYS API signature.
2. **JSON `long` serialization** (#20, #21) — `compile_project` and `get_compile_messages` need a JSON encoder that handles IronPython `long` (e.g. cast `Severity` bitmasks to `int` or `str` before `json.dumps`).
3. **Online API drift** (#23, #24, #27) — `OnlineChangeOption.TryOnlineChange` removed; `login()` now requires explicit args; `Online application` no longer exposes `write_value()/write()`. Fixing these is a wider re-survey of the CODESYS online scripting API.
4. **`shutdown_codesys` doesn't reach orphans** (#3) — when the MCP server child is respawned (e.g. on Claude Code MCP re-registration), CODESYS processes from prior child processes are no longer tracked and survive `shutdown_codesys`. Either the child should kill child-of-child on its own exit, or the launcher should scan for and adopt orphans.
5. **Library list / add inconsistency** (#18, #19) — needs a small repro to determine whether the issue is `add_library` (silent no-op) or `list_project_libraries` (missing the just-added entry).

## Caveats / things not directly verified

- **SP22 not directly tested** in this run because of the orphaned MCP child issue. A Claude Code restart with only the SP22-bound config would resolve this; the architecture of the fix is identical for SP21 and SP22, so SP22 is expected to behave the same.
- **No real PLC** was connected during the test, so the device/runtime tools (#23–28) were exercised only against a non-running soft PLC target. The errors captured are mostly *script-side* (API mismatches), not network/device errors.
- **Standard.project template** was resolved from `C:\Program Files\CODESYS 3.5.21.50\CODESYS\Templates\Standard.project` regardless of the MCP's `--codesys-path` arg. Worth verifying the template-resolution code uses the same install root as the launched CODESYS.

---

*Smoke test executed against this fork @ `sp21-plus-migration-notes` branch with the rewritten `src/scripts/watcher.py`, on 2026-04-25.*
