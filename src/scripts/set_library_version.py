import sys, scriptengine as script_engine, os, traceback

LIBRARY_NAME = "{LIBRARY_NAME}"
TARGET_VERSION = "{TARGET_VERSION}"

try:
    print("DEBUG: set_library_version: Library='%s', TargetVersion='%s', Project='%s'" % (
        LIBRARY_NAME, TARGET_VERSION, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not LIBRARY_NAME:
        raise ValueError("Library name is empty.")
    if not TARGET_VERSION:
        raise ValueError("Target version is empty.")

    # Locate Library Manager.
    lib_manager = None
    try:
        found = primary_project.find("Library Manager", True)
        if found:
            lib_manager = found[0]
    except Exception as e:
        print("DEBUG: find('Library Manager') failed: %s" % e)
    if lib_manager is None:
        try:
            for child in primary_project.get_children(True):
                nm = getattr(child, 'get_name', lambda: '')()
                if 'library' in nm.lower() and 'manager' in nm.lower():
                    lib_manager = child
                    break
        except Exception as e:
            print("DEBUG: child search for Library Manager failed: %s" % e)
    if lib_manager is None:
        raise RuntimeError("Library Manager not found in project.")

    # Enumerate refs.
    refs = []
    for method_name in ('get_all_libraries', 'get_libraries', 'get_references', 'libraries', 'references'):
        attr = getattr(lib_manager, method_name, None)
        if attr is None:
            continue
        try:
            value = attr() if callable(attr) else attr
            refs = list(value)
            break
        except Exception:
            continue
    if not refs:
        try:
            refs = list(lib_manager)
        except Exception:
            pass
    if not refs:
        raise RuntimeError("Could not enumerate library references via any known API.")

    def _attr(obj, name, default=''):
        v = getattr(obj, name, None)
        if v is None:
            return default
        try:
            return v() if callable(v) else v
        except Exception:
            return default

    # Match by name (case-insensitive). Accept either bare name match or
    # 'namespace.name' convention.
    target_lower = LIBRARY_NAME.lower()
    matches = []
    for ref in refs:
        nm = _attr(ref, 'get_name', '')
        if not nm:
            nm = _attr(ref, 'name', '')
        ns = _attr(ref, 'get_namespace', '')
        if not ns:
            ns = _attr(ref, 'namespace', '')
        full = ("%s.%s" % (ns, nm)) if ns else nm
        if nm.lower() == target_lower or full.lower() == target_lower:
            matches.append((ref, nm, ns))

    if not matches:
        names_seen = []
        for ref in refs:
            n = _attr(ref, 'get_name', '?')
            if not n:
                n = _attr(ref, 'name', '?')
            names_seen.append(n)
        raise ValueError(
            "No library reference matches '%s'. Found: %s"
            % (LIBRARY_NAME, ", ".join(names_seen) or "(none)")
        )

    if len(matches) > 1:
        details = ["%s.%s" % (ns or "", nm) for _, nm, ns in matches]
        raise ValueError(
            "Library name '%s' is ambiguous; matches %d references: %s. "
            "Use 'Namespace.Name' to disambiguate."
            % (LIBRARY_NAME, len(matches), ", ".join(details))
        )

    ref, name, namespace = matches[0]
    old_version = str(_attr(ref, 'get_version', '?'))
    if old_version == '?':
        old_version = str(_attr(ref, 'version', '?'))
    print("DEBUG: matched %s.%s @ %s" % (namespace, name, old_version))

    # Try in-place setters.
    updated = False
    last_err = None
    for method_name in ('set_version', 'update_to_version', 'update', 'set_resolution'):
        if not hasattr(ref, method_name):
            continue
        try:
            getattr(ref, method_name)(TARGET_VERSION)
            updated = True
            print("DEBUG: %s('%s') OK" % (method_name, TARGET_VERSION))
            break
        except Exception as e:
            last_err = e
            print("DEBUG: %s('%s') failed: %s" % (method_name, TARGET_VERSION, e))

    # Fallback: remove + re-add at the new version.
    if not updated:
        try:
            if hasattr(lib_manager, 'remove_library'):
                lib_manager.remove_library(ref)
            elif hasattr(lib_manager, 'remove'):
                lib_manager.remove(ref)
            else:
                raise RuntimeError("no remove_library / remove method")
            for add_name in ('add_placeholder_library', 'add_library', 'insert_library'):
                if not hasattr(lib_manager, add_name):
                    continue
                try:
                    getattr(lib_manager, add_name)(name, TARGET_VERSION)
                    updated = True
                    break
                except TypeError:
                    try:
                        getattr(lib_manager, add_name)(name)
                        updated = True
                        break
                    except Exception as e2:
                        last_err = e2
                except Exception as e2:
                    last_err = e2
        except Exception as e:
            last_err = e
            print("DEBUG: remove+add failed for %s: %s" % (name, e))

    if not updated:
        raise RuntimeError("Could not set version. Last error: %s" % last_err)

    try:
        primary_project.save()
    except Exception as save_err:
        print("ERROR: save failed: %s" % save_err)
        print("SCRIPT_ERROR: save failed after setting version: %s" % save_err)
        sys.exit(1)

    print("Library version set:")
    print("  %s.%s : %s -> %s" % (namespace, name, old_version, TARGET_VERSION))
    print("SCRIPT_SUCCESS: Library version updated.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error setting library version for '%s' in '%s': %s\n%s" % (
        LIBRARY_NAME, PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
