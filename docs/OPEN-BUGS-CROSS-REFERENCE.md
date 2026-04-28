# Open bugs -- cross-referenced against the official CODESYS scripting docs

For each of the 5 remaining MCP tool bugs from
[FUNCTION-TEST-2026-04-25.md](FUNCTION-TEST-2026-04-25.md), this document
records:

  1. The empirical failure observed locally on SP22 Patch 1.
  2. The relevant official documentation URL on https://content.helpme-codesys.com.
  3. What the docs say (or do not say -- many pages are index-only with the
     actual method bodies behind JavaScript).
  4. The proposed fix path with reasoning.

This is the cross-reference pass requested per the project rule: check
helpme-codesys before fixing or adding scripting code.

---

## Bug 1: `create_folder` -- `unexpected keyword argument 'name'`

**Empirical failure** (`src/scripts/create_folder.py` line 344):
```
TypeError: create_folder() got an unexpected keyword argument 'name'
```
Fork's call site uses `name=...` kwarg; the underlying CODESYS API rejects
the keyword.

**Documentation:**
  - https://content.helpme-codesys.com/en/ScriptingEngine/ScriptObject.html
    confirms `create_folder()` exists on `ScriptObject` (and on
    `ScriptProject`, `ScriptTreeObject`).
  - The page index lists the method but doesn't surface the parameter
    list in the WebFetch'able content. The signature is rendered from
    JavaScript -- inspection in a real browser or via `help(obj.create_folder)`
    inside a CODESYS scripting session would return the canonical signature.

**Proposed fix:**
Try positional invocation first:

```python
new_folder = parent.create_folder('TestFolder')
```

If positional fails too, probe with the same defensive pattern as
`install_library_file.py` (try several kwarg names and dump `dir(parent)`
on total miss). High confidence the positional form works -- it's the
convention everywhere else in the scriptengine API for tree-creation
methods (`add_library('Standard')`, `add_placeholder('IoStandard')`).

**Effort:** ~10 lines. Single-line change to call site, plus diagnostic.

---

## Bug 2: `compile_project` / `get_compile_messages` -- `281474976710655L is not JSON serializable`

**Empirical failure** in `src/scripts/compile_project.py` (line 330) and
`src/scripts/get_compile_messages.py` (line 315):
```
TypeError: 281474976710655L is not JSON serializable
```
`system.get_message_objects()` returns a dict whose value contains an
IronPython 2.7 `long` (`0xFFFFFFFFFFFF` = the Severity bitmask), and
the stdlib `json` module's encoder rejects `long`.

**Documentation:**
  - https://content.helpme-codesys.com/en/ScriptingEngine/ScriptSystem.html
    confirms `get_message_objects()` and `get_messages()` exist on
    `system`. Return-type details aren't surfaced in the index page.
  - The IronPython 2.7 stdlib `json` is documented to NOT handle
    `long` -- a known limitation of the `_default_encoder`.

**Proposed fix:**
Two-part:

1. **Pre-process the message dict** to coerce any `long` to `int` or
   `str` before `json.dumps`:

   ```python
   def _coerce_for_json(obj):
       if isinstance(obj, (int, long)):
           return int(obj)  # downcast; or str(obj) if value > 2**63
       if isinstance(obj, dict):
           return {k: _coerce_for_json(v) for k, v in obj.items()}
       if isinstance(obj, (list, tuple)):
           return [_coerce_for_json(v) for v in obj]
       return obj

   messages_json = json.dumps(_coerce_for_json(messages), indent=2)
   ```

2. **Belt-and-suspenders**: pass `default=str` to `json.dumps` so any
   future un-handled type degrades to its repr instead of throwing.

Both call sites (`compile_project.py`, `get_compile_messages.py`) share
the same encoder path -- single helper in a new
`src/scripts/_json_compat.py` (or inline) addresses both.

**Effort:** ~15 lines for the helper + 2 call sites. Single commit.

---

## Bug 3: `list_project_libraries` -- "No libraries found" after successful `add_library`

**Empirical failure** in `src/scripts/list_project_libraries.py`: returns
"No libraries found in the project (or Library Manager not found)" both
before AND after a successful `add_library` call. The `add_library`
operation visibly succeeds (CODESYS UI shows the new entry in Library
Manager), but the read path can't find the manager.

**Documentation:**
  - https://content.helpme-codesys.com/en/ScriptingEngine/ScriptLibManObject.html
    confirms the canonical iteration API:
      - `ScriptLibManObject.get_libraries()` -- returns all library
        references in the manager.
    Library reference objects expose properties: `name`, `namespace`,
    `is_placeholder`, `is_managed`.
  - Subclasses: `ScriptManagedLibraryReference` (with `managed_library`),
    `ScriptPlaceholderReference` (with `placeholder_name`,
    `default_resolution`).

**Likely root cause:**
The fork's `list_project_libraries.py` locates the manager via
`primary_project.find("Library Manager", True)` and inspects the
returned object directly. On SP22 Patch 1 this find may not return a
ScriptLibManObject (could be returning a generic ScriptObject wrapper
without `get_libraries`), or the find pattern doesn't match because the
display name has changed.

**Proposed fix:**
Use the same Library Manager discovery pattern as `add_library.py`
(which DOES succeed at writing), then call `.get_libraries()` on the
returned object. If the read path mirrors the write path's discovery,
the behaviour will be consistent.

```python
lib_manager = None
found = primary_project.find("Library Manager", True)
if found:
    lib_manager = found[0]
# fallback: walk children looking for one with 'library' + 'manager' in name
...
if hasattr(lib_manager, 'get_libraries'):
    refs = list(lib_manager.get_libraries())
else:
    raise RuntimeError("Library Manager object has no get_libraries() method")

for ref in refs:
    name = ref.name if hasattr(ref, 'name') else getattr(ref, 'get_name', lambda: '?')()
    namespace = ref.namespace if hasattr(ref, 'namespace') else ''
    version = getattr(ref, 'version', '?')
    is_placeholder = bool(getattr(ref, 'is_placeholder', False))
    print("  %s.%s = %s%s" % (namespace, name, version, " [placeholder]" if is_placeholder else ""))
```

**Effort:** ~30 lines. New iteration + formatting; reuse find pattern from add_library.py.

---

## Bug 4: `add_library` -- creates duplicate, doesn't add as `* (System)` placeholder

**Empirical failure** in `src/scripts/add_library.py`: calling
`add_library('Standard')` against a project that already has `Standard,
* (System)` adds a SECOND `Standard` reference. The new reference is
not a `* (System)` placeholder so it pulls in unresolved transitive
deps (e.g. `IoStandard 3.1.3.1` yellow-warning seen during this
session's manual cleanup of MCPTest).

**Documentation:**
  - https://content.helpme-codesys.com/en/ScriptingEngine/ScriptLibManObject.html
    confirms two distinct methods:
      - `add_library(...)` -- direct reference (specific version)
      - `add_placeholder(...)` -- placeholder reference (resolves at compile)
  - Library reference objects expose `name`, `namespace`,
    `is_placeholder`, `is_managed` -- usable for dedup checks.

**Proposed fix:**
Three behavioural changes to `add_library.py`:

1. **Pre-check existing references**. Before calling add, iterate
   `lib_manager.get_libraries()` and check if a reference with the same
   name (case-insensitive) already exists. If yes:
     - Default behaviour: silently no-op with a confirmation message
       ("Library 'Standard' already referenced as direct/placeholder").
     - Optional `force=true` param: add anyway (current behaviour).

2. **Default to placeholder add** (`add_placeholder`). The standard
   convention in modern CODESYS projects is `LibName, * (System)`.
   The Standard template ships its libraries this way. Add a new
   optional `direct=true` parameter to opt out and use `add_library`
   instead.

3. **Detect partial-success state**. If neither `add_library` nor
   `add_placeholder` is exposed on the located object, emit a clear
   error rather than silent-fail.

**Effort:** ~40 lines. New tool param signature change is mildly
breaking (existing callers get placeholder by default) -- bump the
fork minor version and document in release notes.

---

## Bug 5: `rename_object` -- updates own decl but not callers

**Empirical observation** (this session, MCPTest 2026-04-25):
`rename_object Application/ST_Sample -> ST_SampleRenamed` correctly
updated the struct's own internal `TYPE ST_Sample :` line to
`TYPE ST_SampleRenamed :`, BUT `Application/PLC_PRG`'s declaration
still referenced `s : ST_Sample;` -- the old name -- after the rename,
breaking the project.

**Documentation:**
  - https://content.helpme-codesys.com/en/ScriptingEngine/ScriptObject.html
    documents `rename()` -- no documented refactor variant or
    "rename_with_references" companion method.
  - No documented `find_references()` or "callers" API on
    ScriptObject / ScriptTreeObject in the index.

CODESYS UI's *Rename* command is a project-wide refactor (it walks
every POU and rewrites references) -- that capability is presumably
implemented in the IDE layer above scripting and not exposed via
scriptengine.

**Proposed fix:**
Brute-force text replace, gated behind an optional flag:

1. Add `updateReferences=true` (default) to the `rename_object` tool.
2. After the rename succeeds, iterate every POU/DUT/GVL via the
   existing `get_all_pou_code` enumeration pattern.
3. For each, regex-replace `\bOldName\b` -> `\bNewName\b` in both
   declaration and implementation code (word-boundary safe for
   global identifiers like FB/DUT/GVL names).
4. `set_pou_code` back the updated content for any POU whose code
   actually changed.

Risk: false positives for names that happen to match in comments or
strings; for type names this is rare. Document the risk in the tool
description.

Alternative: split into a separate `update_references_to_renamed_object`
tool so the responsibility stays narrow and `rename_object` keeps its
current minimal-surface behaviour.

**Effort:** ~80 lines. Separate Python helper script + Node-side wiring.
Highest LOC of the five but most user-visible win since rename is a
common operation.

---

## Order-of-attack recommendation

1. **#2 (JSON long)** -- 15 LOC, single helper, unblocks meaningful
   compiler diagnostics. Highest value/effort ratio.
2. **#1 (create_folder)** -- 10 LOC, trivial fix attempt with high
   probability of success (positional call).
3. **#4 (add_library duplication / placeholder)** -- 40 LOC,
   moderately breaking but matches modern CODESYS convention.
4. **#3 (list_project_libraries)** -- 30 LOC, depends on #4 to be
   verifiable end-to-end (need a working add to test the read).
5. **#5 (rename_object refactor)** -- 80 LOC, biggest, but lowest
   coupling to other fixes.

Each is its own commit per the project rule. Each commit message
should cite the relevant docs URL inline.
