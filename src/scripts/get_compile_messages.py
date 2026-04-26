import sys, scriptengine as script_engine, os, traceback, json


def _coerce_int(v):
    """IronPython 2.7's json.dumps cannot serialize System.Int64-backed
    `long` values, which is what CODESYS's compile-message objects expose
    as line_number / position. Coerce to native int."""
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError, OverflowError):
        return None


def _coerce_str(v):
    """Force str() on CLR-typed fields (System.Uri etc.)."""
    if v is None:
        return None
    try:
        return str(v)
    except Exception:
        return None


def _build_message_entry(msg):
    entry = {}
    if hasattr(msg, 'severity'):
        try:
            sev = str(msg.severity).lower()
        except Exception:
            sev = 'unknown'
        if 'error' in sev:
            entry['severity'] = 'error'
        elif 'warning' in sev:
            entry['severity'] = 'warning'
        elif 'info' in sev:
            entry['severity'] = 'info'
        else:
            entry['severity'] = sev
    else:
        entry['severity'] = 'unknown'
    text = None
    for attr in ('text', 'message'):
        if hasattr(msg, attr):
            text = _coerce_str(getattr(msg, attr))
            if text is not None:
                break
    if text is None:
        text = _coerce_str(msg)
    entry['text'] = text
    if hasattr(msg, 'object_name'):
        entry['object'] = _coerce_str(msg.object_name)
    elif hasattr(msg, 'source'):
        entry['object'] = _coerce_str(msg.source)
    if hasattr(msg, 'line_number'):
        entry['line'] = _coerce_int(msg.line_number)
    elif hasattr(msg, 'position'):
        entry['line'] = _coerce_int(msg.position)
    return entry


try:
    print("DEBUG: get_compile_messages script: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_name = os.path.basename(PROJECT_FILE_PATH)
    target_app = None
    app_name = "N/A"

    # Try getting active application first
    try:
        target_app = primary_project.active_application
        if target_app:
            app_name = getattr(target_app, 'get_name', lambda: "Unnamed App")()
    except Exception as active_err:
        print("WARN: Could not get active application: %s" % active_err)

    # If no active app, search for the first one
    if not target_app:
        try:
            all_children = primary_project.get_children(True)
            for child in all_children:
                if hasattr(child, 'is_application') and child.is_application:
                    target_app = child
                    app_name = getattr(child, 'get_name', lambda: "Unnamed App")()
                    break
        except Exception as find_err:
            print("WARN: Error finding application object: %s" % find_err)

    if not target_app:
        raise RuntimeError("No application found in project '%s'" % project_name)

    # Extract compiler messages using multiple API patterns
    messages = []
    messages_found = False

    # Pattern 1: target_app.get_message_objects()
    if hasattr(target_app, 'get_message_objects'):
        try:
            msg_objects = target_app.get_message_objects()
            if msg_objects is not None:
                messages_found = True
                for msg in msg_objects:
                    messages.append(_build_message_entry(msg))
                print("DEBUG: Got %d messages from app.get_message_objects()" % len(messages))
        except Exception as e:
            print("DEBUG: app.get_message_objects() failed: %s" % e)

    # Pattern 2: script_engine.system.get_message_objects()
    if not messages_found and hasattr(script_engine, 'system'):
        se_sys = script_engine.system
        if hasattr(se_sys, 'get_message_objects'):
            try:
                msg_objects = se_sys.get_message_objects()
                if msg_objects is not None:
                    messages_found = True
                    for msg in msg_objects:
                        messages.append(_build_message_entry(msg))
                    print("DEBUG: Got %d messages from system.get_message_objects()" % len(messages))
            except Exception as e:
                print("DEBUG: system.get_message_objects() failed: %s" % e)

    # Pattern 3: script_engine.system.get_messages() (older API)
    if not messages_found and hasattr(script_engine, 'system'):
        se_sys = script_engine.system
        if hasattr(se_sys, 'get_messages'):
            try:
                msg_objects = se_sys.get_messages()
                if msg_objects is not None:
                    messages_found = True
                    for msg in msg_objects:
                        messages.append(_build_message_entry(msg))
                    print("DEBUG: Got %d messages from system.get_messages()" % len(messages))
            except Exception as e:
                print("DEBUG: system.get_messages() failed: %s" % e)

    try:
        messages_json = json.dumps(messages)
    except TypeError as je:
        print("WARN: json.dumps raised %s -- retrying with default=str fallback" % je)
        messages_json = json.dumps(messages, default=lambda o: str(o))
    print("### COMPILE_MESSAGES_START ###")
    print(messages_json)
    print("### COMPILE_MESSAGES_END ###")
    print("Messages Found: %s" % messages_found)
    print("Message Count: %d" % len(messages))
    print("SCRIPT_SUCCESS: Compile messages retrieved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error getting compile messages for project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
