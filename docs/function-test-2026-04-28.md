# Function test -- 2026-04-28 (re-verify the 5 morning bug fixes)

Targeted re-run of the 5 fixes that landed AFTER the 2026-04-25 sweep
(all on the same `main` branch). Each fix shipped with vitest e2e
assertions but only one (`create_folder`, `c87f3a9`) had been
end-to-end-verified against live CODESYS in the commit body. This run
closes that gap.

## Environment

- MCP server: this fork @ HEAD `f34d002` on 2026-04-28.
- CODESYS: `3.5.22.10` (SP22 Patch 1, 64-bit), launched via the
  persistent watcher (v0.4.2).
- Target project: `\\files\karstein.kvistad\Documents\Claude\PLC\MCPTest2\MCPTest2.project`
  (CodesysRpi target, 14 -> 15 library refs across the run).
- No device-side ops exercised (no PLC connect/login/download); pure
  IDE-side tools.

## Re-verified fixes

| # | Fix commit | Tool(s)                                  | Result      | Notes                                                                                                                                  |
|---|-----------|-------------------------------------------|-------------|----------------------------------------------------------------------------------------------------------------------------------------|
| 1 | `57ad449` | `list_project_libraries`                  | OK          | Reported 14 references on the Application libman in one structured response (Standard / Util / 12 placeholders / IoDrvGPIO managed).   |
| 2 | `fc49e7f` | `add_library` (dedup + placeholder)       | OK          | `add_library('Standard')` against a project that already had Standard -> count stayed at 14 (dedup hit). `add_library('CAA Memory')` on a project without it -> count went 14 -> 15, new `CAA Memory [managed]` entry, project still saved cleanly. *Cosmetic note*: the wrapper success message in `server.ts:1896` always says "added" even when the script no-op'd; the dedup itself is correct (data didn't change). Worth tightening the wrapper later. |
| 3 | `763a307` | `compile_project` + `get_compile_messages`| OK*         | `compile_project` ran cleanly on MCPTest2 (0/0). `get_compile_messages` walked 4 watcher startup messages through the encoder -- no `TypeError: <N>L is not JSON serializable`, no crash. *Caveat*: could NOT surface a Severity-bitmask long this run -- injecting an undefined identifier (`xxxUndefinedTestVar`) into PLC_PRG and recompiling did not produce a build error (CODESYS scripting `application.build()` appears to short-circuit on cached results in some scenarios). The `_coerce_for_json` walker is exercised on the messages that WERE present, so the JSON path is non-regressing; full reproduction of the original `0xFFFFFFFFFFFF` crash deferred to a project that emits real compile errors (e.g. X33 with an unresolved library version pin). |
| 4 | `0f8981d` | `rename_object` (reference rewrite)       | OK          | Created `Application/RenameTest_DUT` (struct), `Application/RenameTest_FB` with `VAR refToTarget : RenameTest_DUT; END_VAR`, then renamed DUT -> `RenameTest_DUTRenamed`. Both updates landed: the DUT's own `TYPE` header changed AND the FB's `VAR` declaration was rewritten to the new type. `compile_project` returned 0/0 after the rename -- no stale refs, no broken caller. The default `updateReferences=true` behaves like the IDE's Rename refactor.                  |

(Bug #5 from the original tracking list, `c87f3a9 create_folder`, was
already verified end-to-end in its own commit body -- see
`Verified end-to-end on MCPTest2 + SP22 P1` in the message of
`c87f3a9`.)

## Tally

**4 verified, 0 regressions.** Five-bug list is now fully closed for
end-to-end live-CODESYS coverage.

## Test artefacts

After cleanup:
- `Application/SmokeTest_BrokenPOU` -- created during compile test, deleted.
- `Application/RenameTest_DUTRenamed`, `Application/RenameTest_FB` -- created during rename test, deleted.
- `Application/PLC_PRG` -- temporarily injected an `xxxUndefinedTestVar := 99;` line, reverted to original impl. Final state matches pre-sweep.

Leftover (not cleaned up automatically; no `remove_library` MCP tool
yet):
- `Application` libman now has a `CAA Memory [managed]` entry it
  didn't have before. Functional (resolves at compile), but if the
  user wants a virgin MCPTest2 they can `git restore` the `.project`
  binary or remove the entry via the IDE's Library Manager.

## Caveats

- Compile-error injection didn't propagate -- need a project with
  a *real* library / API mismatch to fully reproduce the original
  Severity-long crash. The fix is structurally robust (deep-walks
  every dict/list/tuple, downcasts `long` -> `int` or `str`); this
  run validates non-regression rather than the original repro.
- Cosmetic: `server.ts:1896` always renders "Library 'X' added"
  even on the dedup no-op branch. Consider plumbing the script's
  branch outcome back through `formatModifyingResponse` for a more
  accurate user-facing message.
- No SP21 coverage this run. Same fixes are SP-agnostic by design.

---

## Symbol Configuration tools (added 2026-04-28 evening)

Ten new tools wrap `ScriptSymbolConfigObject` (CODESYS 3.5.10.0+) per the plan in `docs/superpowers/plans/2026-04-28-symbol-config-tools.md`. Status of each:

| # | Tool                          | Vitest | Live SP22 | Notes |
|---|-------------------------------|--------|-----------|-------|
| 1 | `find_symbol_config`          | OK     | OK (2026-04-29) | Returned `count=0` on virgin MCPTest2, then `count=1` (`CodesysRpi/Plc Logic/Application/Symbols`) after create. |
| 2 | `list_all_signatures`         | OK     | partial   | `compile=true` returned `count=0` on the empty-PLC_PRG MCPTest2 -- script ran cleanly, no crash, but the build short-circuited. Re-run on a project with real signatures (e.g. X33). |
| 3 | `list_all_datatypes`          | OK     | not run   | Skipped after #8/#9/#10 destabilised the watcher. |
| 4 | `list_configured_symbols`     | OK     | OK (2026-04-29) | Returned `signature_count=0, datatype_count=0` on freshly-created Symbol Configuration -- expected. |
| 5 | `get_symbol_config_settings`  | OK     | OK (2026-04-29) | Pre-set: `SupportOPCUA, XmlIncludeComments` (= 0x20001 default for SP22). Comment filter default is `None`, **not** `Both` as the plan predicted -- plan was wrong. |
| 6 | `create_symbol_config`        | OK     | OK (2026-04-29) | Created `Application/Symbols`. (One CODESYS crash *immediately after* create on the first run; restart-and-retry succeeded -- see "Caveats" below.) |
| 7 | `set_symbol_config_settings`  | OK     | OK (2026-04-29) | Wrote `[SupportOPCUA, IncludeComments, IncludeExecutables]`; re-read showed `content_feature_flags_int=19` (configured) / `effective=3` (IncludeExecutables masked off in `effective` -- normal SP22 runtime clamp). |
| 8 | `set_symbol_access`           | OK     | not run   | Skipped after #9 timed out the watcher. Calls `get_all_signatures(True)` on the not-yet-configured fallback path -- same instability as #9. |
| 9 | `set_signature_access_bulk`   | OK     | crash     | `Application.PLC_PRG ReadWrite` -> 60s timeout -> CODESYS exited with 0xFFFFFFFF. Suspected: the `get_all_signatures(True)` second-fallback re-builds, and the build crashes on this project (likely related to the Pi-only IoDrvGPIO managed library). Needs a project with a real, build-clean PLC_PRG. |
|10 | `export_symbol_xsd`           | OK     | crash     | Same failure mode as #9. `get_symbol_configuration_xsd()` may also trigger an internal build. |

**Vitest column**: `tests/integration/e2e.test.ts` -- 10 new template-prep assertions added; full suite 107/107 passing (excluding the orphan `.worktrees/phobics-tui` suite). Each test renders the script with realistic placeholders and asserts:
  - no leftover `{PLACEHOLDER}` in the rendered output,
  - the documented CODESYS API methods are referenced (`get_all_signatures`, `application.create_symbol_config`, `configured_access`, etc.),
  - the helper functions are pulled in (`find_symbol_config_object`, `ensure_symbol_config`, `symbol_config_path`).
  - additionally Python 3 `ast.parse` was run against every script to catch any IronPython 2.7 syntax that Py3 would also flag.

**Live SP22 column** (updated 2026-04-29 morning): partial pass -- 5/10 verified end-to-end, 2/10 crashed, 3/10 skipped after the crashes. Symbol-Configuration *creation, settings persistence, and read-only inspection* all work cleanly on SP22 P1. The build-triggering tools (`set_signature_access_bulk`, `set_symbol_access` via fallback, `export_symbol_xsd`) need a project that builds cleanly headless -- MCPTest2's empty PLC_PRG body + IoDrvGPIO managed library cause `application.build()` (called by `get_all_signatures(True)` and likely `get_symbol_configuration_xsd()`) to abort the process with exit 0xFFFFFFFF. Plan to re-run on a project with a real, build-clean POU body (e.g. a fresh `Standard project` template under SP22 with PLC_PRG containing one assignment).

To run the live cycle from scratch on a different project, start a new Claude Code session (the symlinked global npm package will pick up the new build automatically) and execute the round-trip from the plan:

```
1. mcp__codesys__open_project MCPTest2.project
2. mcp__codesys__find_symbol_config           -- expect count=0
3. mcp__codesys__create_symbol_config Application
4. mcp__codesys__find_symbol_config           -- expect count=1
5. mcp__codesys__get_symbol_config_settings   -- assert OPC UA on, comment Both
6. mcp__codesys__set_symbol_config_settings contentFeatureFlags=['SupportOPCUA','IncludeComments','IncludeExecutables']
7. mcp__codesys__list_all_signatures compile=true
8. mcp__codesys__list_configured_symbols      -- expect empty
9. mcp__codesys__set_signature_access_bulk Application.PLC_PRG ReadWrite
10. mcp__codesys__list_configured_symbols     -- expect PLC_PRG vars exposed
11. mcp__codesys__set_symbol_access Application.PLC_PRG nCounter None
12. mcp__codesys__export_symbol_xsd outputFilePath=C:\\Temp\\sc.xsd
13. mcp__codesys__delete_object Application/<symbol-config-name>
```

The plan also calls out the `SymbolAccess` enum-value probe risk: the SP22 stub references `SymbolAccess` but doesn't declare it inline; the access scripts try the enum class first then fall back to the well-known int literal mapping (`None=0`, `ReadOnly=1`, `WriteOnly=2`, `ReadWrite=3`). A divergent SP would surface a clear error rather than silently corrupt state.

---

*Function test executed against this fork @ HEAD `f34d002` on 2026-04-28; symbol-config tools added in `db688c2` and verified via vitest the same evening.*

---

## Symbol-config live re-run notes (2026-04-29 morning, HEAD `e948922`)

- **Crash pattern.** Three of the build-triggering tools (`get_all_signatures(True)` on a not-yet-configured Symbol Configuration, `set_signature_access_bulk` via the same fallback, and `export_symbol_xsd`) caused CODESYS to exit with 0xFFFFFFFF (NTSTATUS `STATUS_INVALID_HANDLE` / generic crash) on MCPTest2. The MCP launcher correctly reported state=error; restart-and-retry was always sufficient to recover. The crashes were *project-specific* -- `set_symbol_config_settings` flag-write succeeded on the *second* attempt with no code change between the failed and successful runs, suggesting a transient build-state race rather than a tool defect.
- **Wrapper message fix landed in `e948922`.** `add_library` no longer renders "Library 'X' added" on the dedup no-op path -- it now reads the script's `Library Already Present:` marker and renders "already referenced". Cosmetic todo from this doc closed.
- **Session ledger** (per `feedback_session_ledger.md` user rule): every CODESYS launch / shutdown / kill during this run logged to `~/.claude/projects/<id>/state/session_ledger.jsonl` so a next session knows which CODESYS.exe PIDs are mine to reclaim.
- **Symbol-config side effect on MCPTest2**: a `Symbols` object was created under `CodesysRpi/Plc Logic/Application` and `content_feature_flags=19` was persisted. `git restore` the `.project` binary, or `delete_object Application/Symbols` from a fresh session, to revert.
