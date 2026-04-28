import sys, scriptengine as script_engine, os, traceback, json

# set_symbol_access: set the configured_access for a single variable
# inside a configured signature.
#
# RTFM (Stubs/scriptengine/ScriptSymbolConfigObject.pyi):
#   ScriptSymbolConfigVariable has:
#     configured_access  (settable, SymbolAccess)
#     maximal_access     (read-only -- the upper bound)
#     effective_access   (read-only -- post-clamp)
#   ScriptSymbolConfigSignatureCollection has:
#     find(name, library_id=None) -> ScriptSymbolConfigSignature | None
#     __getitem__(name)           -> ScriptSymbolConfigSignature
#
# The SymbolAccess enum itself is not declared in the local stub (it
# lives in the C# side); per CODESYS scripting docs the values are:
#   None=0, ReadOnly=1, WriteOnly=2, ReadWrite=3
# We accept the string and probe the enum at runtime so a divergent SP
# surfaces a clear error.

SIGNATURE_FQN = r"{SIGNATURE_FQN}"
VARIABLE_NAME = r"{VARIABLE_NAME}"
ACCESS = "{ACCESS}"  # 'None' / 'ReadOnly' / 'WriteOnly' / 'ReadWrite'
LIBRARY_ID = r"{LIBRARY_ID}"  # optional, may be empty
ENSURE_CONFIGURED = "{ENSURE_CONFIGURED}" == '1'


def _resolve_access(access_str):
    """Try several routes to get a SymbolAccess enum value for the given
    string. Falls back to integer literal mapping if the enum isn't
    importable on this SP."""
    name = (access_str or '').strip()
    if name == '':
        raise ValueError("access string is empty")
    name_lower = name.lower()
    int_map = {
        'none': 0,
        'readonly': 1,
        'writeonly': 2,
        'readwrite': 3,
    }
    # Try the enum class first.
    enum_cls = None
    try:
        from scriptengine import SymbolAccess as enum_cls  # noqa
    except Exception:
        pass
    if enum_cls is not None:
        for m in dir(enum_cls):
            if m.startswith('_'):
                continue
            if m.lower() == name_lower:
                try:
                    return getattr(enum_cls, m)
                except Exception:
                    pass
    # Fall back to int.
    if name_lower in int_map:
        return int_map[name_lower]
    raise ValueError(
        "Unknown access value '%s'. Allowed: None, ReadOnly, WriteOnly, ReadWrite" % access_str)


def _find_signature_in(collection, fqn, library_id=None):
    """Locate a signature by full-qualified name. Tries the documented
    .find(name, library_id) first, then __getitem__, then a manual scan."""
    if collection is None:
        return None
    if hasattr(collection, 'find'):
        try:
            if library_id:
                hit = collection.find(fqn, library_id)
            else:
                hit = collection.find(fqn)
            if hit is not None:
                return hit
        except Exception as e:
            print("DEBUG: collection.find raised: %s" % e)
    try:
        return collection[fqn]
    except Exception:
        pass
    # Manual scan as a final fallback.
    try:
        for s in collection:
            try:
                s_fqn = s.full_qualified_name
            except Exception:
                s_fqn = None
            if s_fqn == fqn:
                return s
    except Exception:
        pass
    return None


def _find_variable(sig, var_name):
    if sig is None:
        return None
    try:
        for v in sig.variables:
            try:
                vn = v.name
            except Exception:
                vn = None
            if vn == var_name:
                return v
    except Exception as e:
        print("DEBUG: iterating sig.variables failed: %s" % e)
    return None


try:
    print("DEBUG: set_symbol_access: Project='%s' fqn='%s' var='%s' access='%s' lib='%s'" % (
        PROJECT_FILE_PATH, SIGNATURE_FQN, VARIABLE_NAME, ACCESS, LIBRARY_ID))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    sc_obj = ensure_symbol_config(primary_project)
    sc_path = symbol_config_path(primary_project, sc_obj)

    requested_access = _resolve_access(ACCESS)
    print("DEBUG: requested_access resolved to %r" % requested_access)

    # Try the configured set first (these are the variables already
    # selected for export). Fall back to the all-signatures view if the
    # variable isn't yet configured -- setting access on a not-yet-configured
    # variable is the standard way to "tick" it.
    sig = None
    library_id = LIBRARY_ID if LIBRARY_ID else None
    try:
        configured = sc_obj.get_only_configured_signatures()
        sig = _find_signature_in(configured, SIGNATURE_FQN, library_id)
    except Exception as e:
        print("DEBUG: get_only_configured_signatures failed: %s" % e)
    found_in_configured = sig is not None
    if sig is None:
        try:
            all_sigs = sc_obj.get_all_signatures(False)
            sig = _find_signature_in(all_sigs, SIGNATURE_FQN, library_id)
        except Exception as e:
            print("DEBUG: get_all_signatures(False) failed: %s" % e)
    if sig is None:
        try:
            all_sigs = sc_obj.get_all_signatures(True)
            sig = _find_signature_in(all_sigs, SIGNATURE_FQN, library_id)
        except Exception as e:
            print("DEBUG: get_all_signatures(True) failed: %s" % e)
    if sig is None:
        raise RuntimeError(
            "Signature '%s' not found (library_id=%s). "
            "Use list_all_signatures (compile=true) to see what's available."
            % (SIGNATURE_FQN, LIBRARY_ID or '<none>'))

    var = _find_variable(sig, VARIABLE_NAME)
    if var is None:
        try:
            var_names = [getattr(v, 'name', '?') for v in sig.variables]
        except Exception:
            var_names = []
        raise RuntimeError(
            "Variable '%s' not found in signature '%s'. Available variables: %s"
            % (VARIABLE_NAME, SIGNATURE_FQN, ', '.join(var_names) or '<none>'))

    # Maximal-access clamp check.
    max_access = None
    try:
        max_access = var.maximal_access
    except Exception:
        pass
    print("DEBUG: maximal_access=%s, configured_access(before)=%s" % (
        max_access, getattr(var, 'configured_access', '?')))

    var.configured_access = requested_access

    # Verify post-set state.
    try:
        post = var.configured_access
    except Exception:
        post = None
    try:
        eff = var.effective_access
    except Exception:
        eff = None

    primary_project.save()

    result = {
        'project': project_basename,
        'symbol_config_path': sc_path,
        'signature_fqn': SIGNATURE_FQN,
        'variable_name': VARIABLE_NAME,
        'found_in_configured': found_in_configured,
        'requested_access': str(requested_access),
        'configured_access_after': str(post) if post is not None else None,
        'effective_access': str(eff) if eff is not None else None,
        'maximal_access': str(max_access) if max_access is not None else None,
    }
    print("### SYMBOL_ACCESS_SET_START ###")
    print(json.dumps(result))
    print("### SYMBOL_ACCESS_SET_END ###")
    print("Set %s.%s.configured_access = %s (effective=%s)" % (
        SIGNATURE_FQN, VARIABLE_NAME, post, eff))
    print("SCRIPT_SUCCESS: set_symbol_access completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in set_symbol_access for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
