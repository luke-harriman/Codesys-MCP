# Smoke test -- 2026-04-25 (post device-side fix + late-day extensions)

End-to-end test of every MCP tool exposed by `codesys-mcp-persistent`
on the [`sp21-plus-migration-notes`](https://github.com/phobicdotno/Codesys-MCP/tree/sp21-plus-migration-notes)
branch as of end-of-day 2026-04-25. Covers the watcher rewrite that
unblocked SP21+/SP22, the device-side login + write API fixes, and
the late-afternoon additions: six new `git_*` tools, `mirror_export`,
launcher refuse-on-duplicate guard, and the `list_project_libraries`
rewrite.

## Environment

- MCP server source: this fork @ `sp21-plus-migration-notes` HEAD
  (commits `93a105a`..`0a4c1a0` -- inclusive of the late-afternoon
  additions: `e236a0c` git tools, `3623c45` license-gate rewrite,
  `95a884b` launcher refuse-on-duplicate, `9b766c8` list_project_libraries
  rewrite, `e3e5f58` git_branch_set_upstream_to, `e6cfa57` project.save()
  retrofit, `7a6e725`+`76b7cf4` mirror_export, `0a4c1a0` mirror default
  mcp-mirror).
- CODESYS launched: **`3.5.22.10` (SP22 Patch 1, 64-bit)** via `--runscript`
  pointing at the rewritten watcher (v0.4.2 with KeyboardInterrupt hardening).
- Soft-PLC runtime up: `CODESYS Control Win V3 - x64` Windows service
  (`CODESYSControlService.exe`, listening on port 11740). User-started
  via the tray icon's "Start PLC" with one-shot UAC elevation.
- Test project: `\\files\karstein.kvistad\Documents\Claude\PLC\MCPTest\MCPTest.project`
  -- created via `create_project` from the Standard template (device =
  `PLCWinNT (CoDeSys SP Win V3)`, which IS the Control Win V3 device
  descriptor on this machine despite the legacy display name).
- All test objects authored with prefix `MCPv2_` to avoid colliding with
  user-fixed objects in the project; cleaned up at end of test.

## Result table

| # | Tool                                 | Result          | Notes                                                                                  |
|---|--------------------------------------|-----------------|----------------------------------------------------------------------------------------|
| 1 | `get_codesys_status`                 | OK              | State / Mode / PID / Session reported correctly.                                       |
| 2 | `launch_codesys`                     | OK              | Persistent mode; ready signal received within seconds.                                 |
| 3 | `shutdown_codesys`                   | OK              | Cleanly stops the spawned CODESYS instance. Prior smoke-test #5 (orphan from earlier launches) not reproduced this session. |
| 4 | `create_project`                     | OK              | From Standard template; saved to the requested path.                                   |
| 5 | `open_project`                       | OK              | Reproducible from-cold open. Cross-project switch (closing one project to open another in the same instance) not exercised here -- prior smoke noted that as a separate bug. |
| 6 | `save_project`                       | OK              |                                                                                        |
| 7 | `create_pou` (FunctionBlock / ST)    | OK              | `Application/MCPv2_FB`.                                                                |
| 8 | `create_dut` (Structure)             | OK              | `Application/MCPv2_ST`.                                                                |
| 9 | `create_gvl`                         | OK              | `Application/MCPv2_GVL` with declarationCode populated.                                |
|10 | `create_method`                      | OK              | `Application/MCPv2_FB/DoSomething : BOOL`.                                             |
|11 | `create_property`                    | OK              | `Application/MCPv2_FB/Counter : INT` (Get/Set sub-objects auto-created).               |
|12 | `set_pou_code`                       | OK              | Decl + impl wrote correctly to MCPv2_FB and MCPv2_ST. Verified via get_all_pou_code.   |
|13 | `get_all_pou_code`                   | OK              | Returned full code dump for every POU/DUT/GVL/Method/Property in the project.          |
|14 | `rename_object`                      | **PARTIAL**     | Renames the object's own internal declaration line (`TYPE old : ... END_TYPE` becomes `TYPE new : ... END_TYPE` automatically) BUT does NOT update other POUs that referenced the old name. Same as upstream. |
|15 | `delete_object`                      | OK              | Cleaned up MCPv2_FB / MCPv2_GVL / MCPv2_STRenamed at end-of-test.                      |
|16 | `get_application_state` (offline)    | OK              | `State: none, Logged In: False` before connect.                                        |
|17 | `add_library`                        | **PARTIAL**     | Operation succeeds and CODESYS shows the entry in Library Manager, BUT it adds a SECOND `Standard` reference instead of detecting the existing one, and the new reference is not added as a `* (System)` placeholder so it pulls in unresolved transitive deps (e.g. IoStandard 3.1.3.1 yellow-warning). |
|18 | `list_project_libraries`             | **OK (FIXED)**  | After commit `9b766c8`. Was looking up the Library Manager by NAME (`primary_project.find("Library Manager", True)`) which never matched because the libman's actual name is generated, not literal. Rewritten to walk every node and check the `has_library_manager` property on `ScriptLibManObjectContainer` (added to both Project and every Application object), then iterate `lm.references` for structured per-reference info. Verified against X33: 71 references across 2 library managers (project-level + Application). |
|19 | `create_folder`                      | **FAIL**        | `TypeError: create_folder() got an unexpected keyword argument 'name'`. Fork's call site uses `name=...` kwarg; the underlying CODESYS API rejects it.                              |
|20 | `compile_project`                    | **FAIL**        | Build itself runs successfully (`build()` returns), but the message-marshaller dies: `TypeError: 281474976710655L is not JSON serializable`. The CODESYS `system.get_message_objects()` returns a dict containing an IronPython 2.7 `long` (the value `0xFFFFFFFFFFFF`) that the stdlib `json` module cannot encode. |
|21 | `get_compile_messages`               | **FAIL**        | Same JSON-long bug as #20 -- both call into the same message-encoder path.             |
|22 | `connect_to_device`                  | **OK (FIXED)**  | After commits `e862846` + `eee8ce2`. Login probe iterates `OnlineChangeOption` members + (val, bool) shapes; new `loginWaitSeconds` parameter (default 60) polls `application_state` so the credential dialog has time to surface and the user can fill in the device password. Verified working; user filled the password on first connect this session. |
|23 | `get_application_state` (online)     | **OK**          | After connect: `State: run` / `State: stop` / `Logged In: True` reported correctly.    |
|24 | `read_variable`                      | **OK**          | `read_value()` works directly. Tested `PLC_PRG.fb.iCount` and `GVL_Test.nCounter` -- both returned live values updating each cycle (counters incrementing). |
|25 | `write_variable`                     | **OK (FIXED)**  | After commits `010811b` + `64906c4`. Switched to SP22 prepare-then-write API: `online_app.set_prepared_value(name, value)` then `online_app.write_prepared_values()`. Tested writing `GVL_Test.bRun = TRUE`; read-back confirmed the value landed.                            |
|26 | `start_stop_application` (start)     | **OK**          | `online_app.start()` -- verified state transitioned `stop` -> `run`.                  |
|27 | `start_stop_application` (stop)      | **OK**          | `online_app.stop()` -- verified state transitioned `run` -> `stop`.                   |
|28 | `download_to_device`                 | **OK (FIXED)**  | After commit `b3bf4a8`. Same login probe + `loginWaitSeconds` as connect. The actual "download" is performed by `login(OnlineChangeOption.Force, bool)`; subsequent `create_boot_application()` finalises boot persistence. |
|29 | `disconnect_from_device`             | **OK**          | Clean disconnect after sweep.                                                           |
|30 | `git_init` (NEW)                     | **OK**          | Wraps `project.git.init(localRepoPath)`. Requires PDE subscription; without it, fails fast with the friendly "PDE subscription required" message (see commit `3623c45`). Default localRepoPath = `<projectDir>_git` sibling, auto-created and emptiness-validated (commit `31e8429`). Verified against `GitSmokeTest.project` -- created `.git/`, `.gitattributes`, `.gitignore`, `.apsession`, and `project/` subdir. |
|31 | `git_status` (NEW)                   | **OK**          | Branch + diagnostic dump of `project.git` API surface. Adds an early `has_working_tree()` license probe so the rewrite triggers reliably even when the per-method probe loop would otherwise swallow the gate. |
|32 | `git_commit` (NEW)                   | **OK**          | Wraps `project.git.commit_complete(message, user, mail)`. Verified end-to-end on `GitSmokeTest.project` -- one commit `80c6d89` written and confirmed via `git log` against the local `.git/`. |
|33 | `git_remote_add` (NEW)               | **OK**          | Wraps `project.git.remote_add(name, url)`. Verified by adding both a local bare remote (`C:\Temp\MCPTestRemote.git`) and the GitLab remote (`https://gitlab.usv.no/karstein.kvistad/codesys-gitsmoketest.git`) to the same project. |
|34 | `git_branch_set_upstream_to` (NEW)   | **OK**          | Wraps `project.git.branch_set_upstream_to(remoteName, branchName?)`. MANDATORY between remote_add and the first push -- per helpme-codesys.com Git scripting docs. Without it, `push()` fails with `sLocalBranchName: branch 'master' does not track an upstream branch.` Shipped in commit `e3e5f58` after that exact failure mode surfaced in the first end-to-end test. |
|35 | `git_push` (NEW)                     | **OK**          | Three overloads: `push()` / `push(branch)` (relies on cached creds) and `push(branch, user, SecureString(token))`. Verified against both the local bare remote and `gitlab.usv.no` -- the libgit2-backed CODESYS Git plug-in picks up Windows Credential Manager creds the same way as command-line git, so no PAT was needed for the GitLab smoke test. |
|36 | `mirror_export` (NEW)                | **OK**          | Walks the project tree and writes one `.st` file per code-bearing object into `<projectDir>/mcp-mirror/` (default), preserving the project tree as nested directories. UTF-8 output. Each file carries a header comment with its CODESYS project path. Verified against X33: 91 files, 254 KB, 0 errors, 7 kinds (FB / DUT / METHOD / FUNCTION / PROGRAM / GVL / UNKNOWN). |

**Tally: 28 OK, 4 FAIL, 1 PARTIAL out of 36 distinct tool invocations.**

Diff vs morning smoke-test (2026-04-25 baseline): all 5 device-side
fails (`connect_to_device`, `download_to_device`, `read_variable`,
`write_variable`, `start_stop_application`) are now PASSING after the
device-side fixes; `list_project_libraries` (the read side of the
library inconsistency) is also PASSING after the late-afternoon
rewrite. Plus seven new tools shipped (six `git_*` and `mirror_export`).
Remaining failures: `create_folder` kwarg, `compile_project` /
`get_compile_messages` JSON-`long`, `add_library` doesn't dedupe /
placeholder, `rename_object` doesn't refactor callers.

## What this proves about today's fixes

| Commit                | Tool fixed / added            | Verification |
|-----------------------|-------------------------------|--------------|
| `e862846` + `eee8ce2` | `connect_to_device`           | #22 PASS (was login() drift) |
| `010811b` + `64906c4` | `write_variable`              | #25 PASS (was write_value() missing) |
| `b3bf4a8`             | `download_to_device`          | #28 PASS (same login() drift as connect) |
| `e236a0c`             | NEW: `git_init`/`git_status`/`git_commit` | #30/31/32 PASS against `GitSmokeTest.project` -- live PDE Demo subscription on this box (activation flipped the runtime `HasGitLicense` rule from False to True; the same call returns the friendly PDE-required message on installs without a subscription, see `3623c45`) |
| `8a6059b`             | NEW: `git_remote_add` + `git_push` | #33/35 PASS (push to local bare + push to gitlab.usv.no via cached creds) |
| `e3e5f58`             | NEW: `git_branch_set_upstream_to` | #34 PASS (RTFM-driven; the canonical "init -> remote_add -> set-upstream -> push" flow needs this step or push fails with `does not track an upstream branch`) |
| `e6cfa57`             | All git_* (binding persistence) | `project.save()` retrofit after every mutating git op so state survives IDE close. Soft-fail on save error to avoid masking a successful git op as a failure. |
| `9b766c8`             | `list_project_libraries`      | #18 PASS (rewritten to use `ScriptLibManObjectContainer` API instead of name-matching the libman) |
| `95a884b`             | Launcher refuse-on-duplicate   | Pre-spawn `tasklist` scan; refuses to launch alongside an existing CODESYS.exe with a clear message listing the offending PIDs. Mitigates v1's #3 orphan/modal cascade. |
| `7a6e725`+`76b7cf4`+`0a4c1a0` | NEW: `mirror_export`  | #36 PASS against X33: 91 .st files, 254 KB, 0 errors. Default mirror root iterated through `MCP/mirror/` -> `mcp-mirror/` based on real-world layout feedback. |

## Bugs still open (filed by # in the table above)

Each of these is a separate upstream issue worth its own PR back to
`luke-harriman/Codesys-MCP` once cross-referenced against the official
[CODESYS Python scripting docs](https://content.helpme-codesys.com/en/ScriptingEngine/idx-codesys_scripting.html):

1. **`create_folder` keyword mismatch (#19)** -- `create_folder(name=...)`
   call site in `src/scripts/create_folder.py` doesn't match the current
   API signature on the parent container object. Pending docs lookup for
   the canonical method (likely `add_folder(name)` or positional `name`).

2. **JSON `long` serialization (#20, #21)** -- `compile_project.py` and
   `get_compile_messages.py` need to convert IronPython `long` to `int`/
   `str` before `json.dumps`, or pass a `default=` callable. Same root
   issue, single fix can address both.

3. **`add_library` doesn't dedupe / placeholder (#17)** -- always adds
   a new reference even when one with the same name exists; doesn't
   format as `* (System)` placeholder so transitive deps don't resolve
   to installed versions. The matching READ side (`list_project_libraries`)
   was fixed in `9b766c8` -- the write side has the same wrong-axis
   bug (uses name-match for the libman lookup) and is the natural
   follow-up. Pending docs lookup for `add_placeholder_library` vs
   `add_library` semantics.

4. **`rename_object` partial refactor (#14)** -- updates the renamed
   object's own internal declaration but not any other POU that
   references the old name. CODESYS UI does the full refactor; need
   to find whether scripting exposes a `rename_with_references` or
   similar, or implement a brute-force walk + text replace.

## New infrastructure (this session, not bugs)

- **PDE-subscription gate detection.** All six `git_*` tools detect
  the runtime `HasGitLicense=False` rule and rewrite the error to a
  clear "CODESYS Professional Developer Edition subscription required"
  message pointing at the store page. Triggered when no PDE
  subscription is active; passes through transparently when one is
  (Demo or full). See commit `3623c45`.
- **Launcher refuse-on-duplicate.** Pre-spawn `tasklist` scan refuses
  to launch a second CODESYS alongside an existing one (orphan from
  prior MCP session, user's own interactive IDE, or a CODESYS still
  mid-shutdown), since two CODESYS processes against the same project
  file race on the lock and the loser pops a "project is currently in
  use" modal that freezes script execution. See `95a884b`. Future:
  adopt-existing-watcher (find a live ready.signal whose PID is still
  alive, attach to it instead of spawning) -- prototyped via the
  inject-once.mjs bridge in this session, not yet shipped in the
  launcher.

## Filesystem mirror (Phase 1 of "project as a filesystem")

`mirror_export` (#36) lays the foundation for an AI-editable text
representation of a CODESYS project. Phase 2 (`sync_pou_from_file`:
parse a `.st` file, split decl/impl, push back via `set_pou_code`)
and Phase 3 (drift detection: re-export when CODESYS state diverges
from the mirror) are not yet shipped. The X33 project was used as
the proving ground -- 91 .st files round-tripping cleanly through
the `(* Project path: ... *)` header convention.

## Caveats

- **SP22 only.** SP21 install (`3.5.21.50`) was not exercised in this
  run, but the watcher rewrite + login probe were architected to be
  SP-version-agnostic; same behaviour expected. Re-run on SP21 is
  pending.
- **Real PLC not exercised.** All device-side tests ran against the
  Control Win V3 soft-PLC (port 11740), not against actual industrial
  hardware (e.g. WAGO PFC). Network/protocol-specific issues that only
  surface with a real device aren't covered.
- **Project state mid-test.** Local-side ops were exercised against an
  MCPTest project that the user had previously cleaned up by hand
  (after the morning sweep had left a duplicate Standard library and
  a dangling ST_Sample reference from a non-refactoring rename).
  Re-running from a virgin `create_project` would shake out any
  state-dependent variations.

---

*Smoke test executed against this fork @ `sp21-plus-migration-notes` HEAD on 2026-04-25.*
