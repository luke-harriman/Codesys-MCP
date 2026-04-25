import sys, scriptengine as script_engine, os, traceback

LOGIN_WAIT_SECONDS = {LOGIN_WAIT_SECONDS}

try:
    print("DEBUG: connect_to_device script: Project='%s', LoginWaitSec=%d" % (
        PROJECT_FILE_PATH, LOGIN_WAIT_SECONDS))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    online_app, target_app = ensure_online_connection(primary_project)
    app_name = getattr(target_app, 'get_name', lambda: "Unknown")()

    # Login to the device. The login() signature shifted across SPs:
    #   - Older: login() with no args, or login(OnlineChangeOption.TryOnlineChange)
    #   - SP21+/SP22: login(OnlineChangeOption, bool) -- two required positional
    #     args, with several enum members renamed (TryOnlineChange removed).
    # Probe what's available, then try a sequence of plausible call shapes.
    print("DEBUG: Calling login() on online application...")
    if not hasattr(online_app, 'login'):
        raise TypeError("Online application does not support login().")

    # Discover OnlineChangeOption members defensively. Different SPs expose
    # different names. Build candidate enum values in priority order.
    enum_candidates = []
    if hasattr(script_engine, 'OnlineChangeOption'):
        oc = script_engine.OnlineChangeOption
        oc_members = sorted([m for m in dir(oc) if not m.startswith('_')])
        print("DEBUG: OnlineChangeOption members: %s" % oc_members)
        # Priority order: prefer "try"-ish (no-download), then "download" variants
        for preferred in ('Try', 'TryOnlineChange', 'OnlineChangeOnly',
                          'WithDownload', 'ForceDownload', 'None_', 'None'):
            if preferred in oc_members:
                try:
                    enum_candidates.append((preferred, getattr(oc, preferred)))
                except Exception:
                    pass
        # Append all remaining members as fallbacks
        for m in oc_members:
            if m not in [n for n, _ in enum_candidates]:
                try:
                    enum_candidates.append((m, getattr(oc, m)))
                except Exception:
                    pass

    # Build call-shape candidates for login(): a list of (description, args-tuple).
    call_shapes = []
    for nm, val in enum_candidates:
        call_shapes.append(("login(%s, False)" % nm, (val, False)))
        call_shapes.append(("login(%s, True)" % nm, (val, True)))
        call_shapes.append(("login(%s)" % nm, (val,)))
    # Also try plain bools and no-arg as fall-backs (for very old SPs)
    call_shapes.append(("login(False)", (False,)))
    call_shapes.append(("login(True)", (True,)))
    call_shapes.append(("login()", ()))

    last_err = None
    logged_in = False
    for desc, args in call_shapes:
        try:
            online_app.login(*args)
            print("DEBUG: %s succeeded" % desc)
            logged_in = True
            break
        except Exception as e:
            last_err = e
            # Print only the short error to keep log readable
            print("DEBUG: %s failed: %s: %s" % (desc, type(e).__name__, e))

    if not logged_in:
        raise RuntimeError("All login() call shapes failed. Last error: %s" % last_err)
    print("DEBUG: login() returned. Waiting up to %d seconds for state to stabilise" % LOGIN_WAIT_SECONDS)
    print("DEBUG: (CODESYS may pop a credential dialog -- enter device password if prompted.)")

    # Poll application_state. CODESYS shows a modal credential dialog the
    # first time you log into a device with a password; login() may return
    # immediately while the dialog is still up, leaving the application in
    # an undefined state. Pump the message loop via system.delay() so the
    # dialog renders and the user has time to fill it in. Exit early once
    # the state lands on a recognisable terminal value.
    STABLE_STATES = ('run', 'stop', 'connected', 'halt', 'breakpoint')
    state = "unknown"
    for elapsed in range(LOGIN_WAIT_SECONDS):
        if hasattr(online_app, 'application_state'):
            try:
                state = str(online_app.application_state)
            except Exception:
                pass
        if state.lower() in STABLE_STATES:
            print("DEBUG: state stabilised at '%s' after %ds" % (state, elapsed))
            break
        try:
            script_engine.system.delay(1000)
        except Exception:
            pass

    print("Connected to device for application: %s" % app_name)
    print("Application State: %s" % state)
    print("SCRIPT_SUCCESS: Connected to device successfully.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error connecting to device for project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
