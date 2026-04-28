import sys, scriptengine as script_engine, os, traceback

# export_symbol_xsd: write the SymbolConfiguration's XSD schema to a file.
#
# RTFM (Stubs/scriptengine/ScriptSymbolConfigObject.pyi):
#   ScriptSymbolConfigObject.get_symbol_configuration_xsd() -> list[byte]
#     "delivered as a byte array, containing the UTF-8 encoded XSD file"
#
# The schema is also published at
#   http://www.3s-software.com/schemas/Symbolconfiguration.xsd
# but the API call returns the version of the schema applicable to the
# current Symbol Config plug-in -- which may differ from the always-newest
# online URL.

OUTPUT_FILE_PATH = r"{OUTPUT_FILE_PATH}"

try:
    print("DEBUG: export_symbol_xsd: Project='%s' Output='%s'" % (
        PROJECT_FILE_PATH, OUTPUT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    sc_obj = ensure_symbol_config(primary_project)
    sc_path = symbol_config_path(primary_project, sc_obj)

    parent_dir = os.path.dirname(OUTPUT_FILE_PATH)
    if parent_dir and not os.path.isdir(parent_dir):
        raise RuntimeError("Parent directory does not exist: %s" % parent_dir)

    if not hasattr(sc_obj, 'get_symbol_configuration_xsd'):
        raise TypeError("Symbol Configuration object has no get_symbol_configuration_xsd() method.")

    xsd_bytes = sc_obj.get_symbol_configuration_xsd()
    if xsd_bytes is None:
        raise RuntimeError("get_symbol_configuration_xsd() returned None.")

    # IronPython 2.7: the API yields a CLR System.Byte[]. Iterating yields
    # ints; bytearray() consumes any iterable of ints.
    try:
        out_bytes = bytearray(xsd_bytes)
    except TypeError:
        # Some SP releases hand us str-like objects -- fall back to that.
        out_bytes = bytearray(str(xsd_bytes).encode('utf-8'))

    with open(OUTPUT_FILE_PATH, 'wb') as f:
        f.write(bytes(out_bytes))

    size = os.path.getsize(OUTPUT_FILE_PATH)
    print("Wrote %d bytes to %s" % (size, OUTPUT_FILE_PATH))
    print("Symbol Configuration: %s" % sc_path)
    print("SCRIPT_SUCCESS: export_symbol_xsd completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in export_symbol_xsd for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
