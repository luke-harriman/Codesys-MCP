> ## About this fork
>
> **Codesys-MCP-SP21+** -- a fork of [luke-harriman/Codesys-MCP](https://github.com/luke-harriman/Codesys-MCP) maintained at [phobicdotno/Codesys-MCP-SP21-plus](https://github.com/phobicdotno/Codesys-MCP-SP21-plus) on branch `sp21-plus-migration-notes`.
>
> **Why fork.** Upstream's watcher relies on `system.execute_on_primary_thread()` to marshal work from a background thread back to the CODESYS UI thread. That API was **removed in CODESYS V3.5 SP21+**, so on SP21 / SP22 every tool call returned the same `Marshal error: The functionality 'system.execute_on_primary_thread(...)' is no longer supported` and the server was effectively unusable on current CODESYS releases.
>
> **What's fixed in this fork:**
>
> - **SP21+/SP22 compatibility** — the watcher was rewritten as single-threaded on the primary thread, yielding to the IDE via `system.delay()`. No background thread, no marshaling. Works on SP19, SP21, and SP22+. Full rationale in [`docs/MIGRATION-SP21-PLUS.md`](docs/MIGRATION-SP21-PLUS.md).
> - **Cancel-link hardening** — the watcher now catches `KeyboardInterrupt` (which is not a subclass of `Exception` in Python) at three layers, so clicking *"Click here to CANCEL this operation"* in CODESYS no longer pops the modal traceback dialog or kills the watcher. Bumped to `WATCHER_VERSION 0.4.2`.
>
> **Verified state of every tool** is recorded in [`docs/SMOKE-TEST-2026-04-25.md`](docs/SMOKE-TEST-2026-04-25.md): 17 of 28 invocations pass, 8 fail, 3 are partial. The failures are *upstream* bugs unrelated to the SP21+ fix (e.g. `create_folder` keyword mismatch, JSON `long` serialization in `compile_project`, online-API drift in `connect_to_device` / `write_variable`) and are tracked there for follow-up PRs.

# Codesys-MCP-SP21+

MCP server for CODESYS with a persistent UI instance and file-based IPC. npm package: `codesys-mcp-sp21-plus`.

Unlike headless-only approaches that spawn a new CODESYS process per command, this server launches CODESYS **with its UI visible** and keeps it running. MCP tool calls are sent to the same instance via a file-based IPC watcher, so changes appear in real-time and the user can interact with the IDE alongside AI-driven automation.

## Features

- **Persistent mode** — CODESYS UI stays open; commands execute in the running instance
- **Headless fallback** — automatic fallback to `--noUI` spawn-per-command if persistent mode fails
- **File-based IPC** — proven approach using atomic file writes and a Python watcher script
- **Command serialization** — async mutex ensures one command at a time
- **Health monitoring** — detects CODESYS crashes and reports state
- **37 MCP tools** — project management, POU authoring, structured compiler diagnostics, runtime monitoring, library management, version-anchor + release pipeline, CODESYS Git plugin (PDE license-gated), source-mirror export
- **Drop-in replacement** — same MCP tool names and parameters as `@codesys/mcp-toolkit`

## Installation

This is a **Node.js MCP server** (npm). There is no `pip install` — the `.py` files you see under `src/scripts/` are CODESYS IronPython templates that get rendered and shipped *inside* the npm package, not a separate Python distribution.

This fork is **not currently published to the npm registry**, so you install it directly from this GitHub repo. Three options:

### Option 1: Install from GitHub (recommended for end users)

```bash
npm install -g github:phobicdotno/Codesys-MCP-SP21-plus
```

After install, the `codesys-mcp-sp21-plus` binary is on your PATH and the MCP client config example in [Quick Start](#quick-start) works as written.

### Option 2: Clone + npm link (recommended for development)

```bash
git clone https://github.com/phobicdotno/Codesys-MCP-SP21-plus.git
cd Codesys-MCP-SP21-plus
npm install
npm run build
npm link
```

`npm link` makes your local checkout the global `codesys-mcp-sp21-plus` binary, so edits to `src/` take effect after `npm run build` without re-installing. (Python script edits hot-reload from `dist/scripts/` even without `npm run build` — see [`tests/TEST_OVERVIEW.md`](tests/TEST_OVERVIEW.md) for the iteration-loop notes.)

### Option 3: Run via `node` directly (no global install)

```bash
git clone https://github.com/phobicdotno/Codesys-MCP-SP21-plus.git
cd Codesys-MCP-SP21-plus
npm install
npm run build
```

Then in `.mcp.json`, use `"command": "node"` and a fully-qualified path to `dist/bin.js`:

```json
{
  "mcpServers": {
    "codesys": {
      "command": "node",
      "args": [
        "C:\\Users\\<you>\\Codesys-MCP-SP21-plus\\dist\\bin.js",
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.22.10\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP22 Patch 1",
        "--mode", "persistent"
      ]
    }
  }
}
```

This avoids touching the global node_modules, useful when the same machine has multiple forks/versions checked out.

**Requirements:** Node.js 18+, Windows, CODESYS 3.5 SP19, SP21 (3.5.21.x), or SP22 (3.5.22.x) installed. CODESYS Git plugin tools additionally require an active **CODESYS Professional Developer Edition** subscription license — without it, every `git_*` call fails fast with a clear PDE-required message.

**Heads-up on `npm install -g codesys-mcp-sp21-plus` (without the `github:` prefix):** that bare-name form is what you'd run *if* this fork were published to the npm registry, but it isn't. It will fail with `404 Not Found`. Use one of the three options above.

## Quick Start

Add to your `.mcp.json` (Claude Code configuration):

```json
{
  "mcpServers": {
    "codesys": {
      "command": "codesys-mcp-sp21-plus",
      "args": [
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.22.10\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP22 Patch 1",
        "--mode", "persistent"
      ]
    }
  }
}
```

Or run directly:

```bash
codesys-mcp-sp21-plus \
  --codesys-path "C:\Program Files\CODESYS 3.5.22.10\CODESYS\Common\CODESYS.exe" \
  --codesys-profile "CODESYS V3.5 SP22 Patch 1"
```

### Multiple CODESYS installations

The MCP server is bound to a **single** `--codesys-path` / `--codesys-profile` at startup. `launch_codesys` takes no parameters — it just starts whichever CODESYS the server was configured against. If you have several CODESYS versions installed and want to drive them all from the same Claude Code session, register **one MCP server entry per install** with a distinct name.

Both blocks below live in the same `.mcp.json`. Claude can call either by name (`codesys-21` / `codesys-22`) and the two run as independent processes with independent CODESYS instances:

```json
{
  "mcpServers": {
    "codesys-21": {
      "command": "codesys-mcp-sp21-plus",
      "args": [
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.21.50\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP21 Patch 5",
        "--mode", "persistent"
      ]
    },
    "codesys-22": {
      "command": "codesys-mcp-sp21-plus",
      "args": [
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.22.10\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP22 Patch 1",
        "--mode", "persistent"
      ]
    }
  }
}
```

Notes:

- The version numbers (`3.5.21.50`, `3.5.22.10`) match the install directory names under `C:\Program Files\` — these are the actual install IDs CODESYS uses, not the marketing names. The marketing name lives in `--codesys-profile` (e.g., `CODESYS V3.5 SP21 Patch 5`, `CODESYS V3.5 SP22 Patch 1`).
- Run `codesys-mcp-sp21-plus --detect` once to print every CODESYS install the server can see, with its profile name; copy the values from there into `.mcp.json` rather than guessing.
- Each server entry spawns its own CODESYS process when first invoked. Don't call `launch_codesys` on both at the same time pointing at projects that overlap — two CODESYS instances racing on the same `.project` file pop a "project is currently in use" modal that blocks every subsequent script.
- Adding or removing an entry requires a Claude Code restart (the MCP client only reads `.mcp.json` at startup).

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
| `list_project_libraries` | List all libraries referenced in the project with version info, plus IDE version, devices, and per-Application compiler version |
| `add_library` | Add a library reference. Pre-resolves via `library_manager.find_library` and prefers the managed-library overload; refuses to save if the resulting reference is an unresolvable placeholder (which would brick the next project open) |

### Version Anchor + Release Pipeline

These tools maintain a `_MCP_PROJECT_VERSION` GVL inside the project so the running PLC carries its source version at a known address, and orchestrate the end-to-end release flow (mirror → classify → bump → regen .md → git commit + tag + push).

| Tool | Description |
|------|-------------|
| `bump_project_version` | Bump one part of the 4-part `Project Information.Version` (major / minor / revision / build / auto) and maintain the `_MCP_PROJECT_VERSION.sVersion` GVL. `auto` mode classifies via mirror diff vs the latest `v*` git tag (deletion/rename → major; addition → minor; modification → revision; first-run → seed at 1.0.0.0) |
| `release_project_version` | One-shot release pipeline: `mirror_export` → classify → `bump_project_version` → regenerate library.md/pou-dump.md/README.md/Changelog.md → `git add` controlled paths → `git commit` → `git tag v<new>` → `git push --follow-tags`. Tag annotation embeds dual SHAs (project-sha256 + mirror-sha256) so SHA-fallback case (c) — binary changed without source diff — gets a build-bump with provenance |
| `read_running_version_online` | Reads `_MCP_PROJECT_VERSION.sVersion` from the running PLC over the CODESYS online protocol (port 11740 / gateway). Returns the live value plus a sanity check against the X.Y.Z.W shape. *Caveat: requires some IEC code to reference the variable so the optimizer doesn't strip it from the online symbol table — see the tool's error message for the one-line fix.* |

### Source Mirror

| Tool | Description |
|------|-------------|
| `mirror_export` | Walks the project tree and writes one `.st` file per code-bearing object into `<projectDir>/mcp-mirror/`, preserving the project tree as nested directories. Read-only (does NOT modify the CODESYS project). Companion of `release_project_version`'s classifier |

### CODESYS Git (PDE license-gated)

These tools wrap CODESYS's own Git plugin. **All of them require an active CODESYS Professional Developer Edition subscription license** — without it, the runtime's `HasGitLicense` rule fails fast with a clear PDE-required message. Distinct from the orchestration-level git operations baked into `release_project_version` (which use the system `git` binary and don't need PDE).

| Tool | Description |
|------|-------------|
| `git_init` | Initialise a Git working tree via `project.git.init()`. Dual-storage model: the `.project` stays where it is; the git repo lives in a SEPARATE directory (auto-defaults to `<basename>_git` sibling). Pass an explicit `localRepoPath` on a local drive when the project lives on a network share — UNC paths are rejected by the plugin |
| `git_status` | Reports current branch + a probe of any status/changes/diff methods exposed on `project.git`. Read-only |
| `git_commit` | Stages all working-tree changes and commits via `project.git.commit_complete(message, user, mail)` |
| `git_remote_add` | Adds a named remote via `project.git.remote_add(name, url)` |
| `git_branch_set_upstream_to` | Sets the current branch's upstream tracking ref via `project.git.branch_set_upstream_to(remoteName, branchName?)`. **Mandatory before the first push to a fresh remote** — without it, `git_push` fails with "branch does not track an upstream branch" |
| `git_push` | Pushes the current branch via `project.git.push()`. If `username + token` are both supplied, uses the 3-arg overload `push(branch, user, SecureString(token))`; otherwise relies on cached credentials / Windows Credential Manager. **Security: when a token is supplied, it is briefly resident in the watcher's command file on disk — prefer cached credentials.** |

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
codesys-mcp-sp21-plus --detect
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
