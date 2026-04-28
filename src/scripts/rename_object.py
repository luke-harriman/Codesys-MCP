import sys, scriptengine as script_engine, os, traceback, re

OBJECT_PATH = "{OBJECT_PATH}"
NEW_NAME = "{NEW_NAME}"
UPDATE_REFERENCES = "{UPDATE_REFERENCES}" == "1"

# Per OPEN-BUGS-CROSS-REFERENCE Bug 5: CODESYS scripting's rename()/set_name()
# is a node-local rename only -- callers in other POUs keep referring to the
# old identifier, which is what the IDE's "Rename" command silently fixes
# above the scriptengine layer. We brute-force a project-wide identifier
# rewrite via word-boundary regex on every POU/DUT/GVL's textual_declaration
# and textual_implementation. False positives in comments / string literals
# are possible but rare for IEC identifiers; documented in the tool description.
#
# Docs: https://content.helpme-codesys.com/en/ScriptingEngine/ScriptObject.html
# (rename() exists; no documented refactor variant or find_references() in
# the public scripting API.)


def _walk_pou_like(node, out):
    """Walk every descendant of node and append objects that expose
    textual_declaration or textual_implementation -- POUs, DUTs, GVLs,
    methods, properties, action blocks. Skips nodes that don't have
    text content (folders, devices, application root)."""
    has_text = False
    try:
        if hasattr(node, 'textual_declaration') or hasattr(node, 'textual_implementation'):
            has_text = True
    except Exception:
        pass
    if has_text:
        out.append(node)
    try:
        for child in node.get_children(False):
            _walk_pou_like(child, out)
    except Exception:
        pass


def _read_text(text_obj):
    """Return the .text from a textual_declaration / textual_implementation
    object, or '' if unavailable. Defensive: some SPs raise on access."""
    if text_obj is None:
        return ''
    try:
        t = text_obj.text
    except Exception:
        return ''
    return t or ''


def _safe_set_text(target_node, attr_name, new_text):
    """Replace the text content. Mirrors set_pou_code.py's pattern:
    target.<attr>.replace(new_text). Returns (ok, error_str)."""
    try:
        text_obj = getattr(target_node, attr_name, None)
    except Exception as e:
        return False, "getattr %s: %s" % (attr_name, e)
    if text_obj is None:
        return False, "%s is None" % attr_name
    if not hasattr(text_obj, 'replace'):
        return False, "%s has no replace()" % attr_name
    try:
        text_obj.replace(new_text)
        return True, None
    except Exception as e:
        return False, "%s.replace failed: %s" % (attr_name, e)


try:
    print("DEBUG: rename_object script: ObjectPath='%s', NewName='%s', UpdateReferences=%s, Project='%s'" % (
        OBJECT_PATH, NEW_NAME, UPDATE_REFERENCES, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not OBJECT_PATH:
        raise ValueError("Object path empty.")
    if not NEW_NAME:
        raise ValueError("New name empty.")

    # Find the target object
    target_object = find_object_by_path_robust(primary_project, OBJECT_PATH, "target object")
    if not target_object:
        raise ValueError("Object not found at path: %s" % OBJECT_PATH)

    old_name = getattr(target_object, 'get_name', lambda: OBJECT_PATH)()
    target_type = type(target_object).__name__
    print("DEBUG: Found target object: %s (Type: %s)" % (old_name, target_type))

    # Capture the old identifier BEFORE the rename so we can rewrite
    # references against it.
    old_identifier = old_name
    target_object_id = None
    try:
        # Some ScriptObjects expose .get_id(); used to skip the target
        # itself in the references walk (the rename() updated the
        # target's textual_declaration's TYPE/PROGRAM/FUNCTION_BLOCK
        # header in place, so we must NOT regex it again).
        if hasattr(target_object, 'get_id'):
            target_object_id = target_object.get_id()
    except Exception:
        pass

    # Step 1: rename the target itself (existing behaviour).
    if hasattr(target_object, 'set_name'):
        print("DEBUG: Calling set_name('%s') on object '%s'" % (NEW_NAME, old_name))
        target_object.set_name(NEW_NAME)
        print("DEBUG: Object renamed.")
    elif hasattr(target_object, 'rename'):
        print("DEBUG: Calling rename('%s') on object '%s'" % (NEW_NAME, old_name))
        target_object.rename(NEW_NAME)
        print("DEBUG: Object renamed.")
    else:
        raise TypeError("Object '%s' of type %s does not support set_name() or rename()." % (
            old_name, target_type))

    # Step 2: optionally rewrite references in every OTHER text-bearing
    # object. Word-boundary regex so identifiers that share a prefix
    # (foo vs foobar) don't bleed.
    refs_updated = []
    refs_skipped_errors = []
    if UPDATE_REFERENCES and old_identifier and old_identifier != NEW_NAME:
        print("DEBUG: Updating references: \\b%s\\b -> %s" % (old_identifier, NEW_NAME))
        # IronPython 2.7's re module needs the pattern escaped in case the
        # old name contains regex metacharacters. IEC identifiers are
        # ASCII-letters/digits/underscore so this is normally a no-op,
        # but stay defensive.
        pattern = re.compile(r'\b' + re.escape(old_identifier) + r'\b')
        # Use a function callback for the replacement -- pattern.sub
        # treats \1, \g<...> etc in a string replacement, so a NEW_NAME
        # that happens to contain a backslash would be interpreted as a
        # backref. Callback form returns the literal string verbatim.
        def _replace_fn(m):
            return NEW_NAME

        all_text_nodes = []
        try:
            for child in primary_project.get_children(False):
                _walk_pou_like(child, all_text_nodes)
        except Exception as walk_err:
            print("WARN: walking project tree for references failed: %s" % walk_err)

        print("DEBUG: %d text-bearing node(s) to scan for references." % len(all_text_nodes))

        for node in all_text_nodes:
            # Skip the target object itself -- rename() already updated
            # its TYPE/FUNCTION_BLOCK header.
            try:
                node_id = node.get_id() if hasattr(node, 'get_id') else None
            except Exception:
                node_id = None
            if target_object_id is not None and node_id is not None and node_id == target_object_id:
                continue

            try:
                node_name = node.get_name() if hasattr(node, 'get_name') else '?'
            except Exception:
                node_name = '?'

            # Read declaration + implementation
            decl_obj = getattr(node, 'textual_declaration', None) if hasattr(node, 'textual_declaration') else None
            impl_obj = getattr(node, 'textual_implementation', None) if hasattr(node, 'textual_implementation') else None
            old_decl = _read_text(decl_obj)
            old_impl = _read_text(impl_obj)

            new_decl = pattern.sub(_replace_fn, old_decl) if old_decl else old_decl
            new_impl = pattern.sub(_replace_fn, old_impl) if old_impl else old_impl

            decl_changed = (new_decl != old_decl)
            impl_changed = (new_impl != old_impl)

            if not (decl_changed or impl_changed):
                continue

            print("DEBUG: rewriting refs in '%s' (decl_changed=%s, impl_changed=%s)" % (
                node_name, decl_changed, impl_changed))

            if decl_changed:
                ok, err = _safe_set_text(node, 'textual_declaration', new_decl)
                if not ok:
                    refs_skipped_errors.append("%s decl: %s" % (node_name, err))
                    continue
            if impl_changed:
                ok, err = _safe_set_text(node, 'textual_implementation', new_impl)
                if not ok:
                    refs_skipped_errors.append("%s impl: %s" % (node_name, err))
                    continue

            refs_updated.append(node_name)

        print("DEBUG: Updated references in %d node(s); skipped %d on errors." % (
            len(refs_updated), len(refs_skipped_errors)))
        for err in refs_skipped_errors:
            print("WARN: ref-update skipped: %s" % err)
    elif not UPDATE_REFERENCES:
        print("DEBUG: UPDATE_REFERENCES=0 -- skipping reference rewrite (caller opted out).")
    else:
        print("DEBUG: old==new -- skipping reference rewrite.")

    try:
        print("DEBUG: Saving Project...")
        primary_project.save()
        print("DEBUG: Project saved successfully after rename.")
    except Exception as save_err:
        print("ERROR: Failed to save Project after renaming object: %s" % save_err)
        detailed_error = traceback.format_exc()
        error_message = "Error saving Project after renaming '%s' to '%s': %s\n%s" % (
            old_name, NEW_NAME, save_err, detailed_error)
        print(error_message)
        print("SCRIPT_ERROR: %s" % error_message)
        sys.exit(1)

    print("Object Renamed: '%s' -> '%s'" % (old_name, NEW_NAME))
    print("Object Type: %s" % target_type)
    print("Path: %s" % OBJECT_PATH)
    if UPDATE_REFERENCES:
        print("References Updated In: %d node(s)" % len(refs_updated))
        if refs_updated:
            print("Updated Nodes: %s" % ", ".join(refs_updated))
    print("SCRIPT_SUCCESS: Object renamed successfully.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error renaming object '%s' in project '%s': %s\n%s" % (
        OBJECT_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
