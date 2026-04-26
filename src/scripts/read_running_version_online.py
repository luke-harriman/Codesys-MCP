import sys, scriptengine as script_engine, os, traceback, re

# Reads the running project's version from the PLC over the CODESYS online
# protocol (port 11740 on a soft PLC; gateway-resolved on real hardware).
# Looks at the standard runtime anchor maintained by bump_project_version:
#
#   _MCP_PROJECT_VERSION.sVersion : STRING
#
# Returns the string value plus a sanity check (matches X.Y.Z.W shape).
# Soft-fails if:
#   - the project hasn't been bumped yet (GVL missing)        -> clear hint
#   - the application isn't downloaded                         -> clear hint
#   - the connection drops mid-read                           -> error surfaced

VARIABLE_PATH = "_MCP_PROJECT_VERSION.sVersion"
VERSION_PATTERN = re.compile(r"\b(\d+\.\d+\.\d+\.\d+)\b")


try:
    print("DEBUG: read_running_version_online: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    online_app, target_app = ensure_online_connection(primary_project)
    app_name = getattr(target_app, 'get_name', lambda: 'Unknown')()
    print("DEBUG: connected to application '%s'" % app_name)
    # Auto-login -- idempotent in persistent mode, required in headless.
    ensure_logged_in(online_app)

    # Read the version anchor
    raw_value = None
    if hasattr(online_app, 'read_value'):
        try:
            result = online_app.read_value(VARIABLE_PATH)
            if result is not None:
                if hasattr(result, 'value'):
                    raw_value = result.value
                else:
                    raw_value = result
        except Exception as e:
            msg = str(e)
            msg_l = msg.lower()
            if 'invalid expression' in msg_l:
                # Two known causes lead here. Surface both with concrete
                # next steps; the user usually only hits ONE of them.
                raise RuntimeError(
                    "Online evaluator returned 'Invalid expression' for '%s'.\n"
                    "\n"
                    "TWO POSSIBLE CAUSES:\n"
                    "\n"
                    "(1) Old projects: the _MCP_PROJECT_VERSION GVL was created\n"
                    "    with VAR_GLOBAL CONSTANT. CODESYS inlines CONSTANT\n"
                    "    scalars at compile time so the symbol never reaches\n"
                    "    the online symbol table. Newer bump_project_version\n"
                    "    emits plain VAR_GLOBAL; existing projects auto-migrate\n"
                    "    on the next bump (the existing-GVL branch overwrites\n"
                    "    the declaration with the new template).\n"
                    "    Fix: run bump_project_version once + download_to_device.\n"
                    "\n"
                    "(2) Common case: CODESYS strips unreferenced GVLs from the\n"
                    "    online symbol table even if they're plain VAR_GLOBAL.\n"
                    "    By definition no IEC code references the version anchor,\n"
                    "    so the optimizer drops it. The bump tool does NOT\n"
                    "    auto-inject a reference (too invasive on user code).\n"
                    "    Fix: add a one-liner to your main PROGRAM (typically\n"
                    "    PLC_PRG). Declare a STRING var like\n"
                    "        sVersionTag : STRING;\n"
                    "    and assign it at the top of the implementation:\n"
                    "        sVersionTag := _MCP_PROJECT_VERSION.sVersion;\n"
                    "    Then download_to_device. The reference forces the\n"
                    "    symbol into the online table; this tool will then\n"
                    "    read it successfully.\n"
                    "\n"
                    "Underlying error: %s" % (VARIABLE_PATH, e)
                )
            if 'not found' in msg_l or 'unknown' in msg_l or 'symbol' in msg_l:
                raise RuntimeError(
                    "Variable '%s' not found on the running PLC. "
                    "Either bump_project_version has never been run on this project "
                    "(run it first to create the GVL), or the running boot application "
                    "predates the GVL (download_to_device after the bump to publish "
                    "the new symbol). Underlying error: %s" % (VARIABLE_PATH, e)
                )
            raise
    elif hasattr(online_app, 'read'):
        try:
            raw_value = online_app.read(VARIABLE_PATH)
        except Exception as e:
            raise RuntimeError(
                "Failed to read '%s' via .read(): %s" % (VARIABLE_PATH, e))
    else:
        raise TypeError(
            "Online application object does not expose read_value() or read(). "
            "This SP/install may have a different online API surface.")

    if raw_value is None:
        raise RuntimeError(
            "read_value returned None for '%s'. Often means the variable exists in "
            "the project but the running boot application doesn't include it -- "
            "did you download_to_device after the last bump?" % VARIABLE_PATH)

    version_str = str(raw_value).strip().strip("'\"")
    matches_shape = bool(VERSION_PATTERN.match(version_str))

    print("RUNNING_VERSION: %s" % version_str)
    print("Variable: %s" % VARIABLE_PATH)
    print("Application: %s" % app_name)
    print("Shape check (X.Y.Z.W): %s" % ("OK" if matches_shape else "WARN -- value does not look like a 4-part version"))
    print("SCRIPT_SUCCESS: read_running_version_online complete.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error reading running version from project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
