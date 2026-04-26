# Architecture

## Problem Statement

The original `@codesys/mcp-toolkit` spawns a new headless CODESYS process (`--noUI`) for every MCP tool call. This has two limitations:

1. **No UI visibility** — the user cannot see what the AI is doing to their project
2. **Project locking** — if the user opens CODESYS manually, the project file is locked and MCP tools fail

The desired workflow: a single CODESYS instance with its UI open, where MCP tool commands execute in the same process and changes appear in real-time.

## Architecture Overview

```
+-------------------------------------+
|      MCP Client (Claude Code)       |
+------------------+------------------+
                   | MCP Protocol (stdio)
+------------------v------------------+
|    Node.js MCP Server               |
|                                     |
|  bin.ts  -> CLI entry point         |
|  server.ts -> MCP tools/resources   |
|  launcher.ts -> Process management  |
|  ipc.ts -> File-based IPC           |
|  headless.ts -> Fallback mode       |
|  script-manager.ts -> Templates     |
+------------------+------------------+
                   | File-based IPC (persistent)
                   | OR spawn-per-command (headless)
+------------------v------------------+
|    CODESYS.exe                      |
|  watcher.py running inside via      |
|  --runscript (persistent mode)      |
+-------------------------------------+
```

## IPC Protocol

### Directory Layout

Each session creates a unique directory under `os.tmpdir()`:

```
%TEMP%/codesys-mcp-sp22-plus/<sessionId>/
  commands/           Node.js writes here
    <requestId>.py              Script to execute
    <requestId>.command.json    Command trigger file
  results/            Watcher writes here
    <requestId>.result.json     Execution result
  watcher.py          Interpolated watcher script
  ready.signal        Written by watcher on startup
  terminate.signal    Written by Node.js for shutdown
```

### Command File Format

`<requestId>.command.json`:
```json
{
  "requestId": "uuid-v4",
  "scriptPath": "/path/to/commands/<requestId>.py",
  "timestamp": 1700000000000
}
```

### Result File Format

`<requestId>.result.json`:
```json
{
  "requestId": "uuid-v4",
  "success": true,
  "output": "captured stdout from script execution",
  "error": "",
  "timestamp": 1700000000.123
}
```

### Write Ordering (Atomicity)

All files use atomic writes: write to `.tmp`, `fsync`, then `rename`.

Command submission order:
1. Write `<requestId>.py` (script content) -> fsync -> rename
2. Write `<requestId>.command.json.tmp` -> fsync -> rename to `.command.json`

The watcher triggers on `.command.json` appearance. Since the `.py` file is written and renamed first, it is guaranteed to exist when the watcher reads the command.

### Progressive Polling

Node.js polls for result files with exponential backoff:
- Initial interval: 100ms
- Doubles each poll: 100, 200, 400, 800, 1000ms
- Capped at 1000ms
- Default timeout: 60s (120s for compile)

## Watcher Script

The watcher (`src/scripts/watcher.py`) runs inside CODESYS via `--runscript` and provides the bridge between Node.js IPC and the CODESYS scripting API.

### Polling Loop

```python
while True:
    if check_terminate():
        break
    command_files = scan_commands_dir()
    if command_files:
        process_command(command_files[0])  # one per iteration
    time.sleep(0.05)  # 50ms yield to UI thread
```

The 50ms sleep interval balances responsiveness (commands processed within ~50ms) against UI thread availability (CODESYS UI stays responsive).

### Script Execution via exec()

Each command script is executed with `exec(script_code, exec_globals)` where `exec_globals` is a fresh dictionary:

```python
exec_globals = {
    '__builtins__': __builtins__,
    'sys': sys,
    'os': os,
    'time': time,
    'traceback': traceback,
    'shutil': __import__('shutil'),
}
```

This provides:
- **Namespace isolation** — variables from script A are not visible to script B
- **CODESYS API access** — `scriptengine` is available via `import scriptengine` because the watcher runs within the CODESYS scripting context (it's already in `sys.modules`)
- **Standard library access** — common modules pre-loaded in globals

### SystemExit Handling

CODESYS scripts use `sys.exit(0)` for success and `sys.exit(1)` for failure. The watcher catches `SystemExit` to prevent CODESYS from closing:

| Exit code | Mapping |
|-----------|---------|
| `None` or `0` | Success |
| Non-zero int | Failure |
| String | Failure (string is the error message) |

Output markers (`SCRIPT_SUCCESS` / `SCRIPT_ERROR`) take priority over exit codes when both are present.

### Output Capture

The `OutputCapture` class redirects `sys.stdout` and `sys.stderr` during script execution:

```python
class OutputCapture:
    def __init__(self):
        self._buffer = []
    def write(self, s):
        self._buffer.append(str(s))
    def getvalue(self):
        return ''.join(self._buffer)
```

Original stdout/stderr are saved and restored in a `try/finally` block, guaranteeing restoration even on unexpected exceptions. This class works across CPython and IronPython (CODESYS uses IronPython).

## Script Template System

Python scripts are stored as templates in `src/scripts/` with `{PLACEHOLDER}` tokens. The `ScriptManager` handles:

1. **Loading** — reads `.py` files from disk with caching
2. **Interpolation** — replaces `{KEY}` with escaped values
3. **Escaping** — backslashes doubled for Python string embedding (`C:\Users` -> `C:\\Users`)
4. **Triple-quote escaping** — `"""` in values escaped to `\"\"\"` for Python triple-quoted strings
5. **Helper prepending** — shared functions (`ensure_project_open`, `find_object_by_path`) prepended before the main script

### Helper Scripts

Two helper scripts are prepended to most tool scripts:

- **`ensure_project_open.py`** — opens a project file if not already open, with retry logic (3 attempts, 2s delay)
- **`find_object_by_path.py`** — navigates the CODESYS project tree to find objects by path (e.g., `Application/MyPOU`)

## Lifecycle Management

### Launch Sequence

1. Validate CODESYS executable exists
2. Generate session UUID
3. Create IPC directory with `commands/` and `results/` subdirectories
4. Load `watcher.py` template, interpolate `{IPC_BASE_DIR}`
5. Write interpolated watcher to session directory
6. Spawn: `CODESYS.exe --profile="..." --runscript="watcher.py"` (detached, UI visible)
7. `process.unref()` so Node.js doesn't wait for CODESYS
8. Poll for `ready.signal` (max 60s, every 500ms)
9. Start health monitor (5s interval PID check)

### Shutdown Sequence

1. Write `terminate.signal`
2. Wait up to 5s for process exit (poll every 500ms)
3. If still alive: `SIGTERM`, wait 2s, then `SIGKILL`
4. Clean up IPC directory

### Health Monitoring

A `setInterval` runs every 5 seconds checking if the CODESYS process is still alive (`process.kill(pid, 0)`). On process death:
- State transitions to `error`
- `lastError` is set with a descriptive message
- Registered `onStateChange` callbacks are invoked
- Monitor stops itself

## Concurrency Model

### Async Mutex

The `IpcClient` uses an async mutex to serialize commands. Only one command can be in-flight at a time. This prevents:
- Race conditions in the CODESYS scripting API (not thread-safe)
- File system conflicts in the IPC directory
- Interleaved script output

When multiple tool calls arrive concurrently, they queue and execute sequentially.

### Watcher Single-Threaded Processing

The watcher processes one command per polling iteration. If multiple `.command.json` files exist, they're sorted alphabetically and processed in order.

## Headless Fallback

When persistent mode is unavailable, the `HeadlessExecutor` provides the same `ScriptExecutor` interface using spawn-per-command:

1. Write script to temp file
2. Spawn `CODESYS.exe --profile="..." --noUI --runscript="script.py"` with `windowsHide: true`
3. Capture stdout/stderr
4. Parse `SCRIPT_SUCCESS` / `SCRIPT_ERROR` markers
5. Return `IpcResult`

Fallback activates when:
- `--mode headless` is specified
- Persistent launch fails and `--fallback-headless` is enabled
- Server starts with `--no-auto-launch` before `launch_codesys` is called

## Differences from Original Toolkit

| Aspect | @codesys/mcp-toolkit | codesys-mcp-sp22-plus |
|--------|---------------------|----------------------|
| CODESYS UI | Hidden (`--noUI`) | Visible (persistent) or hidden (headless) |
| Process lifetime | New process per command | Single long-running process |
| IPC mechanism | Spawn + stdout | File-based polling |
| Project locking | Blocks if user opens CODESYS | Shares the same instance |
| Real-time feedback | None | Changes visible in UI |
| Startup overhead | ~10-30s per command | ~10-30s once, then <100ms per command |
| Management tools | None | `launch_codesys`, `shutdown_codesys`, `get_codesys_status` |

## Security Considerations

- **Temp directory** — IPC files are created in the user's temp directory with default permissions. No sensitive data (credentials, keys) is written to IPC files.
- **Script injection** — tool parameters are escaped for Python string embedding (backslashes doubled, triple quotes escaped). The `exec()` context has access to the full CODESYS scripting API, which is the intended design.
- **Localhost only** — IPC is file-based with no network exposure. The MCP server communicates via stdio only.
- **Process isolation** — CODESYS is spawned as a detached process. The Node.js server can crash and restart without affecting CODESYS (though a new session would be created).
