import sys, scriptengine as script_engine, os, traceback

APP_ACTION = "{APP_ACTION}"

try:
    print("DEBUG: start_stop_application script: Action='%s', Project='%s'" % (APP_ACTION, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not APP_ACTION: raise ValueError("Action empty.")

    action_lower = APP_ACTION.lower()
    if action_lower not in ('start', 'stop'):
        raise ValueError("Invalid action '%s'. Must be 'start' or 'stop'." % APP_ACTION)

    online_app, target_app = ensure_online_connection(primary_project)
    app_name = getattr(target_app, 'get_name', lambda: "Unknown")()
    # In headless mode each MCP call spawns a fresh CODESYS process, so the
    # login from a prior connect_to_device call is gone. ensure_logged_in
    # is idempotent in persistent mode (short-circuits via is_logged_in).
    ensure_logged_in(online_app)

    if action_lower == 'start':
        if hasattr(online_app, 'start'):
            print("DEBUG: Calling start()...")
            online_app.start()
            print("DEBUG: Application started.")
        else:
            raise TypeError("Online application does not support start().")
    else:
        if hasattr(online_app, 'stop'):
            print("DEBUG: Calling stop()...")
            online_app.stop()
            print("DEBUG: Application stopped.")
        else:
            raise TypeError("Online application does not support stop().")

    # Get state after action
    state = "unknown"
    if hasattr(online_app, 'application_state'):
        try:
            state = str(online_app.application_state)
        except Exception:
            pass

    print("Action: %s" % APP_ACTION)
    print("Application: %s" % app_name)
    print("State After: %s" % state)
    print("SCRIPT_SUCCESS: Application %s executed successfully." % action_lower)
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error executing %s for project %s: %s\n%s" % (APP_ACTION, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
