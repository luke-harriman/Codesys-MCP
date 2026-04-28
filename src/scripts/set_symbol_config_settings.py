import sys, scriptengine as script_engine, os, traceback, json

# set_symbol_config_settings: partial-update of every knob on the
# SymbolConfiguration object. Only fields explicitly supplied (i.e.
# the corresponding APPLY_* placeholder is '1') are written; everything
# else is left untouched.
#
# RTFM (Stubs/scriptengine/ScriptSymbolConfigObject.pyi):
#   - content_feature_flags         (SymbolConfigContentFeatureFlags bitmask)
#   - symbol_attribute_filter_type  (SymbolAttributeFilterTypes enum)
#   - symbol_attribute_filter_data  (str)
#   - symbol_comment_filter_type    (SymbolCommentFilterType enum)
#   - enable_direct_io_access       (bool)
#   - client_side_layout_calculator_guid (System.Guid)

APPLY_CONTENT_FLAGS = "{APPLY_CONTENT_FLAGS}" == '1'
CONTENT_FLAGS_INT = "{CONTENT_FLAGS_INT}"

APPLY_ATTR_FILTER_TYPE = "{APPLY_ATTR_FILTER_TYPE}" == '1'
ATTR_FILTER_TYPE = "{ATTR_FILTER_TYPE}"  # enum member name

APPLY_ATTR_FILTER_DATA = "{APPLY_ATTR_FILTER_DATA}" == '1'
ATTR_FILTER_DATA = r"{ATTR_FILTER_DATA}"

APPLY_COMMENT_FILTER_TYPE = "{APPLY_COMMENT_FILTER_TYPE}" == '1'
COMMENT_FILTER_TYPE = "{COMMENT_FILTER_TYPE}"

APPLY_DIRECT_IO = "{APPLY_DIRECT_IO}" == '1'
DIRECT_IO = "{DIRECT_IO}" == '1'

APPLY_LAYOUT = "{APPLY_LAYOUT}" == '1'
LAYOUT_CALCULATOR = "{LAYOUT_CALCULATOR}"

COMPATIBILITY_GUID_LITERAL = '00000000-0000-0000-0000-000000000000'
OPTIMIZED_GUID_LITERAL = '0141eb75-141b-4ea1-9a8c-75f952b22a6c'


def _resolve_guid(label):
    label_l = (label or '').strip().lower()
    if label_l in ('', 'compatibility', 'default', 'compat'):
        guid_str = COMPATIBILITY_GUID_LITERAL
    elif label_l in ('optimized', 'optimised', 'optimal'):
        guid_str = OPTIMIZED_GUID_LITERAL
    else:
        guid_str = label
    try:
        from System import Guid
        return Guid(guid_str)
    except Exception as e:
        print("DEBUG: System.Guid(%r) failed: %s" % (guid_str, e))
        return guid_str


def _enum_member(enum_cls, name):
    """Look up an enum member case-insensitively. Returns the enum value
    or raises ValueError listing the available members."""
    if name is None:
        raise ValueError("enum member name is None")
    available = [m for m in dir(enum_cls) if not m.startswith('_')]
    for m in available:
        if m.lower() == name.lower():
            return getattr(enum_cls, m)
    raise ValueError("Unknown member '%s'. Available: %s" % (name, ', '.join(available)))


try:
    print("DEBUG: set_symbol_config_settings: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_basename = os.path.basename(PROJECT_FILE_PATH)

    sc_obj = ensure_symbol_config(primary_project)
    sc_path = symbol_config_path(primary_project, sc_obj)
    print("DEBUG: Symbol Configuration: %s" % sc_path)

    changes = []

    if APPLY_CONTENT_FLAGS:
        try:
            from scriptengine import SymbolConfigContentFeatureFlags as cff_enum
        except Exception:
            cff_enum = None
        try:
            target_int = int(CONTENT_FLAGS_INT)
        except Exception:
            raise ValueError("contentFeatureFlags integer parse failed: %r" % CONTENT_FLAGS_INT)
        # Try setting the int directly first (CODESYS enums are int-backed
        # System.Enum values; the property setter usually accepts the int).
        try:
            sc_obj.content_feature_flags = target_int
            changes.append("content_feature_flags = %d" % target_int)
            print("DEBUG: content_feature_flags set to int %d" % target_int)
        except Exception as e:
            print("DEBUG: int assignment failed: %s -- trying enum coercion" % e)
            if cff_enum is None:
                raise
            # Fall back to constructing the enum from int via Enum.ToObject
            try:
                from System import Enum
                ev = Enum.ToObject(cff_enum, target_int)
                sc_obj.content_feature_flags = ev
                changes.append("content_feature_flags = %s (%d via Enum.ToObject)" % (ev, target_int))
            except Exception as e2:
                raise RuntimeError("Could not assign content_feature_flags: %s / %s" % (e, e2))

    if APPLY_ATTR_FILTER_TYPE:
        try:
            from scriptengine import SymbolAttributeFilterTypes as af_enum
        except Exception as e:
            raise RuntimeError("SymbolAttributeFilterTypes not importable: %s" % e)
        ev = _enum_member(af_enum, ATTR_FILTER_TYPE)
        sc_obj.symbol_attribute_filter_type = ev
        changes.append("symbol_attribute_filter_type = %s" % ev)

    if APPLY_ATTR_FILTER_DATA:
        sc_obj.symbol_attribute_filter_data = ATTR_FILTER_DATA
        changes.append("symbol_attribute_filter_data = %r" % ATTR_FILTER_DATA)

    if APPLY_COMMENT_FILTER_TYPE:
        try:
            from scriptengine import SymbolCommentFilterType as cmt_enum
        except Exception as e:
            raise RuntimeError("SymbolCommentFilterType not importable: %s" % e)
        ev = _enum_member(cmt_enum, COMMENT_FILTER_TYPE)
        sc_obj.symbol_comment_filter_type = ev
        changes.append("symbol_comment_filter_type = %s" % ev)

    if APPLY_DIRECT_IO:
        # Defensive: if user wants to ENABLE direct IO and it's blocked
        # by obstacles, refuse with the explanations rather than silently
        # leaving the flag set with no effect.
        if DIRECT_IO and hasattr(sc_obj, 'check_effective_direct_io_access'):
            try:
                obs = sc_obj.check_effective_direct_io_access()
                obs_str = str(obs).lower()
                if obs_str not in ('none', 'directioaccessobstacles.none', '0', 'directioaccessobstacles_none'):
                    explanations = []
                    if hasattr(sc_obj, 'get_direct_io_obstacle_explanations'):
                        try:
                            explanations = list(sc_obj.get_direct_io_obstacle_explanations(obs)) or []
                        except Exception:
                            pass
                    raise RuntimeError(
                        "Refusing to enable direct I/O access: blocked by obstacles=%s. "
                        "Explanations: %s" % (obs, ' | '.join(str(e) for e in explanations)))
            except RuntimeError:
                raise
            except Exception as e:
                print("DEBUG: direct I/O obstacle pre-check failed (continuing): %s" % e)
        sc_obj.enable_direct_io_access = DIRECT_IO
        changes.append("enable_direct_io_access = %s" % DIRECT_IO)

    if APPLY_LAYOUT:
        guid = _resolve_guid(LAYOUT_CALCULATOR)
        sc_obj.client_side_layout_calculator_guid = guid
        changes.append("client_side_layout_calculator_guid = %s" % guid)

    if not changes:
        print("No fields supplied; nothing changed.")
    else:
        primary_project.save()

    result = {
        'project': project_basename,
        'symbol_config_path': sc_path,
        'changes_applied': changes,
        'change_count': len(changes),
    }
    print("### SYMBOL_CONFIG_SET_START ###")
    print(json.dumps(result))
    print("### SYMBOL_CONFIG_SET_END ###")
    for ch in changes:
        print("Applied: %s" % ch)
    print("SCRIPT_SUCCESS: set_symbol_config_settings completed.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in set_symbol_config_settings for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
