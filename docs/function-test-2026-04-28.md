# Smoke test -- 2026-04-28 (re-verify the 5 morning bug fixes)

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

*Smoke test executed against this fork @ HEAD `f34d002` on 2026-04-28.*
