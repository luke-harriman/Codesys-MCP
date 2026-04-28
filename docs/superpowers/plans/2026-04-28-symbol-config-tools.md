# Plan: Symbol Configuration MCP tools

**Date:** 2026-04-28
**Owner:** karstein.kvistad
**Target:** Codesys-MCP fork @ `phobicdotno/Codesys-MCP-SP21-plus` `main`
**Reference API:**
  - SP22 stub: `C:\Program Files\CODESYS 3.5.22.10\CODESYS\ScriptLib\Stubs\scriptengine\ScriptSymbolConfigObject.pyi`
  - Docs: https://content.helpme-codesys.com/en/ScriptingEngine/ScriptSymbolConfigObject.html

## Why

The Symbol Configuration object controls which IEC variables / FBs / methods are exposed to OPC UA, web visualisations, and external clients. Today the MCP fork has zero coverage: you cannot create the object, list what's exported, change access flags, or tweak the OPC UA / comment filter / attribute filter from script. This plan adds 10 tools spanning discovery, creation, configuration, per-variable access control, and XSD export.

The CODESYS scripting API has been stable on this surface since 3.5.10.0. SP22 stub is the implementation truth.

Out of scope: actual build/emit of the symbol XML — that happens inside `application.build()`, which `compile_project` already triggers. There is no separate `build_symbol_config()` API method.

## API surface map

| # | Tool name                        | CODESYS API entry point                                       | Side effect | Tier      |
|---|----------------------------------|---------------------------------------------------------------|-------------|-----------|
| 1 | `find_symbol_config`             | walk children, check `is_symbol_config`                       | read-only   | discovery |
| 2 | `list_all_signatures`            | `symconf.get_all_signatures(compile=bool)`                    | builds app  | discovery |
| 3 | `list_all_datatypes`             | `symconf.get_all_datatypes(compile=bool)`                     | builds app  | discovery |
| 4 | `list_configured_symbols`        | `get_only_configured_signatures()` + `get_only_configured_datatypes()` | read-only | discovery |
| 5 | `get_symbol_config_settings`     | read 6 knobs on `ScriptSymbolConfigObject`                    | read-only   | discovery |
| 6 | `create_symbol_config`           | `application.create_symbol_config(exp_comments, opc_ua, layout_guid)` | writes object | setup |
| 7 | `set_symbol_config_settings`     | partial-update of knobs                                       | mutates     | config    |
| 8 | `set_symbol_access`              | one variable's `configured_access` setter                     | mutates     | access    |
| 9 | `set_signature_access_bulk`      | every variable in one signature                               | mutates     | access    |
| 10| `export_symbol_xsd`              | `get_symbol_configuration_xsd()` bytes → file                 | writes file | output    |

Settings reachable via #5/#7:
- `content_feature_flags` (`SymbolConfigContentFeatureFlags` bitmask: `SupportOPCUA`, `IncludeComments`, `IncludeAttributes`, `IncludeTypeNodeAttributes`, `IncludeExecutables`, `UseEmptyNamespaceByDefault`, plus `XmlInclude*` mirrors)
- `symbol_attribute_filter_type` (`None`/`All`/`SimpleIdentifiers`/`Prefix`/`Regex`)
- `symbol_attribute_filter_data` (string for prefix/regex modes)
- `symbol_comment_filter_type` (`None`/`Normal`/`Docu`/`Both`/`PreferNormal`/`PreferDocu`)
- `enable_direct_io_access` (bool, plus `check_effective_direct_io_access()` for diagnostics)
- `client_side_layout_calculator_guid` (Guid)

## Files to add / change

```
src/scripts/find_symbol_config.py            (new)
src/scripts/list_all_signatures.py           (new)
src/scripts/list_all_datatypes.py            (new)
src/scripts/list_configured_symbols.py       (new)
src/scripts/get_symbol_config_settings.py    (new)
src/scripts/create_symbol_config.py          (new)
src/scripts/set_symbol_config_settings.py    (new)
src/scripts/set_symbol_access.py             (new)
src/scripts/set_signature_access_bulk.py     (new)
src/scripts/export_symbol_xsd.py             (new)

src/server.ts                                (10 new s.tool() blocks under a "Symbol Configuration Tools" section)
tests/integration/e2e.test.ts                (10 new template-prep assertions)
tests/integration/symbol-config.test.ts      (new live-CODESYS smoke test, opt-in via env)
README.md                                    (tool count + new section anchor)
docs/function-test-2026-04-28.md             (append a verification block once implemented)
```

## Conventions to follow

- Templates use `r"..."` raw strings around `{PROJECT_FILE_PATH}` placeholders (existing pattern).
- Every script imports `ensure_project_open` via the helper system; tools that need an Application also resolve it through `ensure_application` (new helper — see step 1).
- `print("SCRIPT_SUCCESS: ...")` on success, `print("SCRIPT_ERROR: ...")` on failure, `sys.exit(0|1)` accordingly. The watcher's IPC layer keys off these markers.
- No CRLF in committed files — let git's `core.autocrlf` handle it.
- ASCII-only Python source (IronPython 2.7 trap from `codesys_scripting_gotchas.md`).
- `KeyboardInterrupt` is NOT a subclass of `Exception` — always catch separately or use bare `except:` then re-raise (per the gotchas memory).

## Step-by-step checklist

### Phase 0 — shared scaffolding

- [ ] **0.1** Add a helper script `src/scripts/find_symbol_config_object.py` (lowercase, with `_object` suffix to avoid colliding with the user-facing tool template). This helper:
  - Takes a `primary_project` already in scope.
  - Walks `primary_project.get_children(True)` (recursive), returns the first node where `node.is_symbol_config` is True, or None.
  - Used by tools #1–#5, #7–#10. Tool #6 (`create_symbol_config`) skips it and uses `application.create_symbol_config(...)` directly.
- [ ] **0.2** Add a helper `ensure_symbol_config(primary_project)` that returns the symconf object or raises `RuntimeError("No Symbol Configuration in project. Call create_symbol_config first.")`.
- [ ] **0.3** Wire helper into the `prepareScriptWithHelpers` allow-list in `src/script-manager.ts` (mirror how `ensure_project_open` is registered).
- [ ] **0.4** Define a TypeScript-side enum-string mapper in `src/server.ts`:
  - `SymbolAccessString` ↔ Python int. The IronPython enum `SymbolAccess` (defined in the dotNETs side, not in this stub) typically has values `None=0, ReadOnly=1, WriteOnly=2, ReadWrite=3`. Verify via a one-shot `dir(variable.configured_access)` probe before locking the mapping in.
  - `ContentFeatureFlagsString` ↔ Python int (bitmask combine of `SupportOPCUA`/`IncludeComments`/etc.).
  - `AttributeFilterTypeString` ↔ Python int.
  - `CommentFilterTypeString` ↔ Python int.
  - These mappers live in TS so callers get string-arg ergonomics; the script side reads them as plain ints.

### Phase 1 — discovery tools (read-only, can land first)

- [ ] **1.1** `find_symbol_config.py` + `s.tool('find_symbol_config', …)`:
  - Args: `projectFilePath`.
  - Output: object path under the project, or `null` + a "no symbol config found — call create_symbol_config" hint.
  - Implementation: helper `find_symbol_config_object(primary_project)` then format the path via `parent.get_name()` walk.
- [ ] **1.2** `list_all_signatures.py` + tool:
  - Args: `projectFilePath`, `compile?: boolean` (default `false` — set `true` to force a build first).
  - Output: JSON list of `{ fqn, name, libraryId, namespacePath, variableCount }`.
  - Note in description: `compile=true` triggers `application.build()` and is slow; default is the cached signatures.
- [ ] **1.3** `list_all_datatypes.py` + tool: same shape as 1.2 but `get_all_datatypes()`.
- [ ] **1.4** `list_configured_symbols.py` + tool:
  - Args: `projectFilePath`.
  - Output per signature: `fqn`, list of variables with `{ name, type, comment, configuredAccess, effectiveAccess, maximalAccess, exportedViaAttribute }`.
  - Plus a section for configured datatypes.
- [ ] **1.5** `get_symbol_config_settings.py` + tool:
  - Output: JSON of all 6 knobs (current + effective values for the three filters), plus `directIoObstacles` from `check_effective_direct_io_access()`.

### Phase 2 — setup tool

- [ ] **2.1** `create_symbol_config.py` + tool:
  - Args: `projectFilePath`, `applicationPath` (e.g. `Application` or `Application/MyApp`), `exportCommentsToXml?: boolean` (default `true`), `supportOpcUa?: boolean` (default `true`), `layoutCalculator?: 'compatibility' | 'optimized'` (default `'compatibility'`, maps to `Guid.Empty`; `'optimized'` maps to `{0141eb75-141b-4ea1-9a8c-75f952b22a6c}`).
  - Pre-check: refuse if a Symbol Configuration already exists under that Application — prints helpful "found at <path>" and `SCRIPT_SUCCESS` (idempotent).
  - Implementation: resolve Application via existing `find_object_by_path`-style walk, then call `application.create_symbol_config(exportCommentsToXml, supportOpcUa, guid)`. Save the project.

### Phase 3 — config tools

- [ ] **3.1** `set_symbol_config_settings.py` + tool:
  - Args (all optional, only those supplied are changed):
    - `contentFeatureFlags?: string[]` (e.g. `['SupportOPCUA', 'IncludeComments', 'IncludeExecutables']`) — combined into bitmask.
    - `attributeFilterType?: 'None' | 'All' | 'SimpleIdentifiers' | 'Prefix' | 'Regex'`
    - `attributeFilterData?: string`
    - `commentFilterType?: 'None' | 'NormalComments' | 'DocuComments' | 'Both' | 'PreferNormalComments' | 'PreferDocuComments'`
    - `enableDirectIoAccess?: boolean`
    - `layoutCalculator?: 'compatibility' | 'optimized'`
  - Server saves the project after mutation.
  - Defensive: if `enableDirectIoAccess=true` and `check_effective_direct_io_access()` returns non-`none` obstacles, print the obstacle explanations and refuse with a clear message — don't silently leave the flag set with no effect.
  - **Verify enum values via probe** before committing: spawn a one-off script that does `from scriptengine import SymbolConfigContentFeatureFlags as sf; print([(m, getattr(sf, m)) for m in dir(sf) if not m.startswith('_')])` to confirm the integer values match what's in the SP22 stub. (Stub says SupportOPCUA=1, IncludeComments=2, IncludeAttributes=4, etc. — these are well-defined since 3.5.8.30, very low risk of drift, but cite the probe in the commit per the `feedback_check_helpme_codesys_first` rule.)

### Phase 4 — access tools

- [ ] **4.1** `set_symbol_access.py` + tool:
  - Args: `projectFilePath`, `signatureFqn` (e.g. `Application.PLC_PRG`), `variableName` (e.g. `nCounter`), `access`: `'None' | 'ReadOnly' | 'WriteOnly' | 'ReadWrite'`.
  - Implementation: `signatures = symconf.get_all_signatures(compile=False)`; `sig = signatures.find(fqn)`; locate variable in `sig.variables` by name; `var.configured_access = enum_value`.
  - Refuse with clear message if `var.maximal_access` doesn't allow the requested access (e.g. trying to set ReadWrite on a CONSTANT).
  - Save project.
- [ ] **4.2** `set_signature_access_bulk.py` + tool:
  - Args: `projectFilePath`, `signatureFqn`, `access`. Sets every variable in the signature to that access (clamped by each variable's `maximal_access`). Returns count of variables changed vs skipped.
  - Save project once at the end.

### Phase 5 — output tool

- [ ] **5.1** `export_symbol_xsd.py` + tool:
  - Args: `projectFilePath`, `outputFilePath` (where to write the XSD).
  - Implementation: `xsd_bytes = symconf.get_symbol_configuration_xsd()`; write bytes to `outputFilePath` (UTF-8). Refuse if outputFilePath's parent dir doesn't exist.
  - Useful for downstream tooling (XML schema validation of the generated symbol XML).

### Phase 6 — wiring + tests

- [ ] **6.1** Add 10 e2e template-prep assertions to `tests/integration/e2e.test.ts` mirroring the existing pattern (one per tool, asserts the rendered script contains the placeholder substitutions and the success marker).
- [ ] **6.2** Add `tests/integration/symbol-config.test.ts` — a live-CODESYS suite gated behind `CODESYS_LIVE=1` env (skipped by default). Cycle:
  1. Open MCPTest2.
  2. `find_symbol_config` — expect null (MCPTest2 doesn't have one).
  3. `create_symbol_config` against `Application` with default args.
  4. `find_symbol_config` again — expect non-null path.
  5. `get_symbol_config_settings` — assert OPC UA on, comment filter Both, etc.
  6. `set_symbol_config_settings` flipping `enableDirectIoAccess=false` and adding `IncludeExecutables` to feature flags. Re-read and assert.
  7. `list_all_signatures(compile=true)` — expect non-empty.
  8. `list_configured_symbols` — expect empty (nothing checked yet).
  9. `set_signature_access_bulk Application.PLC_PRG ReadWrite`. Re-list configured — expect every PLC_PRG variable shows up with ReadWrite.
  10. `set_symbol_access Application.PLC_PRG nCounter None`. Re-list — expect nCounter dropped or shown as None.
  11. `export_symbol_xsd` to a temp path — assert the file exists and starts with `<?xml`.
  12. Cleanup: delete the symbol config object via the existing `delete_object` tool.
- [ ] **6.3** Update tool count in `README.md` (currently 31; this plan adds 10 → 41) and add anchor link to the Symbol Configuration section.
- [ ] **6.4** Append verification block to `docs/function-test-2026-04-28.md` once Phase 6.2 is green.

### Phase 7 — release

- [ ] **7.1** Commit per phase (one commit per tool ideally, or one per phase). Push immediately per the `feedback_commit_every_working_change` rule.
- [ ] **7.2** Bump the npm version in `package.json` to a new minor (`0.5.0`) and add a release commit.
- [ ] **7.3** Tag + publish via `npm publish` (the `phobic` account, passkey 2FA — see `npm_publish_phobic` memory).

## Verification plan

Live run on SP22 Patch 1 against MCPTest2 once Phase 6.2 lands. Use the same pattern as the 2026-04-28 function test: open the project, exercise each tool, confirm via the read tools, clean up, no leftover state. Mark each tool PASS / PARTIAL / FAIL in `function-test-2026-04-28.md`.

A second pass on X33 (the real Maritime Robotics project) once MCPTest2 is green — X33 uses Symbol Configuration in production and is the target consumer of these tools.

## Risks / unknowns

- **`SymbolAccess` enum values**: the SP22 stub references `SymbolAccess` but doesn't declare it inline (it lives in the C# side). Need a one-shot probe before locking the integer values. Standard CODESYS values are `None=0, ReadOnly=1, WriteOnly=2, ReadWrite=3`; very stable across SPs. Cite the probe in commit 4.1.
- **`get_all_signatures(compile=True)` blocks**: builds the application synchronously. Could be slow on big projects (X33 ~30s). Document this in the tool description. Default the param to `false` and let callers opt in.
- **Application path resolution**: `create_symbol_config` needs an Application object, not a generic ScriptObject. The find walk must skip non-Application matches. Reuse the `is_application` marker check from `compile_project.py`.
- **SP19 / SP21 coverage**: the stub class is `:version added: 3.5.10.0` so SP19+ should all work, but `IncludeExecutables` is `3.5.11.0+`. If a caller sets that flag on an older SP, the property setter may raise. Catch and surface a "not supported on this SP" message in `set_symbol_config_settings`.
- **Idempotency**: `create_symbol_config` should refuse-with-success if an object already exists, not error. `set_*` tools should accept the same input twice without complaint. The probe for existing-state belongs at the top of every modifying script.

## Out of scope for this plan

- Building the symbol XML directly. There is no `build_symbol_config()` API; the XML is emitted as a side-effect of `application.build()`, which `compile_project` already triggers. Note this in the tool descriptions for #2/#3 (they accept `compile=true` to force a build but do not emit the symbol XML themselves).
- Symbol-level RPC / OPC UA browsing. The Symbol Configuration plug-in only declares which symbols are *exposed*; actually browsing them at runtime is an OPC UA client concern, not a CODESYS scripting one.
- The "Communication Settings" tab on the Symbol Configuration object (TLS, credentials, etc.). That's a separate ScriptObject family and not in the SP22 stub at this path.
- Visualisation symbol lists. CODESYS visualisations have their own symbol-list mechanism that doesn't go through `ScriptSymbolConfigObject`.

## Estimated effort

| Phase | LoC est. | Effort |
|------:|---------:|--------|
| 0 — scaffolding         | ~80   | half-day |
| 1 — 5 discovery tools   | ~250  | one day  |
| 2 — create tool         | ~80   | half-day |
| 3 — settings setter     | ~120  | half-day (probe + enum mapper is the slow part) |
| 4 — 2 access tools      | ~150  | half-day |
| 5 — XSD export          | ~40   | quick    |
| 6 — tests + docs        | ~200  | one day  |
| 7 — release             |   -   | quick    |

Total: roughly 3 working days at the current pace, including the live verification pass.
