import sys, scriptengine as script_engine, os, traceback, json

# list_configured_symbols: dump only those signatures + datatypes that
# the user has actually checked / configured for export.
#
# RTFM (Stubs/scriptengine/ScriptSymbolConfigObject.pyi):
#   get_only_configured_signatures() -> ScriptSymbolConfigSignatureCollection
#   get_only_configured_datatypes()  -> ScriptSymbolConfigSignatureCollection
#
# For each configured signature/datatype we report every variable's
# access state: configured (what the user set), maximal (the upper
# bound implied by the variable kind / attributes), effective (what
# actually applies after compiler-version etc. clamping).


def _coerce_str(v):
    if v is None:
        return None
    try:
        return str(v)
    except Exception:
        return None


def _serialize_variable(var):
    out = {}
    for prop in ('name', 'type', 'comment', 'configured_access',
                 'maximal_access', 'effective_access', 'attribute_access',
                 'exported_via_attribute', 'type_library_id',
                 'full_qualified_base_type', 'alias_type'):
        try:
            v = getattr(var, prop, None)
            if v is None:
                continue
            if isinstance(v, bool):
                out[prop] = v
            else:
                out[prop] = _coerce_str(v)
        except Exception:
            pass
    return out


def _serialize_signature(sig):
    out = {}
    try:
        out['fqn'] = _coerce_str(sig.full_qualified_name)
    except Exception:
        out['fqn'] = None
    try:
        out['name'] = _coerce_str(sig.name)
    except Exception:
        out['name'] = None
    try:
        out['library_id'] = _coerce_str(sig.library_id)
    except Exception:
        out['library_id'] = None
    try:
        ns = list(sig.namespace_path) if sig.namespace_path is not None else []
        out['namespace_path'] = [_coerce_str(p) for p in ns]
    except Exception:
        out['namespace_path'] = []
    variables = []
    try:
        for v in sig.variables:
            variables.append(_serialize_variable(v))
    except Exception as e:
        print("DEBUG: iterating sig.variables failed: %s" % e)
    out['variables'] = variables
    return out


try:
    print("DEBUG: list_configured_symbols: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    sc_obj = ensure_symbol_config(primary_project)
    sc_path = symbol_config_path(primary_project, sc_obj)

    sigs_out = []
    dts_out = []
    try:
        sigs = sc_obj.get_only_configured_signatures() or []
        for s in sigs:
            sigs_out.append(_serialize_signature(s))
    except Exception as e:
        print("DEBUG: get_only_configured_signatures() failed: %s" % e)
    try:
        dts = sc_obj.get_only_configured_datatypes() or []
        for d in dts:
            dts_out.append(_serialize_signature(d))
    except Exception as e:
        print("DEBUG: get_only_configured_datatypes() failed: %s" % e)

    total_vars = sum(len(s.get('variables', [])) for s in sigs_out)
    total_dt_vars = sum(len(s.get('variables', [])) for s in dts_out)

    result = {
        'project': project_basename,
        'symbol_config_path': sc_path,
        'configured_signatures': sigs_out,
        'configured_datatypes': dts_out,
        'signature_count': len(sigs_out),
        'datatype_count': len(dts_out),
        'total_signature_variables': total_vars,
        'total_datatype_variables': total_dt_vars,
    }

    print("### SYMBOL_CONFIGURED_START ###")
    print(json.dumps(result))
    print("### SYMBOL_CONFIGURED_END ###")
    print("Symbol Configuration: %s" % sc_path)
    print("Configured signatures: %d (with %d variables exported)" % (len(sigs_out), total_vars))
    print("Configured datatypes:  %d (with %d variables exported)" % (len(dts_out), total_dt_vars))
    print("SCRIPT_SUCCESS: list_configured_symbols completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in list_configured_symbols for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
