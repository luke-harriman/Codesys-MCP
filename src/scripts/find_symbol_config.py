import sys, scriptengine as script_engine, os, traceback, json

# find_symbol_config: locate the SymbolConfiguration object(s) in a project.
#
# RTFM (helpme-codesys.com + SP22 stub Stubs/scriptengine/ScriptSymbolConfigObject.pyi):
#   - is_symbol_config @property is added to every ScriptObject (since 3.5.10.0)
#   - A project can have 0..N SymbolConfiguration objects (one per Application).
#
# Returns ALL matches (so the caller can spot multi-Application projects)
# along with the basic object identification.

try:
    print("DEBUG: find_symbol_config: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    matches = find_all_symbol_config_objects(primary_project)
    print("DEBUG: %d symbol config object(s) found." % len(matches))

    result = {
        'project': project_basename,
        'count': len(matches),
        'objects': [],
    }
    for sc in matches:
        try:
            name = sc.get_name()
        except Exception:
            name = '?'
        path = symbol_config_path(primary_project, sc)
        try:
            sc_id = str(sc.get_id())
        except Exception:
            sc_id = None
        result['objects'].append({
            'name': name,
            'path': path,
            'id': sc_id,
        })

    print("### SYMBOL_CONFIG_FIND_START ###")
    print(json.dumps(result))
    print("### SYMBOL_CONFIG_FIND_END ###")
    if result['count'] == 0:
        print("No Symbol Configuration in '%s'. Use create_symbol_config to add one." % project_basename)
    else:
        for obj in result['objects']:
            print("Found Symbol Configuration: %s" % obj['path'])
    print("SCRIPT_SUCCESS: find_symbol_config completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in find_symbol_config for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
