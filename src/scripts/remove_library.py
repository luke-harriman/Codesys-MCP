import sys, scriptengine as script_engine, os, traceback

# RTFM (helpme-codesys.com "ScriptLibManObject" + local SP22 stub
# Stubs/scriptengine/ScriptLibManObject.pyi):
#
# - ScriptLibManObject.remove_library(name: str) removes a reference by
#   name. The name argument accepts either the bare library name (e.g.
#   "Standard") or the fully-qualified "Name, Version (Company)" form.
# - lm.references gives back ScriptLibraryReference items. Placeholder
#   refs have .name == "#<Name>"; managed refs have .name ==
#   "<Name>, <Version> (<Company>)".
# - The project-level libman is obtained the same way add_library.py does:
#   container.has_library_manager / container.get_library_manager(), then
#   first-level-child walk, then find("Library Manager") fallback.

LIBRARY_NAME = "{LIBRARY_NAME}"
LIBRARY_FQN_OR_NAME = "{LIBRARY_FQN_OR_NAME}"


def _ref_name_matches(ref_name, target):
    """Match a reference name against a bare or fully-qualified target.
    A managed ref shows up as 'Name, Version (Company)'; a placeholder
    shows up as '#Name'. Either target form is accepted."""
    if ref_name is None:
        return False
    if ref_name == target:
        return True
    if ref_name == ('#' + target):
        return True
    # Managed: leading 'Name, ...'
    if ref_name.startswith(target + ','):
        return True
    return False


def _find_reference(lm, target):
    """Walk lm.references and return the first entry whose name matches
    target (bare or fully-qualified), or None."""
    try:
        refs = lm.references
    except Exception as e:
        print("DEBUG: lm.references unavailable: %s" % e)
        return None
    if refs is None:
        return None
    for r in refs:
        try:
            rn = getattr(r, 'name', None)
        except Exception:
            rn = None
        if _ref_name_matches(rn, target):
            return r
    return None


try:
    print("DEBUG: remove_library script: Library='%s', FQN='%s', Project='%s'"
          % (LIBRARY_NAME, LIBRARY_FQN_OR_NAME, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not LIBRARY_NAME:
        raise ValueError("Library name empty.")

    project_name = os.path.basename(PROJECT_FILE_PATH)

    # Locate the project's Library Manager. Mirror the discovery logic from
    # add_library.py: container API first, then child walk, then name search.
    lib_manager = None
    try:
        if hasattr(primary_project, 'has_library_manager') and primary_project.has_library_manager:
            lib_manager = primary_project.get_library_manager()
            print("DEBUG: Found Library Manager via project.get_library_manager()")
    except Exception as e:
        print("DEBUG: project.get_library_manager() failed: %s" % e)

    if not lib_manager:
        try:
            for child in primary_project.get_children(False):
                try:
                    if getattr(child, 'has_library_manager', False):
                        lib_manager = child.get_library_manager()
                        if lib_manager is not None:
                            print("DEBUG: Found Library Manager under '%s'" % child.get_name())
                            break
                except Exception:
                    pass
        except Exception as e:
            print("DEBUG: walking children for libman failed: %s" % e)

    if not lib_manager:
        try:
            found_list = primary_project.find("Library Manager", True)
            if found_list:
                lib_manager = found_list[0]
                print("DEBUG: Found Library Manager via find('Library Manager') fallback")
        except Exception as e:
            print("DEBUG: find('Library Manager') failed: %s" % e)

    if not lib_manager:
        raise RuntimeError("Library Manager not found in project '%s'." % project_name)

    print("DEBUG: Library Manager found: %s" % getattr(lib_manager, 'get_name', lambda: '?')())

    # Pre-check: is the library actually referenced? Walk lm.references for
    # either the bare name or the fully-qualified name.
    # Check bare LIBRARY_NAME first; fall back to LIBRARY_FQN_OR_NAME if
    # it differs (caller may pass the "Name, Version (Company)" form).
    match_target = LIBRARY_NAME
    existing_ref = _find_reference(lib_manager, match_target)
    if existing_ref is None and LIBRARY_FQN_OR_NAME and LIBRARY_FQN_OR_NAME != LIBRARY_NAME:
        match_target = LIBRARY_FQN_OR_NAME
        existing_ref = _find_reference(lib_manager, match_target)

    if existing_ref is None:
        msg = ("Library '%s' is not referenced in this project. Nothing to remove."
               % LIBRARY_NAME)
        print(msg)
        print("Library Not Present: %s" % LIBRARY_NAME)
        print("Project: %s" % project_name)
        print("SCRIPT_SUCCESS: %s" % msg)
        sys.exit(0)

    existing_name = getattr(existing_ref, 'name', '?')
    is_ph = bool(getattr(existing_ref, 'is_placeholder', False))
    kind = "placeholder" if is_ph else "managed"
    print("DEBUG: Found reference to remove -- name=%r, kind=%s" % (existing_name, kind))

    # Verify remove_library is exposed (may not exist on very old SPs).
    if not hasattr(lib_manager, 'remove_library'):
        raise RuntimeError(
            "lm.remove_library() is not available on this CODESYS SP. "
            "Cannot remove library '%s' via script." % LIBRARY_NAME)

    # Remove using the name the script API already knows about (the name
    # from lm.references, which is always the form remove_library accepts).
    lib_manager.remove_library(existing_name)
    print("DEBUG: remove_library('%s') returned without exception." % existing_name)

    # Verify removal succeeded by re-checking lm.references.
    still_present = _find_reference(lib_manager, LIBRARY_NAME)
    if still_present is not None:
        raise RuntimeError(
            "remove_library('%s') returned without error but the reference "
            "is still present in lm.references. Project NOT saved." % existing_name)

    # Save only after confirmed removal.
    try:
        primary_project.save()
        print("DEBUG: Project saved successfully after removing library.")
    except Exception as save_err:
        detailed_error = traceback.format_exc()
        error_message = ("Error saving project after removing library '%s': %s\n%s"
                         % (LIBRARY_NAME, save_err, detailed_error))
        print(error_message)
        print("SCRIPT_ERROR: %s" % error_message)
        sys.exit(1)

    print("Library Removed: %s" % LIBRARY_NAME)
    print("Project: %s" % project_name)
    print("SCRIPT_SUCCESS: Library '%s' (%s, ref-name=%r) removed from project '%s'."
          % (LIBRARY_NAME, kind, existing_name, project_name))
    sys.exit(0)

except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = ("Error removing library '%s' from project '%s': %s\n%s"
                     % (LIBRARY_NAME, PROJECT_FILE_PATH, e, detailed_error))
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
