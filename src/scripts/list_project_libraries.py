import sys, scriptengine as script_engine, os, traceback, json

# RTFM (helpme-codesys.com + local SP22 stub
# Stubs/scriptengine/ScriptLibManObject.pyi):
#
# - ScriptLibManObjectContainer is a marker interface added to BOTH the
#   project AND every Application object. Two key members:
#       has_library_manager  -- @property (NOT a method) returning bool
#       get_library_manager()  -- method, returns the LibMan ScriptObject
# - ScriptLibManObject (the LibMan itself) exposes:
#       .references  -- @property, ScriptLibraryReferences (list-like) of
#                       ScriptLibraryReference. Best for structured data.
#       get_libraries(recursive=False)  -- list[str] of library names.
# - ScriptLibManObjectMarker.is_libman is the universal "is this a libman?"
#   property added to every ScriptObject, useful as a fallback when walking
#   the project tree.
#
# The previous version of this script searched the tree for an object whose
# NAME matched "Library Manager" (via find() / get_children name probe). That
# never worked because the libman's actual name is generated, not literal.
# Fixed by walking every container with has_library_manager and pulling
# references via lm.references.


def find_libman_containers(node, depth=0, max_depth=8):
    """Walk the project tree and yield every node where has_library_manager
    is True. Depth-limited so a malformed project tree can't loop us."""
    out = []
    if depth > max_depth:
        return out
    try:
        # has_library_manager is a property, not a method -- accessing it
        # on a non-container ScriptObject can raise, so guard.
        if hasattr(node, 'has_library_manager'):
            try:
                hlm = node.has_library_manager
            except Exception:
                hlm = False
            if hlm:
                out.append(node)
    except Exception:
        pass
    try:
        children = node.get_children(False)
    except Exception:
        children = []
    for child in children:
        out.extend(find_libman_containers(child, depth + 1, max_depth))
    return out


def safe_get(obj, attr, default=None):
    """getattr that swallows access exceptions (some properties throw on
    placeholders / unmanaged refs depending on the SP). Returns default
    if missing or raising; calls callables."""
    try:
        if not hasattr(obj, attr):
            return default
        v = getattr(obj, attr)
        return v() if callable(v) else v
    except Exception:
        return default


def reference_to_dict(ref):
    """Capture as much structured info as the SP exposes, defensively."""
    entry = {}
    for prop in ('id', 'name', 'namespace', 'is_placeholder', 'is_managed',
                 'system_library', 'qualified_only', 'optional',
                 'placeholder_name', 'effective_resolution',
                 'default_resolution', 'is_redirected', 'resolution_info'):
        v = safe_get(ref, prop)
        if v is not None:
            try:
                entry[prop] = str(v) if not isinstance(v, bool) else v
            except Exception:
                pass
    return entry


try:
    print("DEBUG: list_project_libraries: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    containers = find_libman_containers(primary_project)
    print("DEBUG: %d libman container(s) found in tree." % len(containers))

    result = {
        'project': project_basename,
        'containers': [],
        'total_references': 0,
    }

    for container in containers:
        container_name = safe_get(container, 'get_name', '?')
        try:
            lm = container.get_library_manager()
        except Exception as e:
            print("DEBUG: get_library_manager() failed on '%s': %s" % (container_name, e))
            continue
        if lm is None:
            print("DEBUG: container '%s' returned None for get_library_manager()." % container_name)
            continue
        lm_name = safe_get(lm, 'get_name', '?')

        # Try the structured .references property first; fall back to the
        # name-only get_libraries() method.
        refs_struct = []
        ref_iter = None
        try:
            ref_iter = lm.references
        except Exception as e:
            print("DEBUG: lm.references failed on '%s': %s" % (lm_name, e))

        if ref_iter is not None:
            try:
                for r in ref_iter:
                    refs_struct.append(reference_to_dict(r))
            except Exception as e:
                print("DEBUG: iterating lm.references on '%s' failed: %s" % (lm_name, e))

        # Fallback: name-only enumeration via get_libraries(recursive=False).
        if not refs_struct and hasattr(lm, 'get_libraries'):
            try:
                names = lm.get_libraries(False)
                for n in names:
                    refs_struct.append({'name': str(n), 'source': 'get_libraries-fallback'})
                print("DEBUG: get_libraries fallback returned %d name(s) on '%s'" % (len(names), lm_name))
            except Exception as e:
                print("DEBUG: get_libraries() fallback failed on '%s': %s" % (lm_name, e))

        result['containers'].append({
            'container_name': container_name,
            'libman_name': lm_name,
            'references': refs_struct,
        })
        result['total_references'] += len(refs_struct)
        print("DEBUG: container '%s' (libman '%s'): %d reference(s)" % (
            container_name, lm_name, len(refs_struct)))

    print("### LIBRARIES_START ###")
    print(json.dumps(result))
    print("### LIBRARIES_END ###")
    print("Total references across %d container(s): %d" % (
        len(result['containers']), result['total_references']))
    print("SCRIPT_SUCCESS: Project libraries listed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in list_project_libraries for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
