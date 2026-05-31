# codesys-mcp-persistent

MCP server that exposes the CODESYS V3.5 IDE scripting API as 41 tools and 3 resources, with the CODESYS UI kept open across calls via a file-based IPC watcher.

Unlike headless-only wrappers that spawn a new `--noUI` CODESYS process per command, this server launches CODESYS with its UI visible and routes every tool call through a watcher script running inside that same instance. Changes appear in the IDE in real time and the user can interact with CODESYS alongside AI-driven automation.

## Requirements

- Windows
- Node.js 18+
- CODESYS V3.5 **SP19 or SP20** for persistent mode. **SP21+ runs only in headless mode** — see [Known limitations](#known-limitations).

## Install

```bash
git clone <repository-url>
cd Codesys-MCP
npm install
npm run build
npm link
```

## Configure

`.mcp.json` (Claude Code):

```json
{
  "mcpServers": {
    "codesys": {
      "command": "codesys-mcp-persistent",
      "args": [
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.20.0\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP20",
        "--mode", "persistent"
      ]
    }
  }
}
```

For SP21+, set `--mode headless` (each tool call spawns a `--noUI` CODESYS process).

## CLI

| Flag | Description | Default |
|---|---|---|
| `-p, --codesys-path <path>` | Path to `CODESYS.exe` | `$CODESYS_PATH` or `C:\Program Files\CODESYS 3.5.21.0\CODESYS\Common\CODESYS.exe` |
| `-f, --codesys-profile <name>` | CODESYS profile name | `$CODESYS_PROFILE` or `CODESYS V3.5 SP21` |
| `-w, --workspace <dir>` | Workspace for relative paths | cwd |
| `-m, --mode <mode>` | `persistent` or `headless` | `persistent` |
| `--no-auto-launch` | Don't launch CODESYS on startup | auto-launch on |
| `--fallback-headless` | Fall back to headless if persistent launch fails | `true` |
| `--keep-alive` | Keep CODESYS running after server stops | `false` |
| `--kill-existing-codesys` | Kill any running `CODESYS.exe` before launching | `false` |
| `--timeout <ms>` | Default command timeout | `60000` |
| `--detect` | List installed CODESYS versions and exit | - |
| `--verbose` / `--debug` | Logging | - |

Environment variables:
- `CODESYS_PATH`, `CODESYS_PROFILE` — defaults for the corresponding flags
- `CODESYS_MCP_READY_TIMEOUT_MS` — watcher-ready deadline (default `180000`)

## Tools

### Management

| Tool | Description |
|---|---|
| `launch_codesys` | Manually launch CODESYS (use with `--no-auto-launch`). Adopts a live session if one exists |
| `shutdown_codesys` | Shut down the persistent CODESYS instance |
| `get_codesys_status` | Report state, PID, execution mode |
| `eval_python` | **[DEV]** Execute arbitrary IronPython 2.7 against the live `scriptengine`. Code must `print("SCRIPT_SUCCESS")` before exit |

### Project

| Tool | Description |
|---|---|
| `open_project` | Open an existing `.project` file |
| `create_project` | Create a new project. Defaults to copying CODESYS's installed `Standard.project`; pass `templatePath` to copy a specific `.project`, or `templateName` to instantiate a template registered with CODESYS's Template Manager |
| `list_project_templates` | Enumerate templates from CODESYS's Template Manager and `%ProgramData%/CODESYS` |
| `save_project` | Save the currently open project |
| `compile_project` | Build with structured error output (120s timeout) |
| `get_compile_messages` | Retrieve last compiler messages without rebuilding |

### POU / code authoring

| Tool | Description |
|---|---|
| `create_pou` | Create a Program, Function Block, or Function |
| `set_pou_code` | Set declaration and/or implementation. Accepts Method/Property paths (`Application/MyFB/Method1`). Auto-saves to disk |
| `create_property` / `create_method` | Add a Property / Method to a Function Block |
| `create_dut` | Create a Data Unit Type (Structure, Enumeration, Union, Alias) |
| `create_gvl` | Create a Global Variable List, optionally with initial declaration |
| `create_folder` | Create an organisational folder |
| `delete_object` | Delete a user-created object. Refuses system nodes (`Application`, `Device`, `Library Manager`, etc.) and top-level paths |
| `rename_object` | Rename any project object |
| `get_all_pou_code` | Bulk read every declaration + implementation in the project (120s timeout) |
| `search_code` | Regex or literal substring search across every textual POU/Method/Property/DUT/GVL body |
| `find_references` | Word-boundary search for a symbol; wraps `search_code` |
| `rename_symbol` | Textual rename across all POU bodies. Two-phase plan + apply; `dryRun=true` by default |

### Online / runtime

| Tool | Description |
|---|---|
| `connect_to_device` | Login to the PLC runtime. Optionally pass `ipAddress` (and `gatewayName`, default `Gateway-1`); the device address is set then re-resolved from IP form to the gateway-scan node form before login |
| `disconnect_from_device` | Logout. No-op if not connected |
| `set_credentials` | Set default username/password for subsequent logins. Username must be non-empty |
| `set_simulation_mode` | Toggle device-level simulation mode |
| `get_application_state` | Report run / stop / exception plus login status |
| `read_variable` | Read a live variable. Path: `GVL.var` / `PRG.var` / `GVL.s.aRoi[0].field` (no `Application.` prefix) |
| `write_variable` | Write via `set_prepared_value` + `force_prepared_values`. The variable is FORCED until unforced or runtime restart |
| `download_to_device` | Download compiled application. `mode`: `auto` (default), `online_change`, or `full`. Boot application created after login. 120s timeout |
| `start_stop_application` | Start or stop the PLC application |
| `monitor_variables` | Sample one or more variables at a fixed interval. Duration capped at 60s, `intervalMs` floor 10ms |

Online tools route every `scriptengine.online` call through an `ExecuteSource` frame via the `with_executor` helper in `ensure_online_connection.py`. Without it, `create_online_application` raises `InvalidOperationException: Stack empty` from IPC-driven scripts on real PLCs.

### Library management

| Tool | Description |
|---|---|
| `list_project_libraries` | List referenced libraries with version info |
| `add_library` | Add a library reference. Pass the fully-qualified placeholder string from the Library Manager UI (e.g. `Standard, * (System)`) — bare names like `Util` won't resolve |

### Device tree

| Tool | Description |
|---|---|
| `list_device_repository` | Enumerate device descriptors in the local CODESYS Device Repository. Optional `vendor`, `nameContains`, `maxResults` filters |
| `inspect_device_node` | Read-only introspection of a device node: descriptor metadata, parameters with values, child sub-devices |
| `add_device` | Wrap `parent.add_device(name, type, id, version)`. Pair with `list_device_repository` to source canonical ids |
| `set_device_parameter` | EXPERIMENTAL. Many fieldbus parameters are GUI-only and return a clear error |
| `map_io_channel` | Bind (or clear) a fieldbus I/O channel to a global variable. Channel resolved by name path (`Inputs/Byte 0/Bit 3`) or numeric indices (`0/3`) |

### Archiving

| Tool | Description |
|---|---|
| `create_project_archive` | Save the open project as a `.projectarchive`. Saves unsaved edits first |

## Resources

| URI | Description |
|---|---|
| `codesys://project/status` | Scripting status and open-project info |
| `codesys://project/{path}/structure` | Project tree |
| `codesys://project/{path}/pou/{pou}/code` | POU / Method / Property declaration + implementation |

`{path}` and `{pou}` use [RFC 6570 reserved expansion](https://datatracker.ietf.org/doc/html/rfc6570#section-3.2.3) — pass values with raw `:` and `/`, **not** percent-encoded. On Windows, use forward slashes:

```
codesys://project/C:/Users/me/Documents/MyPLC.project/structure
codesys://project/C:/Users/me/Documents/MyPLC.project/pou/Application/MyFB/Method1/code
```

> The two templated resources don't appear in `ListMcpResourcesTool` (only `project-status` is static).
>
> ⚠️ If the requested project path differs from the currently-open project, the resource handler refuses to switch — it raises rather than silently swapping context.

## Execution modes

**Persistent (default).** On launch, the server scans `%TEMP%/codesys-mcp-persistent/` for a live session left by a previous MCP server (matching profile, PID alive, `ready.signal` present) and adopts it. Otherwise it spawns `CODESYS.exe --runscript=watcher.py` (no `--noUI`). The watcher writes `ready.signal`, then runs a background thread that polls a `commands/` directory and marshals each script onto the CODESYS UI thread via `system.execute_on_primary_thread()`. Results land in `results/`; Node polls with exponential backoff (100ms → 1s). The UI stays interactive between commands and pauses briefly during synchronous API calls (compile, open).

**Headless.** Each tool call spawns a new `--noUI` CODESYS process, runs the script, and exits. No UI. Used when `--mode headless` is set, when `--no-auto-launch` is used and `launch_codesys` hasn't been called, or when persistent launch fails and `--fallback-headless` is on.

## Detect installations

```bash
codesys-mcp-persistent --detect
```

Scans `Program Files` and `Program Files (x86)` for CODESYS installations.

## Known limitations

- **Persistent mode is broken on CODESYS V3.5 SP21+.** CODESYS removed `se.system.execute_on_primary_thread()` from the scripting API somewhere in the SP21 line. Persistent launch completes (`ready.signal` fires) and then every tool call returns `Marshal error: The functionality 'system.execute_on_primary_thread(...)' is no longer supported`. `--fallback-headless` is launch-time only and does not catch this. Workarounds: (a) run with `--mode headless`; (b) use the forward-port at [phobicdotno/Codesys-MCP-SP21-plus](https://github.com/phobicdotno/Codesys-MCP-SP21-plus). SP19/SP20 are unaffected.
- **`set_pou_code` auto-saves to disk** every successful call. UI Ctrl+Z does NOT recover prior content.
- **`set_pou_code` empty string is a no-op.** Passing `declarationCode: ""` or `implementationCode: ""` leaves the section unchanged. To clear a section, pass a single-line placeholder (e.g. `// cleared`).
- **`delete_object` refuses system nodes and any top-level object** (no `/`). System-reserved exact paths: `Application`, `Device`, `Project Settings`, `Device/Plc Logic`, `Application/Library Manager`, `Application/Task Configuration`, `Application/Task Configuration/MainTask`, `Device/Communication`, `Device/Communication/Ethernet`, `Device/SoftMotion General Axis Pool` (and the `Device/Plc Logic/...` variants).
- **`set_credentials` rejects empty usernames.** For no-auth runtimes, do not call this tool at all.
- **`add_library` requires a fully-qualified placeholder** matching the Library Manager UI string (e.g. `Standard, * (System)`). Bare names fail with `placeholder library X could not be resolved`.
- **DUT names containing `.` are rejected by CODESYS** (`The name 'X.Y' is not valid for this object`).
- **Identifier length isn't enforced at create time.** CODESYS only complains at compile/save. Stick to ≤32-char IEC identifiers.
- **`find_object_by_path` refuses ambiguous matches** and returns `None`. Pass a more specific path.
- **`is_simulation_mode` getter returns `None`** on some device descriptors. The setter works; verify via compile + login.

## Troubleshooting

**CODESYS not found** — verify with `--detect`. Executable is typically at `C:\Program Files\CODESYS 3.5.XX.X\CODESYS\Common\CODESYS.exe`.

**Every tool call returns `Marshal error: ... is no longer supported`** — you're on SP21+. Restart with `--mode headless`.

**Watcher timeout** — default is 180s. Cold first launches of older SPs can exceed the older 60s budget. Bump further on slow hardware: `CODESYS_MCP_READY_TIMEOUT_MS=300000`. If CODESYS is still coming up, just call `launch_codesys` again — the launcher will re-attach to the live PID rather than spawning a second instance.

**Command timeout** — default 60s; `compile_project`, `get_all_pou_code`, and `download_to_device` use 120s. Increase with `--timeout <ms>`.

**Project file locked across MCP restarts** — the launcher adopts a live session from the prior server on startup. If you still hit `StandardError: The selected project is currently in use`, kill the orphan `CODESYS.exe` via Task Manager, or pass `--kill-existing-codesys` on next launch (off by default to protect external IDE sessions).

**Online tools fail** — they require a device/gateway configured (or `connect_to_device(ipAddress=...)`, or `set_simulation_mode(enable=true)`), a successful compile, and a reachable PLC.

**`Network error: No route to host` from `connect_to_device`** even though `ping` works — V3 login routes by the gateway-scan node address (e.g. `0301.B0F7`), not by the IP-encoded form (`0192.0168.0083.0247`) that `set_gateway_and_address` stores from a raw IP. `connect_to_device` re-scans and re-sets the address before login; if it still fails, the gateway-to-runtime port (TCP 11740 by default) is probably blocked.

## Development

```bash
npm install
npm run build      # tsc + copy src/scripts/ -> dist/scripts/
npm test
npm run typecheck
pwsh dev/check-scripts.ps1   # ASCII + template-reference static checks
```

Project layout:

```
src/
  bin.ts              CLI entry point
  server.ts           MCP tool / resource registration
  launcher.ts         CODESYS process management + session adoption
  ipc.ts              File-based IPC transport
  headless.ts         Headless fallback executor
  script-manager.ts   Python template loading + interpolation
  executor-proxy.ts   Race-free executor swap during background auto-launch
  result-parser.ts    RESULT_JSON marker extraction
  scripts/            IronPython 2.7 watcher + helpers + tool scripts
tests/
  unit/               IPC, script manager, launcher
  integration/        Script pipeline + manual CODESYS tests
```

## License

MIT
