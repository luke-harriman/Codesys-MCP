> ## About this fork
>
> **Codesys-MCP-SP22+** -- a fork of [luke-harriman/Codesys-MCP](https://github.com/luke-harriman/Codesys-MCP) maintained at [phobicdotno/Codesys-MCP-SP22-plus](https://github.com/phobicdotno/Codesys-MCP-SP22-plus) on branch `sp21-plus-migration-notes`.
>
> **Why fork.** Upstream's watcher relies on `system.execute_on_primary_thread()` to marshal work from a background thread back to the CODESYS UI thread. That API was **removed in CODESYS V3.5 SP21+**, so on SP21 / SP22 every tool call returned the same `Marshal error: The functionality 'system.execute_on_primary_thread(...)' is no longer supported` and the server was effectively unusable on current CODESYS releases.
>
> **What's fixed in this fork:**
>
> - **SP21+/SP22 compatibility** — the watcher was rewritten as single-threaded on the primary thread, yielding to the IDE via `system.delay()`. No background thread, no marshaling. Works on SP19, SP21, and SP22+. Full rationale in [`docs/MIGRATION-SP21-PLUS.md`](docs/MIGRATION-SP21-PLUS.md).
> - **Cancel-link hardening** — the watcher now catches `KeyboardInterrupt` (which is not a subclass of `Exception` in Python) at three layers, so clicking *"Click here to CANCEL this operation"* in CODESYS no longer pops the modal traceback dialog or kills the watcher. Bumped to `WATCHER_VERSION 0.4.2`.
>
> **Verified state of every tool** is recorded in [`docs/SMOKE-TEST-2026-04-25.md`](docs/SMOKE-TEST-2026-04-25.md): 17 of 28 invocations pass, 8 fail, 3 are partial. The failures are *upstream* bugs unrelated to the SP21+ fix (e.g. `create_folder` keyword mismatch, JSON `long` serialization in `compile_project`, online-API drift in `connect_to_device` / `write_variable`) and are tracked there for follow-up PRs.

# Codesys-MCP-SP22+

MCP server for CODESYS with a persistent UI instance and file-based IPC. npm package: `codesys-mcp-sp22-plus`.

Unlike headless-only approaches that spawn a new CODESYS process per command, this server launches CODESYS **with its UI visible** and keeps it running. MCP tool calls are sent to the same instance via a file-based IPC watcher, so changes appear in real-time and the user can interact with the IDE alongside AI-driven automation.

## Features

- **Persistent mode** — CODESYS UI stays open; commands execute in the running instance
- **Headless fallback** — automatic fallback to `--noUI` spawn-per-command if persistent mode fails
- **File-based IPC** — proven approach using atomic file writes and a Python watcher script
- **Command serialization** — async mutex ensures one command at a time
- **Health monitoring** — detects CODESYS crashes and reports state
- **28 MCP tools** — project management, POU authoring, structured compiler diagnostics, runtime monitoring, library management
- **Drop-in replacement** — same MCP tool names and parameters as `@codesys/mcp-toolkit`

## Installation

```bash
npm install -g codesys-mcp-sp22-plus
```

Or install from the repository:

```bash
git clone https://github.com/phobicdotno/Codesys-MCP-SP22-plus.git
cd Codesys-MCP-SP22-plus
npm install
npm run build
npm link
```

**Requirements:** Node.js 18+, Windows, CODESYS 3.5 SP19 or SP21 installed.

## Quick Start

Add to your `.mcp.json` (Claude Code configuration):

```json
{
  "mcpServers": {
    "codesys": {
      "command": "codesys-mcp-sp22-plus",
      "args": [
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP21 Patch 3",
        "--mode", "persistent"
      ]
    }
  }
}
```

Or run directly:

```bash
codesys-mcp-sp22-plus \
  --codesys-path "C:\Program Files\CODESYS 3.5.21.0\CODESYS\Common\CODESYS.exe" \
  --codesys-profile "CODESYS V3.5 SP21 Patch 3"
```

## CLI Reference

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --codesys-path <path>` | Path to CODESYS executable | `$CODESYS_PATH` or auto-detected |
| `-f, --codesys-profile <name>` | CODESYS profile name | `$CODESYS_PROFILE` or `CODESYS V3.5 SP21` |
| `-w, --workspace <dir>` | Workspace directory for relative paths | Current directory |
| `-m, --mode <mode>` | `persistent` (UI) or `headless` (--noUI) | `persistent` |
| `--no-auto-launch` | Don't launch CODESYS on startup | Auto-launch enabled |
| `--fallback-headless` | Fall back to headless if persistent fails | `true` |
| `--keep-alive` | Keep CODESYS running after server stops | `false` |
| `--timeout <ms>` | Default command timeout | `60000` |
| `--detect` | List installed CODESYS versions and exit | — |
| `--verbose` | Enable verbose logging | — |
| `--debug` | Enable debug logging | — |
| `-V, --version` | Show version number | — |
| `-h, --help` | Show help | — |

Environment variables `CODESYS_PATH` and `CODESYS_PROFILE` are used as defaults when the corresponding flags are not provided.

## MCP Tools

### Management Tools

| Tool | Description |
|------|-------------|
| `launch_codesys` | Manually launch CODESYS (use with `--no-auto-launch`) |
| `shutdown_codesys` | Shut down the persistent CODESYS instance |
| `get_codesys_status` | Get current state, PID, execution mode |

### Project Tools

| Tool | Description |
|------|-------------|
| `open_project` | Open an existing CODESYS project file |
| `create_project` | Create a new project from the standard template |
| `save_project` | Save the currently open project |
| `compile_project` | Build the primary application with structured error output (120s timeout) |
| `get_compile_messages` | Retrieve last compiler messages without triggering a new build |

### POU / Code Authoring Tools

| Tool | Description |
|------|-------------|
| `create_pou` | Create a Program, Function Block, or Function |
| `set_pou_code` | Set declaration and/or implementation code |
| `create_property` | Create a property within a Function Block |
| `create_method` | Create a method within a Function Block |
| `create_dut` | Create a Data Unit Type (Structure, Enumeration, Union, Alias) |
| `create_gvl` | Create a Global Variable List with optional initial declaration |
| `create_folder` | Create an organizational folder in the project tree |
| `delete_object` | Delete any project object (POU, DUT, GVL, folder, etc.) |
| `rename_object` | Rename any project object |
| `get_all_pou_code` | Bulk read all declaration and implementation code in the project (120s timeout) |

### Online / Runtime Tools

| Tool | Description |
|------|-------------|
| `connect_to_device` | Login to the PLC runtime (requires configured device/gateway) |
| `disconnect_from_device` | Logout from the PLC runtime |
| `get_application_state` | Check if the PLC application is running, stopped, or in exception |
| `read_variable` | Read a live variable value from the running PLC (e.g., `PLC_PRG.bMotorRunning`) |
| `write_variable` | Write/force a variable value on the running PLC |
| `download_to_device` | Download compiled application to PLC (attempts online change first, 120s timeout) |
| `start_stop_application` | Start or stop the PLC application |

### Library Management Tools

| Tool | Description |
|------|-------------|
| `list_project_libraries` | List all libraries referenced in the project with version info |
| `add_library` | Add a library reference to the project |

## MCP Resources

| Resource URI | Description |
|--------------|-------------|
| `codesys://project/status` | CODESYS scripting status and open project info |
| `codesys://project/{path}/structure` | Project tree structure |
| `codesys://project/{path}/pou/{pou}/code` | POU declaration and implementation code |

## Execution Modes

### Persistent Mode (default)

1. Server launches `CODESYS.exe` with `--runscript=watcher.py` (no `--noUI`)
2. CODESYS UI opens — user can see and interact with the IDE
3. The watcher script starts a .NET background thread that polls a `commands/` directory, then **returns control to CODESYS** so the UI stays fully responsive
4. When a tool is called, the server writes a `.py` script + `.command.json` to `commands/`
5. The background thread detects the command and marshals execution onto the CODESYS UI thread via `system.execute_on_primary_thread()`
6. Results are written atomically to `results/`
7. Changes made by tools appear in the CODESYS UI in real-time
8. The UI remains interactive between commands — only briefly paused during synchronous API calls (compile, open)

### Headless Mode

Falls back to the original approach: each tool call spawns a new CODESYS process with `--noUI`, runs the script, and exits. No UI is shown. Used when:

- `--mode headless` is specified
- Persistent mode fails to launch and `--fallback-headless` is enabled
- CODESYS is launched with `--no-auto-launch` and `launch_codesys` hasn't been called yet

## Detect Installed Versions

```bash
codesys-mcp-sp22-plus --detect
```

Scans `Program Files` and `Program Files (x86)` for CODESYS installations.

## Troubleshooting

**CODESYS not found**
Verify the path with `--detect`. The executable is typically at:
`C:\Program Files\CODESYS 3.5.XX.X\CODESYS\Common\CODESYS.exe`

**Project file locked**
Another CODESYS instance may have the project open. Close it first or use persistent mode so there's only one instance.

**Watcher timeout (persistent mode)**
If the watcher doesn't signal ready within 60 seconds, check:
- CODESYS path and profile are correct
- No modal dialogs are blocking CODESYS startup
- Try `--verbose` for detailed logging

**UI briefly pauses during commands (persistent mode)**
The watcher uses a background thread that marshals work onto the UI thread, so the UI stays responsive between commands. During synchronous CODESYS API calls (compile, project open), the UI may briefly pause — this is expected and normal. If a command hangs, check the CODESYS messages window for modal dialogs or errors.

**Command timeout**
Default is 60s (120s for compile and download). Increase with `--timeout <ms>`. Check CODESYS messages window for errors.

**Online/runtime tools fail**
The online tools (`connect_to_device`, `read_variable`, etc.) require:
- A device/gateway configured in the CODESYS project
- The project to be compiled successfully before connecting
- A reachable PLC or CODESYS SoftPLC runtime

## Development

```bash
# Install dependencies
npm install

# Build (compiles TypeScript + copies Python scripts)
npm run build

# Run all tests
npm test

# Type check only
npm run typecheck

# Run tests in watch mode
npm run test:watch
```

### Project Structure

```
src/
  bin.ts              CLI entry point
  server.ts           MCP tool/resource registration (28 tools, 3 resources)
  launcher.ts         CODESYS process management
  ipc.ts              File-based IPC transport
  headless.ts         Headless fallback executor
  script-manager.ts   Python template loading + interpolation
  types.ts            Shared TypeScript types
  logger.ts           Structured stderr logging
  scripts/            Python scripts (watcher + 2 helpers + 28 tool scripts)
tests/
  unit/               Unit tests (IPC, script manager, launcher)
  integration/        Integration tests (script pipeline, manual CODESYS tests)
  mock_watcher.py     Standalone watcher for testing without CODESYS
```

## License

MIT
