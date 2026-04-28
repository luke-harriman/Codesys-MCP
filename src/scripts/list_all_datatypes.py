import sys, scriptengine as script_engine, os, traceback, json

# list_all_datatypes: dump every data type (DUT/struct/enum/alias/union)
# that the symbol configuration could potentially expose.
#
# RTFM (Stubs/scriptengine/ScriptSymbolConfigObject.pyi):
#   ScriptSymbolConfigObject.get_all_datatypes(compile=True) -> ScriptSymbolConfigSignatureCollection
#   Returns the same collection shape as get_all_signatures.

COMPILE_FLAG = "{COMPILE_FLAG}"

try:
    print("DEBUG: list_all_datatypes: Project='%s', compile=%s" % (PROJECT_FILE_PATH, COMPILE_FLAG))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    sc_obj = ensure_symbol_config(primary_project)
    sc_path = symbol_config_path(primary_project, sc_obj)

    do_compile = (COMPILE_FLAG == '1')
    dt_collection = sc_obj.get_all_datatypes(do_compile)
    if dt_collection is None:
        dt_collection = []

    result = {
        'project': project_basename,
        'symbol_config_path': sc_path,
        'compile_flag': do_compile,
        'count': 0,
        'datatypes': [],
    }
    for dt in dt_collection:
        try:
            fqn = dt.full_qualified_name
        except Exception:
            fqn = None
        try:
            name = dt.name
        except Exception:
            name = None
        try:
            library_id = dt.library_id
        except Exception:
            library_id = None
        try:
            ns_path = list(dt.namespace_path) if dt.namespace_path is not None else []
            ns_path = [str(p) for p in ns_path]
        except Exception:
            ns_path = []
        try:
            var_count = len(dt.variables)
        except Exception:
            var_count = None
        result['datatypes'].append({
            'fqn': str(fqn) if fqn is not None else None,
            'name': str(name) if name is not None else None,
            'library_id': str(library_id) if library_id is not None else None,
            'namespace_path': ns_path,
            'variable_count': var_count,
        })
    result['count'] = len(result['datatypes'])

    print("### SYMBOL_DATATYPES_START ###")
    print(json.dumps(result))
    print("### SYMBOL_DATATYPES_END ###")
    print("Symbol Configuration: %s" % sc_path)
    print("Total datatypes: %d (compile=%s)" % (result['count'], do_compile))
    print("SCRIPT_SUCCESS: list_all_datatypes completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in list_all_datatypes for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
