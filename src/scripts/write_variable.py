import sys, scriptengine as script_engine, os, traceback

VARIABLE_PATH = "{VARIABLE_PATH}"
VARIABLE_VALUE = "{VARIABLE_VALUE}"

try:
    print("DEBUG: write_variable script: Variable='%s', Value='%s', Project='%s'" % (
        VARIABLE_PATH, VARIABLE_VALUE, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not VARIABLE_PATH:
        raise ValueError("Variable path empty.")

    online_app, target_app = ensure_online_connection(primary_project)
    app_name = getattr(target_app, 'get_name', lambda: "Unknown")()
    # Auto-login -- idempotent in persistent mode, required in headless.
    ensure_logged_in(online_app)

    # SP21+/SP22 uses a two-step prepare-then-write pattern:
    #   1) set_prepared_value(name, value) -- stage the value
    #   2) write_prepared_values()         -- commit the staged writes
    # Older SPs (and some sandboxed configurations) expose direct
    # write_value(name, value) / write(name, value). Try the modern path
    # first, fall back to direct.
    written = False
    last_err = None

    if hasattr(online_app, 'set_prepared_value') and hasattr(online_app, 'write_prepared_values'):
        try:
            online_app.set_prepared_value(VARIABLE_PATH, VARIABLE_VALUE)
            online_app.write_prepared_values()
            print("DEBUG: set_prepared_value + write_prepared_values OK")
            written = True
        except Exception as e:
            last_err = e
            print("DEBUG: set_prepared_value + write_prepared_values failed: %s: %s" % (type(e).__name__, e))

    if not written:
        for method_name in ('write_value', 'set_value', 'write', 'set'):
            if not hasattr(online_app, method_name):
                continue
            try:
                getattr(online_app, method_name)(VARIABLE_PATH, VARIABLE_VALUE)
                print("DEBUG: %s(name, value) OK" % method_name)
                written = True
                break
            except Exception as e:
                last_err = e
                print("DEBUG: %s(name, value) failed: %s: %s" % (method_name, type(e).__name__, e))

    if not written:
        attrs = sorted([a for a in dir(online_app) if not a.startswith('_')])
        raise RuntimeError(
            "Could not write variable. Last error: %s\n"
            "Available attributes on online_app: %s" % (last_err, attrs)
        )

    print("Variable: %s" % VARIABLE_PATH)
    print("Value Written: %s" % VARIABLE_VALUE)
    print("Application: %s" % app_name)
    print("SCRIPT_SUCCESS: Variable written successfully.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error writing variable '%s' in project %s: %s\n%s" % (
        VARIABLE_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
