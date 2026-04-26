import sys, scriptengine as script_engine, os, traceback

VARIABLE_PATH = "{VARIABLE_PATH}"

try:
    print("DEBUG: read_variable script: Variable='%s', Project='%s'" % (VARIABLE_PATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not VARIABLE_PATH: raise ValueError("Variable path empty.")

    online_app, target_app = ensure_online_connection(primary_project)
    app_name = getattr(target_app, 'get_name', lambda: "Unknown")()
    # Auto-login -- idempotent in persistent mode, required in headless.
    ensure_logged_in(online_app)

    # Read the variable value
    value = None
    var_type = "unknown"

    if hasattr(online_app, 'read_value'):
        try:
            result = online_app.read_value(VARIABLE_PATH)
            if result is not None:
                if hasattr(result, 'value'):
                    value = str(result.value)
                    if hasattr(result, 'type'):
                        var_type = str(result.type)
                else:
                    value = str(result)
            print("DEBUG: read_value returned: %s" % value)
        except Exception as e:
            print("DEBUG: read_value failed: %s" % e)
            raise

    elif hasattr(online_app, 'read'):
        try:
            result = online_app.read(VARIABLE_PATH)
            if result is not None:
                value = str(result)
            print("DEBUG: read returned: %s" % value)
        except Exception as e:
            print("DEBUG: read failed: %s" % e)
            raise

    else:
        raise TypeError("Online application does not support read_value() or read().")

    print("Variable: %s" % VARIABLE_PATH)
    print("Value: %s" % value)
    print("Type: %s" % var_type)
    print("Application: %s" % app_name)
    print("SCRIPT_SUCCESS: Variable read successfully.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error reading variable '%s' in project %s: %s\n%s" % (VARIABLE_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
