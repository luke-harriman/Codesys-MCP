import sys, scriptengine as script_engine, os, traceback, json


def _coerce_int(v):
    """IronPython 2.7's json.dumps cannot serialize System.Int64-backed
    `long` values, which is what CODESYS's compile-message objects expose
    as line_number / position. Coerce to native int. Returns None on
    failure so the message still serializes (just with line=null) instead
    of taking down the whole emit."""
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError, OverflowError):
        return None


def _coerce_str(v):
    """Some message fields come back as System.Uri / System.IO.FileInfo /
    similar CLR objects whose default __str__ json.dumps refuses. Force a
    str() so the value is always serializable."""
    if v is None:
        return None
    try:
        return str(v)
    except Exception:
        return None


def _build_message_entry(msg):
    """Extract a JSON-serializable dict from a single compile-message object.
    Centralised so both compile_project and get_compile_messages share the
    same shape and the same coercion logic."""
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
    print("DEBUG: compile_project script: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_name = os.path.basename(PROJECT_FILE_PATH)
    target_app = None
    app_name = "N/A"

    # Try getting active application first
    try:
        target_app = primary_project.active_application
        if target_app:
            app_name = getattr(target_app, 'get_name', lambda: "Unnamed App (Active)")()
            print("DEBUG: Found active application: %s" % app_name)
    except Exception as active_err:
        print("WARN: Could not get active application: %s. Searching..." % active_err)

    # If no active app, search for the first one
    if not target_app:
        print("DEBUG: Searching for first compilable application...")
        apps = []
        try:
             # Search recursively through all project objects
             all_children = primary_project.get_children(True)
             for child in all_children:
                  # Check using the marker property and if build method exists
                  if hasattr(child, 'is_application') and child.is_application and hasattr(child, 'build'):
                       app_name_found = getattr(child, 'get_name', lambda: "Unnamed App")()
                       print("DEBUG: Found potential application object: %s" % app_name_found)
                       apps.append(child)
                       break # Take the first one found
        except Exception as find_err: print("WARN: Error finding application object: %s" % find_err)

        if not apps: raise RuntimeError("No compilable application found in project '%s'" % project_name)
        target_app = apps[0]
        app_name = getattr(target_app, 'get_name', lambda: "Unnamed App (First Found)")()
        print("WARN: Compiling first found application: %s" % app_name)

    print("DEBUG: Calling build() on app '%s'..." % app_name)
    if not hasattr(target_app, 'build'):
         raise TypeError("Selected object '%s' is not an application or doesn't support build()." % app_name)

    # Execute the build
    target_app.build();
    print("DEBUG: Build command executed for application '%s'." % app_name)

    # --- Extract compiler messages ---
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

    # Defensive json.dumps: if a stray field still slips past the coercion
    # helpers, retry with a default=str fallback so a single odd type
    # doesn't kill the whole emit. The default param converts unknown
    # objects via str() instead of raising TypeError.
    try:
        messages_json = json.dumps(messages)
    except TypeError as je:
        print("WARN: json.dumps raised %s -- retrying with default=str fallback" % je)
        messages_json = json.dumps(messages, default=lambda o: str(o))
    print("### COMPILE_MESSAGES_START ###")
    print(messages_json)
    print("### COMPILE_MESSAGES_END ###")

    print("Compile Initiated For Application: %s" % app_name)
    print("In Project: %s" % project_name)
    print("Messages Found: %s" % messages_found)
    print("Message Count: %d" % len(messages))
    print("SCRIPT_SUCCESS: Application compilation initiated.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error initiating compilation for project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
