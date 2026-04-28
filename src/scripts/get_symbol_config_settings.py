import sys, scriptengine as script_engine, os, traceback, json

# get_symbol_config_settings: read every knob on the SymbolConfiguration
# object so the caller can decide what to flip via set_symbol_config_settings.
#
# RTFM (Stubs/scriptengine/ScriptSymbolConfigObject.pyi):
#   - content_feature_flags        (SymbolConfigContentFeatureFlags bitmask)
#   - effective_content_feature_flags
#   - symbol_attribute_filter_type (None/All/SimpleIdentifiers/Prefix/Regex)
#   - effective_symbol_attribute_filter_type
#   - symbol_attribute_filter_data (string for prefix/regex modes)
#   - symbol_comment_filter_type   (None/Normal/Docu/Both/PreferNormal/PreferDocu)
#   - effective_symbol_comment_filter_type
#   - enable_direct_io_access (bool)
#   - check_effective_direct_io_access() -> DirectIoAccessObstacles flags
#   - get_direct_io_obstacle_explanations(obstacles) -> list[str]
#   - client_side_layout_calculator (.type_guid + .name + .description)
#   - available_client_side_layout_calculators (collection of the same)


def _coerce_str(v):
    if v is None:
        return None
    try:
        return str(v)
    except Exception:
        return None


def _coerce_int(v):
    if v is None:
        return None
    try:
        # IronPython 2.7 may give us a CLR enum; int() works on .NET enums.
        return int(v)
    except Exception:
        try:
            return int(str(v))
        except Exception:
            return None


def _collect(obj, prop_name):
    """Return (raw_str, int_value) for a settings property. The string is
    the str(enum_value) which gives the human-readable name; the int is
    the underlying integer (useful for serialising). Either may be None
    if the property doesn't exist on this SP."""
    if not hasattr(obj, prop_name):
        return None, None
    try:
        v = getattr(obj, prop_name)
    except Exception as e:
        print("DEBUG: getattr(%s) raised: %s" % (prop_name, e))
        return None, None
    return _coerce_str(v), _coerce_int(v)


try:
    print("DEBUG: get_symbol_config_settings: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    sc_obj = ensure_symbol_config(primary_project)
    sc_path = symbol_config_path(primary_project, sc_obj)

    settings = {}

    cf_str, cf_int = _collect(sc_obj, 'content_feature_flags')
    settings['content_feature_flags'] = cf_str
    settings['content_feature_flags_int'] = cf_int

    ecf_str, ecf_int = _collect(sc_obj, 'effective_content_feature_flags')
    settings['effective_content_feature_flags'] = ecf_str
    settings['effective_content_feature_flags_int'] = ecf_int

    af_str, af_int = _collect(sc_obj, 'symbol_attribute_filter_type')
    settings['symbol_attribute_filter_type'] = af_str
    settings['symbol_attribute_filter_type_int'] = af_int

    eaf_str, eaf_int = _collect(sc_obj, 'effective_symbol_attribute_filter_type')
    settings['effective_symbol_attribute_filter_type'] = eaf_str
    settings['effective_symbol_attribute_filter_type_int'] = eaf_int

    afd_str, _ = _collect(sc_obj, 'symbol_attribute_filter_data')
    settings['symbol_attribute_filter_data'] = afd_str

    cmt_str, cmt_int = _collect(sc_obj, 'symbol_comment_filter_type')
    settings['symbol_comment_filter_type'] = cmt_str
    settings['symbol_comment_filter_type_int'] = cmt_int

    ecmt_str, ecmt_int = _collect(sc_obj, 'effective_symbol_comment_filter_type')
    settings['effective_symbol_comment_filter_type'] = ecmt_str
    settings['effective_symbol_comment_filter_type_int'] = ecmt_int

    if hasattr(sc_obj, 'enable_direct_io_access'):
        try:
            settings['enable_direct_io_access'] = bool(sc_obj.enable_direct_io_access)
        except Exception as e:
            print("DEBUG: enable_direct_io_access read failed: %s" % e)
            settings['enable_direct_io_access'] = None
    else:
        settings['enable_direct_io_access'] = None

    direct_io_obstacles = None
    obstacle_explanations = []
    if hasattr(sc_obj, 'check_effective_direct_io_access'):
        try:
            obs = sc_obj.check_effective_direct_io_access()
            direct_io_obstacles = _coerce_str(obs)
            if hasattr(sc_obj, 'get_direct_io_obstacle_explanations'):
                try:
                    explanations = sc_obj.get_direct_io_obstacle_explanations(obs) or []
                    obstacle_explanations = [_coerce_str(x) for x in explanations]
                except Exception as e:
                    print("DEBUG: get_direct_io_obstacle_explanations failed: %s" % e)
        except Exception as e:
            print("DEBUG: check_effective_direct_io_access failed: %s" % e)
    settings['direct_io_obstacles'] = direct_io_obstacles
    settings['direct_io_obstacle_explanations'] = obstacle_explanations

    layout_info = {}
    if hasattr(sc_obj, 'client_side_layout_calculator_guid'):
        try:
            layout_info['guid'] = _coerce_str(sc_obj.client_side_layout_calculator_guid)
        except Exception:
            layout_info['guid'] = None
    if hasattr(sc_obj, 'client_side_layout_calculator'):
        try:
            calc = sc_obj.client_side_layout_calculator
            if calc is not None:
                layout_info['name'] = _coerce_str(getattr(calc, 'name', None))
                layout_info['type_guid'] = _coerce_str(getattr(calc, 'type_guid', None))
                layout_info['description'] = _coerce_str(getattr(calc, 'description', None))
        except Exception as e:
            print("DEBUG: client_side_layout_calculator read failed: %s" % e)
    settings['layout_calculator'] = layout_info

    available_calcs = []
    if hasattr(sc_obj, 'available_client_side_layout_calculators'):
        try:
            for calc in (sc_obj.available_client_side_layout_calculators or []):
                available_calcs.append({
                    'name': _coerce_str(getattr(calc, 'name', None)),
                    'type_guid': _coerce_str(getattr(calc, 'type_guid', None)),
                    'description': _coerce_str(getattr(calc, 'description', None)),
                })
        except Exception as e:
            print("DEBUG: available_client_side_layout_calculators read failed: %s" % e)
    settings['available_layout_calculators'] = available_calcs

    result = {
        'project': project_basename,
        'symbol_config_path': sc_path,
        'settings': settings,
    }

    print("### SYMBOL_CONFIG_SETTINGS_START ###")
    print(json.dumps(result))
    print("### SYMBOL_CONFIG_SETTINGS_END ###")
    print("Symbol Configuration: %s" % sc_path)
    print("Content feature flags: %s" % settings['content_feature_flags'])
    print("Attribute filter type: %s" % settings['symbol_attribute_filter_type'])
    print("Comment filter type:   %s" % settings['symbol_comment_filter_type'])
    print("Direct I/O access:     %s (obstacles=%s)" % (
        settings['enable_direct_io_access'], settings['direct_io_obstacles']))
    print("SCRIPT_SUCCESS: get_symbol_config_settings completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in get_symbol_config_settings for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
