# Migrating Codesys-MCP to CODESYS V3.5 SP21+ / SP22+

## TL;DR

`Codesys-MCP` no longer works on CODESYS V3.5 SP21 (verified Patch 5) or SP22 (verified Patch 1). The reason is a single removed API in CODESYS scripting:

> `Marshal error: The functionality 'system.execute_on_primary_thread(...)' is no longer supported.`

The fix is an architecture change in `src/scripts/watcher.py`: drop the .NET background-thread + marshalling design and run the polling loop on the CODESYS primary thread itself, yielding via `system.delay()`.

This document explains the failure, evidence, and the proposed migration.

---

## 1. Symptom

Running any tool that triggers scripting (e.g. `mcp__codesys__open_project`) returns:

```
Error: Marshal error: The functionality 'system.execute_on_primary_thread(...)' is no longer supported.
```

Reproducible against:

| CODESYS install                | Profile name                     | Result |
| ------------------------------ | -------------------------------- | ------ |
| `3.5.21.50` (SP21 Patch 5)     | `CODESYS V3.5 SP21 Patch 5`      | ❌     |
| `3.5.22.10` (SP22 Patch 1)     | `CODESYS V3.5 SP22 Patch 1`      | ❌     |

A single `open_project` call once succeeded on SP21 in our testing, but the error has been deterministic on every subsequent invocation across both clean restarts and fresh launches. Treat the one success as a fluke (likely a race during scripting initialisation), not as evidence the API is intermittently available.

## 2. Where it comes from in this codebase

Single call site in `src/scripts/watcher.py:195`:

```python
# Marshal execution to the primary thread
_log("Marshaling to primary thread...")
try:
    se.system.execute_on_primary_thread(execute_on_ui)
except Exception as marshal_err:
    _log("Marshal error: %s" % marshal_err)
```

The README architecture section documents the design (`README.md:148-155`):

> 3. The watcher script starts a .NET background thread that polls a `commands/` directory…
> 5. The background thread … marshals execution onto the CODESYS UI thread via `system.execute_on_primary_thread()`

So the dependency is structural — the entire IPC loop is built around marshalling from a background thread back to the UI thread.

## 3. Why CODESYS removed it

CODESYS python-script multithreading was **never officially supported** ("we do not officially or explicitly support threading, it is 'on your own risk'" — M. Schaber, CODESYS Forge). The `execute_on_primary_thread` method was added in V3.5 SP1 as an opt-in escape hatch for advanced users; CODESYS appears to have hardened that boundary in newer SP21 patches (and definitely by SP22) by removing it outright.

Evidence the API is gone (not just deprecated) on SP21 Patch 5:

```
$ grep -in "primary_thread\|execute" \
    "C:\Program Files\CODESYS 3.5.21.50\CODESYS\ScriptLib\Stubs\scriptengine\ScriptSystem.pyi"
459:        executed python code, and throws an KeyboardInterruptException if aborted.
```

Zero matches for `primary_thread`, `invoke`, `marshal`, `dispatch`, `defer`, or `async` in the official `ScriptSystem.pyi` stub for SP21 Patch 5. There is no drop-in successor; the closest concept is `system.delay(ms)`, whose docstring is the key:

> "Delays the script for the specified amount of milliseconds. **The message loop is served during the wait** to allow background tasks to be processed."

In other words: if the script *itself* runs on the primary thread, `system.delay()` is the sanctioned way to give the IDE message-pump time without yielding the script.

## 4. Proposed migration

Replace the background-thread design with a primary-thread polling loop.

### 4.1 Current architecture (watcher.py, simplified)

```
import scriptengine as se
import clr
from System.Threading import Thread, ThreadStart, ManualResetEvent

def watch_loop():
    while not _stop_event.WaitOne(POLL_INTERVAL):
        for cmd in os.listdir(COMMANDS_DIR):
            process_command(cmd)              # runs on bg thread
            # process_command internally does:
            #   se.system.execute_on_primary_thread(execute_on_ui)
            #   done_event.WaitOne(120000)

bg = Thread(ThreadStart(watch_loop))
bg.IsBackground = True
bg.Start()
# Script returns immediately — UI stays interactive,
# bg thread keeps marshalling work onto the primary thread.
```

### 4.2 Proposed architecture

```
import scriptengine as se

def main_loop():
    while not _stop_signal_present():
        for cmd in os.listdir(COMMANDS_DIR):
            execute_on_ui(cmd)               # already on primary thread
        se.system.delay(POLL_INTERVAL)       # serves message loop ⇒ UI stays live

main_loop()                                  # never returns
```

Key implications:

- **No `clr` / `System.Threading` imports required** — drop the entire .NET threading dependency. (`OutputCapture`, `atomic_write` etc. stay as-is.)
- **No `done_event` / `shared_result`** — there's only one thread, so the result of `execute_on_ui(cmd)` can be returned/written directly.
- **The script never returns** — that's a design change. Today, `--runscript` lets the script return early so the user keeps the IDE; under the new model, `system.delay()` serves the message loop **while the script is still running**, which produces the same UX (clickable IDE) but means the watcher process IS the script.
- **`--no-auto-launch` still applies** — the MCP server (`bin.js`) decides when to spawn CODESYS with the watcher script; that's unchanged. Only the script's internal architecture moves.

### 4.3 Stop signal

The current code uses `ManualResetEvent` (.NET) for stop. Replace with a file-based sentinel checked once per loop:

```
def _stop_signal_present():
    return os.path.exists(os.path.join(IPC_BASE_DIR, "stop.signal"))
```

The Node-side `bin.js` already controls process lifecycle (kills the CODESYS process on shutdown); this just gives a soft-stop path.

### 4.4 What about `print` from the loop?

The current code is careful about `print` because "print from bg thread crashes CODESYS" (file comment, watcher.py:73). On a single-threaded design that risk goes away; the existing file-based `_log` can stay anyway for consistency and for cases when CODESYS is in `--noUI` mode.

## 5. Risks / open questions

1. **Does `system.delay()` truly keep the IDE interactive?** Documented as "message loop is served"; needs empirical confirmation by running the migrated watcher and trying to click around in CODESYS.
2. **`--runscript` lifecycle** — in current CODESYS, does a long-running `--runscript` script behave differently from a script that returns? Need to verify the script process can stay resident indefinitely.
3. **CPU usage of polling** — 50 ms poll = 20 wakeups/sec. CODESYS's `system.delay()` should idle cheaply, but worth measuring; bump to 100–200 ms if needed.
4. **Headless mode (`--noUI`)** — message loop semantics differ when no UI is present. The single-thread loop should still work, but `system.delay()` behaviour in `--noUI` mode is worth checking.
5. **Single fluke success on SP21** — if `execute_on_primary_thread` is genuinely removed on SP21 Patch 5, why did one call succeed? Possible: API stub still throws but a side effect of the marshal attempt completed the work before the exception propagated. This is a curiosity, not a path to rely on.

## 6. Minimum-viable fix

Smallest patch to get the project working on SP21+:

1. Rewrite `src/scripts/watcher.py` to the single-threaded design above (no `clr`, no `Thread`, loop calls `execute_on_ui` directly, then `system.delay(POLL_INTERVAL)`).
2. Update `process_command` / `execute_on_ui` to merge into one synchronous function that returns the result dict.
3. Drop `done_event`, `shared_result[0]`, `_stop_event`.
4. Run vitest suite to make sure the Node-side TypeScript (which orchestrates IPC and isn't affected by the script rewrite) still passes.
5. Smoke-test with the `mcp__codesys__open_project` and `mcp__codesys__create_pou` tools against SP21 and SP22.

## 7. Out of scope

- Wider refactor (e.g. swapping IronPython for CPython subprocess, replacing file IPC with sockets) — only the threading model needs to change to fix the regression.
- Updating the README architecture section — should be done as part of the actual code change, not in this design doc.

## 8. Sources

- [CODESYS Forge — Python and threads](https://forum.codesys.com/viewtopic.php?f=18&t=4859) — origin of the "we do not officially or explicitly support threading" quote and the discussion of primary-thread message-pump semantics.
- [CODESYS Scripting Engine docs index](https://content.helpme-codesys.com/en/ScriptingEngine/index.html) — official scripting reference index (note: the public index does not document `execute_on_primary_thread`, which is consistent with the API being internal-only / removed).
- [Schneider Electric Machine Expert ScriptEngine — system module reference](https://product-help.schneider-electric.com/Machine%20Expert/V1.1/en/ScriptEngine/topics/system.htm) — third-party docs (Schneider's product is downstream of CODESYS) describing the historical `execute_on_primary_thread(async)` signature.
- [CODESYS V3.5 SP21 Patch 5 release notes (WAGO mirror)](https://downloadcenter.wago.com/api/uploads/Release_Notes_CODESYS_V3_5_SP_21_Patch_5_4af34c3ba6.pdf) — release notes; no scripting-related entries, so the API removal isn't called out in user-facing changelogs.
- Local `ScriptSystem.pyi` stub from the SP21 Patch 5 install: `C:\Program Files\CODESYS 3.5.21.50\CODESYS\ScriptLib\Stubs\scriptengine\ScriptSystem.pyi` — primary evidence the API is gone (zero matches for `primary_thread`, `invoke`, `marshal`, `dispatch`).

---

*Doc written 2026-04-25 against luke-harriman/Codesys-MCP @ commit `HEAD` of `main`, fork at https://github.com/phobicdotno/Codesys-MCP.*
