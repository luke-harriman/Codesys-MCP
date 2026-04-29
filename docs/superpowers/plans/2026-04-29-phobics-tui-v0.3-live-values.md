# phobiCS-tui v0.3 — inline live values

Status: **scoped, ready to implement.** The original blocker (`connect_to_device` script bug) was fixed in the SP21+ fork; see `src/scripts/connect_to_device.py:30-93`.

## Goal

When the user is browsing a POU in `phobiCS-tui` and the runtime is online, overlay each declared variable's live value inline next to its declaration in the Viewer:

```
   3      counter  : INT := 0;     ◀ live: 47
   4      bRunning : BOOL;          ◀ live: TRUE
```

Updates every 500 ms while the runtime is online. Off when no runtime, no overlay.

## Architecture (one-way pump)

The TUI is the user-facing process; the MCP server is the agent-facing process. They already communicate one-way through `tui-state.json` (TUI writes, server reads via `get_user_selection`).

This adds the **other** direction:

- **Server** writes a `tui-live-values.json` snapshot next to `tui-state.json`.
- **TUI** Viewer reads it on a 500 ms timer and overlays values for the currently-displayed POU.

The server pump only runs when:
1. `--live-values` CLI flag is set on the server, AND
2. `tui-state.json` exists and is fresh (60 s window, same as `get_user_selection`), AND
3. The runtime for that POU's project is online.

## State-file shape

`tui-live-values.json` (atomic write, same `.tmp` + rename pattern as `tui-state.json`):

```json
{
  "version": 1,
  "updated_at": "2026-04-29T08:14:55.123Z",
  "project_dir": "/abs/project/dir",
  "device": "CodesysRpi",
  "pou_name": "PLC_PRG",
  "values": {
    "counter":  { "value": "47",   "type": "INT",  "ts": 1745916895100 },
    "bRunning": { "value": "TRUE", "type": "BOOL", "ts": 1745916895100 }
  }
}
```

`values` is keyed by the bare variable name (no `PLC_PRG.` prefix). The TUI matches by exact string against tokens emitted by the highlighter.

## Tasks

### Task 1: shared types + path helper

- Create `src/tui/shared/live-values.ts`: `LiveValuesPayload` interface.
- Add `liveValuesFilePath()` to `src/tui/shared/state-paths.ts` — same dir as `stateFilePath()`, filename `tui-live-values.json`.
- Tests: 4 cases mirroring the `state-paths` tests.

### Task 2: TUI atomic reader

- Create `src/tui/shared/live-values-read.ts`: `readLiveValues(filePath)` returns `{ status: 'ok' | 'missing' | 'stale' | 'invalid' }` with same `FRESHNESS_MS = 5_000` (tighter than the selection file — values stop being interesting fast).
- Tests: 4 cases (fresh / missing / stale / malformed).

### Task 3: Viewer overlay

- Add `liveValues?: Record<string, { value: string }>` prop to `<Viewer>`.
- Walk the highlighted token rows; if a row contains a `text` token whose trimmed text is a key in `liveValues`, append `  ◀ live: <value>` (in green) at end of row.
- Tests: 3 cases — no liveValues prop = no overlay; with prop = overlay appears for matching var; non-matching vars unchanged.

### Task 4: TUI live-values hook + Browser wiring

- `useLiveValues(filePath, pouName)` hook in `src/tui/browser/useLiveValues.ts`: polls every 500 ms, returns `Record<string, {value: string}> | null`. Returns `null` when payload is missing/stale or `pou_name` doesn't match the requested `pouName`.
- Browser passes `liveValues={...}` to `<Viewer>` when cursor is on a POU.
- Tests: 2 cases — match returns map; mismatch returns null.

### Task 5: server-side reader for live-values write

- Create `src/live-values-write.ts`: `writeLiveValues(filePath, payload)` mirrors `state-write.ts` (atomic `.tmp` + rename).
- Tests: 3 cases (envelope, parent dir auto-create, no .tmp residue).

### Task 6: server-side pump

- Create `src/live-values-pump.ts`:
  - `class LiveValuesPump` — owns a `setInterval` (default 500 ms).
  - On each tick: read `tui-state.json` via existing `readSelection`. If status != ok or selection is older than freshness, skip.
  - Read the POU's declaration from the mirror (already exposed via `mcp-mirror/<device>/.../<POU>.st`).
  - Parse the `VAR ... END_VAR` block to get var names. Use the existing parsing helpers if any; otherwise a minimal regex `\b([A-Za-z_]\w*)\s*:` is fine (skip lines starting with `(*` or `//`).
  - For each var, call into the existing `read_variable` script via `executor.executeScript()`. Collect `{ name -> value }`.
  - `writeLiveValues(...)` the payload.
  - Errors are silent (debug-log only) — pump must never crash.
- `start()` / `stop()` lifecycle.
- Tests: parse VAR block from canned input; pump tick writes file with correct structure (mock executor + fs).

### Task 7: server-side wiring

- `ServerConfig.liveValues?: boolean` in `src/types.ts`.
- `bin.ts`: `--live-values` flag, plumb into config, banner `Live values: ENABLED (poll 500ms)`.
- In `startMcpServer`: if `config.liveValues`, instantiate `LiveValuesPump` and `start()` it; `stop()` in shutdown handler.
- Tests: pump starts/stops in a unit test using a fake interval.

### Task 8: README + commit

- Document `--live-values` and the inline-value display in the `## phobiCS-tui` section.
- Commit + open PR.

## Out of scope for v0.3

- Sub-property values (`PLC_PRG.fbX.bSomething`) — only top-level vars on the displayed POU.
- Write-from-TUI (changing values from the keyboard). Stays in `write_variable` MCP tool.
- Custom poll interval CLI flag — fixed at 500 ms in v0.3.
- ARRAY / STRUCT pretty-printing — show whatever `read_variable` returns as a string.

## Risk / known unknowns

- `read_variable` per var is N round-trips per tick. 500 ms × 10 vars = 50 ms/var headroom. Existing `read_variable` script might be slow enough to make this infeasible for large POUs. If so: switch to a single-script-per-tick that reads N vars in one CODESYS call.
- The CODESYS UI may pop a credential dialog mid-pump. Pump must catch and back off (longer interval after first failure, e.g. 5 s).
- TUI 500 ms file poll on Windows may cause noticeable disk I/O. Mitigate: only poll while `pou_name` is set (i.e., user is on a POU row).
