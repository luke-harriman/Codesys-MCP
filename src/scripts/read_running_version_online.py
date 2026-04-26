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
                # Most common cause: the GVL is declared VAR_GLOBAL CONSTANT,
                # which CODESYS inlines at compile time -- the symbol never
                # makes it into the online table. This is a known footgun
                # because older bump_project_version emitted CONSTANT GVLs.
                raise RuntimeError(
                    "Online evaluator returned 'Invalid expression' for '%s'. "
                    "Most likely cause: the _MCP_PROJECT_VERSION GVL was created "
                    "with VAR_GLOBAL CONSTANT, which CODESYS inlines at compile "
                    "time so the symbol is not in the online symbol table. "
                    "Fix: edit _MCP_PROJECT_VERSION's declaration to drop "
                    "CONSTANT (just VAR_GLOBAL), then bump_project_version + "
                    "download_to_device. (newer bump_project_version emits "
                    "non-CONSTANT GVLs by default, so future-bumped projects "
                    "are unaffected.) Underlying error: %s" % (VARIABLE_PATH, e)
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
