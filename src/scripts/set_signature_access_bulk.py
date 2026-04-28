import sys, scriptengine as script_engine, os, traceback, json

# set_signature_access_bulk: set configured_access for every variable in
# a signature to the same value.
#
# RTFM: see set_symbol_access. Same lookup pattern; the difference is
# we walk every variable inside the signature once we've found it.

SIGNATURE_FQN = r"{SIGNATURE_FQN}"
ACCESS = "{ACCESS}"
LIBRARY_ID = r"{LIBRARY_ID}"


def _resolve_access(access_str):
    name = (access_str or '').strip()
    if name == '':
        raise ValueError("access string is empty")
    name_lower = name.lower()
    int_map = {'none': 0, 'readonly': 1, 'writeonly': 2, 'readwrite': 3}
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
    if name_lower in int_map:
        return int_map[name_lower]
    raise ValueError(
        "Unknown access value '%s'. Allowed: None, ReadOnly, WriteOnly, ReadWrite" % access_str)


def _find_signature_in(collection, fqn, library_id=None):
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
    try:
        for s in collection:
            try:
                if s.full_qualified_name == fqn:
                    return s
            except Exception:
                continue
    except Exception:
        pass
    return None


try:
    print("DEBUG: set_signature_access_bulk: fqn='%s' access='%s' lib='%s'" % (
        SIGNATURE_FQN, ACCESS, LIBRARY_ID))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    sc_obj = ensure_symbol_config(primary_project)
    sc_path = symbol_config_path(primary_project, sc_obj)

    requested_access = _resolve_access(ACCESS)
    print("DEBUG: requested_access resolved to %r" % requested_access)

    library_id = LIBRARY_ID if LIBRARY_ID else None

    sig = None
    try:
        configured = sc_obj.get_only_configured_signatures()
        sig = _find_signature_in(configured, SIGNATURE_FQN, library_id)
    except Exception:
        pass
    if sig is None:
        try:
            all_sigs = sc_obj.get_all_signatures(False)
            sig = _find_signature_in(all_sigs, SIGNATURE_FQN, library_id)
        except Exception:
            pass
    if sig is None:
        try:
            all_sigs = sc_obj.get_all_signatures(True)
            sig = _find_signature_in(all_sigs, SIGNATURE_FQN, library_id)
        except Exception:
            pass
    if sig is None:
        raise RuntimeError(
            "Signature '%s' not found (library_id=%s)." % (SIGNATURE_FQN, LIBRARY_ID or '<none>'))

    changed = []
    skipped = []
    try:
        for v in sig.variables:
            try:
                v_name = v.name
            except Exception:
                v_name = '?'
            try:
                v.configured_access = requested_access
                changed.append(v_name)
            except Exception as e:
                skipped.append({'name': v_name, 'reason': str(e)})
    except Exception as e:
        print("DEBUG: variable iteration failed: %s" % e)

    if changed:
        primary_project.save()

    result = {
        'project': project_basename,
        'symbol_config_path': sc_path,
        'signature_fqn': SIGNATURE_FQN,
        'requested_access': str(requested_access),
        'changed': changed,
        'changed_count': len(changed),
        'skipped': skipped,
        'skipped_count': len(skipped),
    }
    print("### SYMBOL_ACCESS_BULK_START ###")
    print(json.dumps(result))
    print("### SYMBOL_ACCESS_BULK_END ###")
    print("Bulk set %s/%d variables of '%s' to %s" % (
        len(changed), len(changed) + len(skipped), SIGNATURE_FQN, requested_access))
    print("SCRIPT_SUCCESS: set_signature_access_bulk completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in set_signature_access_bulk for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
