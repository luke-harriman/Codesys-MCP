import sys, scriptengine as script_engine, os, traceback, json

# list_all_signatures: dump every signature (POU/FB/Method/Function) that
# the symbol configuration could potentially expose.
#
# RTFM (Stubs/scriptengine/ScriptSymbolConfigObject.pyi):
#   ScriptSymbolConfigObject.get_all_signatures(compile=True) -> ScriptSymbolConfigSignatureCollection
#     compile=True: build the application before generating the list
#                   (slow but authoritative). compile=False: cached only;
#                   may return an empty list if the application has not
#                   been built since opening.
#
# Each signature exposes: name, full_qualified_name, library_id,
# namespace_path, variables.

# COMPILE_FLAG is '1' (force build) or '0' (cached only).
COMPILE_FLAG = "{COMPILE_FLAG}"

try:
    print("DEBUG: list_all_signatures: Project='%s', compile=%s" % (PROJECT_FILE_PATH, COMPILE_FLAG))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    sc_obj = ensure_symbol_config(primary_project)
    sc_path = symbol_config_path(primary_project, sc_obj)

    do_compile = (COMPILE_FLAG == '1')
    sig_collection = sc_obj.get_all_signatures(do_compile)
    if sig_collection is None:
        sig_collection = []

    result = {
        'project': project_basename,
        'symbol_config_path': sc_path,
        'compile_flag': do_compile,
        'count': 0,
        'signatures': [],
    }
    for sig in sig_collection:
        try:
            fqn = sig.full_qualified_name
        except Exception:
            fqn = None
        try:
            name = sig.name
        except Exception:
            name = None
        try:
            library_id = sig.library_id
        except Exception:
            library_id = None
        try:
            ns_path = list(sig.namespace_path) if sig.namespace_path is not None else []
            ns_path = [str(p) for p in ns_path]
        except Exception:
            ns_path = []
        try:
            var_count = len(sig.variables)
        except Exception:
            var_count = None
        result['signatures'].append({
            'fqn': str(fqn) if fqn is not None else None,
            'name': str(name) if name is not None else None,
            'library_id': str(library_id) if library_id is not None else None,
            'namespace_path': ns_path,
            'variable_count': var_count,
        })
    result['count'] = len(result['signatures'])

    print("### SYMBOL_SIGNATURES_START ###")
    print(json.dumps(result))
    print("### SYMBOL_SIGNATURES_END ###")
    print("Symbol Configuration: %s" % sc_path)
    print("Total signatures: %d (compile=%s)" % (result['count'], do_compile))
    print("SCRIPT_SUCCESS: list_all_signatures completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in list_all_signatures for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
