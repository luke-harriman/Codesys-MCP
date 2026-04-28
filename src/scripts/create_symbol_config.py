import sys, scriptengine as script_engine, os, traceback, json

# create_symbol_config: add a SymbolConfiguration object under an Application.
#
# RTFM (Stubs/scriptengine/ScriptSymbolConfigObject.pyi
# ScriptApplicationSymbolConfigExtension.create_symbol_config):
#   create_symbol_config(export_comments_to_xml: bool,
#                        support_opc_ua: bool,
#                        client_side_layout_calculator: Guid) -> ScriptObject
#
# Two layout calculators are documented:
#   - Guid.Empty                                  -> Compatibility (always available)
#   - "{0141eb75-141b-4ea1-9a8c-75f952b22a6c}"   -> OptimizedOutputOffsetCalculator
#                                                   (V3.5.7.0+)
#
# This tool is idempotent: if a SymbolConfiguration already exists under
# the chosen Application, it returns success with the existing object's
# path instead of creating a duplicate.

APPLICATION_PATH = "{APPLICATION_PATH}"
EXPORT_COMMENTS_TO_XML = "{EXPORT_COMMENTS_TO_XML}" == '1'
SUPPORT_OPC_UA = "{SUPPORT_OPC_UA}" == '1'
LAYOUT_CALCULATOR = "{LAYOUT_CALCULATOR}"  # 'compatibility' or 'optimized'

# Pre-known calculator GUIDs (per the SP22 stub docstrings).
COMPATIBILITY_GUID_LITERAL = '00000000-0000-0000-0000-000000000000'
OPTIMIZED_GUID_LITERAL = '0141eb75-141b-4ea1-9a8c-75f952b22a6c'


def _resolve_guid(label):
    """Convert the layoutCalculator string into a System.Guid. Probes the
    available_client_side_layout_calculators collection on the symbol
    config plug-in if it's reachable, otherwise constructs by literal."""
    label_l = (label or '').strip().lower()
    if label_l in ('', 'compatibility', 'default', 'compat'):
        guid_str = COMPATIBILITY_GUID_LITERAL
    elif label_l in ('optimized', 'optimised', 'optimal'):
        guid_str = OPTIMIZED_GUID_LITERAL
    else:
        # Allow callers to pass a raw GUID literal through.
        guid_str = label
    try:
        from System import Guid
        return Guid(guid_str)
    except Exception as e:
        print("DEBUG: System.Guid(%r) failed: %s -- returning string" % (guid_str, e))
        return guid_str


def _find_application(primary_project, app_path):
    """Resolve APPLICATION_PATH down to an Application ScriptObject.
    Accepts either:
      - the Application's own name (case-insensitive), or
      - a slash-separated path like 'CodesysRpi/Plc Logic/Application'.
    Falls back to primary_project.active_application then a recursive
    walk for is_application=True."""
    target_lower = (app_path or '').strip().lower().lstrip('/')
    if target_lower:
        # Slash path: walk via find_object_by_path_robust if available
        # (loaded as a helper). Otherwise descend manually by name match.
        if 'find_object_by_path_robust' in globals():
            obj = find_object_by_path_robust(primary_project, app_path, "application")
            if obj is not None:
                return obj
        else:
            # Manual descent
            parts = [p for p in app_path.replace('\\', '/').split('/') if p]
            current = primary_project
            for part in parts:
                next_obj = None
                try:
                    for c in current.get_children(False):
                        try:
                            if c.get_name() == part:
                                next_obj = c
                                break
                        except Exception:
                            continue
                except Exception:
                    pass
                if next_obj is None:
                    return None
                current = next_obj
            return current
    # Empty path: try active_application then walk for is_application.
    try:
        ap = primary_project.active_application
        if ap is not None:
            return ap
    except Exception:
        pass
    try:
        for c in primary_project.get_children(True):
            try:
                if getattr(c, 'is_application', False):
                    return c
            except Exception:
                continue
    except Exception:
        pass
    return None


try:
    print("DEBUG: create_symbol_config: Project='%s', AppPath='%s', "
          "exportComments=%s, supportOpcUa=%s, layout=%s" % (
              PROJECT_FILE_PATH, APPLICATION_PATH,
              EXPORT_COMMENTS_TO_XML, SUPPORT_OPC_UA, LAYOUT_CALCULATOR))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    # Idempotency: if a symbol config already exists ANYWHERE in the
    # project tree, no-op with success and return the existing path.
    existing = find_symbol_config_object(primary_project)
    if existing is not None:
        existing_path = symbol_config_path(primary_project, existing)
        print("Symbol Configuration already exists at: %s" % existing_path)
        result = {
            'project': project_basename,
            'created': False,
            'symbol_config_path': existing_path,
            'note': 'Symbol Configuration already present; no-op.',
        }
        print("### SYMBOL_CONFIG_CREATE_START ###")
        print(json.dumps(result))
        print("### SYMBOL_CONFIG_CREATE_END ###")
        print("SCRIPT_SUCCESS: create_symbol_config -- already present, no-op.")
        sys.exit(0)

    application = _find_application(primary_project, APPLICATION_PATH)
    if application is None:
        raise RuntimeError(
            "Could not resolve Application from path '%s'. Pass an explicit "
            "applicationPath like 'CodesysRpi/Plc Logic/Application' or leave "
            "blank to use the project's active application." % APPLICATION_PATH)

    try:
        app_name = application.get_name()
    except Exception:
        app_name = '?'
    print("DEBUG: Resolved Application: %s" % app_name)

    if not hasattr(application, 'create_symbol_config'):
        raise TypeError(
            "Resolved object '%s' has no create_symbol_config() method. "
            "Either it isn't an Application, or this SP doesn't expose the "
            "Symbol Configuration extension on it." % app_name)

    layout_guid = _resolve_guid(LAYOUT_CALCULATOR)
    print("DEBUG: Calling create_symbol_config(export_comments=%s, opc_ua=%s, layout=%s)" % (
        EXPORT_COMMENTS_TO_XML, SUPPORT_OPC_UA, layout_guid))

    sc_obj = application.create_symbol_config(
        EXPORT_COMMENTS_TO_XML,
        SUPPORT_OPC_UA,
        layout_guid)

    if sc_obj is None:
        raise RuntimeError("application.create_symbol_config returned None.")

    sc_path = symbol_config_path(primary_project, sc_obj)
    primary_project.save()

    result = {
        'project': project_basename,
        'created': True,
        'application': app_name,
        'symbol_config_path': sc_path,
        'export_comments_to_xml': EXPORT_COMMENTS_TO_XML,
        'support_opc_ua': SUPPORT_OPC_UA,
        'layout_calculator': LAYOUT_CALCULATOR,
    }
    print("### SYMBOL_CONFIG_CREATE_START ###")
    print(json.dumps(result))
    print("### SYMBOL_CONFIG_CREATE_END ###")
    print("Created Symbol Configuration: %s" % sc_path)
    print("SCRIPT_SUCCESS: create_symbol_config completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in create_symbol_config for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
