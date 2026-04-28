import sys, scriptengine as script_engine, os, traceback

FOLDER_NAME = "{FOLDER_NAME}"
PARENT_PATH_REL = "{PARENT_PATH}"

try:
    print("DEBUG: create_folder script: Name='%s', ParentPath='%s', Project='%s'" % (FOLDER_NAME, PARENT_PATH_REL, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not FOLDER_NAME: raise ValueError("Folder name empty.")
    if not PARENT_PATH_REL: raise ValueError("Parent path empty.")

    # Find parent object (same logic as create_pou)
    if PARENT_PATH_REL == "Application":
        project_name = os.path.splitext(os.path.basename(PROJECT_FILE_PATH))[0]
        potential_paths = [
            PARENT_PATH_REL,
            "%s.%s" % (project_name, PARENT_PATH_REL),
            "%s/%s" % (project_name, PARENT_PATH_REL),
        ]
        parent_object = None
        for path in potential_paths:
            parent_candidate = find_object_by_path_robust(primary_project, path, "parent container")
            if parent_candidate:
                parent_object = parent_candidate
                print("DEBUG: Found parent using path: '%s'" % path)
                break
        if not parent_object:
            try:
                if hasattr(primary_project, 'active_application'):
                    app = primary_project.active_application
                    if app:
                        parent_object = app
                        print("DEBUG: Found application directly: %s" % app.get_name())
                if not parent_object and hasattr(primary_project, 'find'):
                    apps = primary_project.find("Application", True)
                    if apps:
                        parent_object = apps[0]
            except Exception as e:
                print("ERROR: Direct application access failed: %s" % e)
    else:
        parent_object = find_object_by_path_robust(primary_project, PARENT_PATH_REL, "parent container")

    if not parent_object:
        raise ValueError("Parent object not found for path: %s" % PARENT_PATH_REL)

    parent_name = getattr(parent_object, 'get_name', lambda: str(parent_object))()
    print("DEBUG: Using parent object: %s" % parent_name)

    # Create the folder. Per the SP22 stubs:
    #   ScriptObject.create_folder(foldername)             -- on POUs / sub-objects
    #   ScriptProject.create_folder(foldername, structured_view=None)
    #                                                       -- on the project itself
    #
    # CRITICAL gotcha verified by experiment on SP22 (and confirmed by
    # the helpme-codesys.com signature): create_folder returns **void**
    # (Python None), NOT the new folder object. The folder IS created
    # via side effect; you have to walk the parent's children to find it.
    # Earlier fork versions treated None as failure -- that was the
    # whole "v1/v2/v3 fell through every strategy silently" bug.
    #
    # Strategy: try each call in order, then immediately walk
    # parent_object.get_children(False) for a child named FOLDER_NAME.
    # First strategy that produces such a child wins; the rest are
    # never tried (avoids creating duplicates).

    SV_POU_GUID_STR = '21AF5390-2942-461a-BF89-951AAF6999F1'
    sv_pou_guid = None
    try:
        from System import Guid
        sv_pou_guid = Guid(SV_POU_GUID_STR)
    except Exception as guid_e:
        print("WARN: Could not construct System.Guid for SV_POU: %s" % guid_e)

    def _find_folder_under_parent():
        """Walk parent_object's direct children looking for FOLDER_NAME.
        Returns the matching child object or None. Used after each
        strategy to detect side-effect-only success."""
        try:
            for child in parent_object.get_children(False):
                try:
                    if getattr(child, 'get_name', lambda: None)() == FOLDER_NAME:
                        return child
                except Exception:
                    pass
        except Exception:
            pass
        return None

    new_folder = None
    strategies_tried = []

    # Strategy 1: parent.create_folder(name) positional. Per the docs
    # this creates the folder in the parent's structured view.
    if new_folder is None and hasattr(parent_object, 'create_folder'):
        strategies_tried.append('parent.create_folder(name)')
        try:
            print("DEBUG: Trying parent.create_folder('%s')" % FOLDER_NAME)
            ret = parent_object.create_folder(FOLDER_NAME)
            new_folder = ret if ret is not None else _find_folder_under_parent()
            if new_folder is not None:
                print("DEBUG: parent.create_folder() succeeded (folder found in children).")
        except Exception as e:
            print("WARN: parent.create_folder('%s') raised: %s" % (FOLDER_NAME, e))

    # Strategy 2: project.create_folder(name, SV_POU_GUID). The folder
    # lands in the POU view, which is where Application's children live.
    if new_folder is None and hasattr(primary_project, 'create_folder') and sv_pou_guid is not None:
        strategies_tried.append('project.create_folder(name, SV_POU)')
        try:
            print("DEBUG: Trying primary_project.create_folder('%s', SV_POU)" % FOLDER_NAME)
            ret = primary_project.create_folder(FOLDER_NAME, sv_pou_guid)
            new_folder = ret if ret is not None else _find_folder_under_parent()
            if new_folder is not None:
                print("DEBUG: project.create_folder(SV_POU) succeeded (folder found in children).")
        except Exception as e:
            print("WARN: primary_project.create_folder('%s', SV_POU) raised: %s" % (FOLDER_NAME, e))

    # Strategy 3: project.create_folder(name) default view.
    if new_folder is None and hasattr(primary_project, 'create_folder'):
        strategies_tried.append('project.create_folder(name)')
        try:
            print("DEBUG: Trying primary_project.create_folder('%s') [default view]" % FOLDER_NAME)
            ret = primary_project.create_folder(FOLDER_NAME)
            new_folder = ret if ret is not None else _find_folder_under_parent()
            if new_folder is not None:
                print("DEBUG: project.create_folder() default-view succeeded.")
        except Exception as e:
            print("WARN: primary_project.create_folder('%s') raised: %s" % (FOLDER_NAME, e))

    # Strategy 4: generic create_object with the folder type UUID.
    if new_folder is None and hasattr(parent_object, 'create_object'):
        FOLDER_TYPE_UUID = '85d1215e-6520-4983-9a55-2d39d1f24cb4'
        strategies_tried.append('parent.create_object(typeUuid)')
        try:
            print("DEBUG: Trying parent.create_object(typeUuid=%s, name='%s')" % (FOLDER_TYPE_UUID, FOLDER_NAME))
            ret = parent_object.create_object(typeUuid=FOLDER_TYPE_UUID, name=FOLDER_NAME)
            new_folder = ret if ret is not None else _find_folder_under_parent()
        except Exception as e:
            print("WARN: parent.create_object(typeUuid=%s) raised: %s" % (FOLDER_TYPE_UUID, e))

    # Strategy 5: types.IecFolder + parent.add (very old API).
    if new_folder is None and hasattr(script_engine, 'types') and hasattr(script_engine.types, 'IecFolder') and hasattr(parent_object, 'add'):
        strategies_tried.append('parent.add(IecFolder)')
        try:
            print("DEBUG: Trying parent.add(script_engine.types.IecFolder, name='%s')" % FOLDER_NAME)
            ret = parent_object.add(script_engine.types.IecFolder, name=FOLDER_NAME)
            new_folder = ret if ret is not None else _find_folder_under_parent()
        except Exception as e:
            print("WARN: parent.add(types.IecFolder) raised: %s" % e)

    if new_folder is None:
        # Total miss -- dump dir(parent) to surface what API surface this
        # SP actually exposes, so the next iteration can target it. Helps
        # OPEN-BUGS-CROSS-REFERENCE Bug 1 diagnosis on unexpected SPs.
        try:
            api_attrs = sorted([a for a in dir(parent_object) if not a.startswith('_')])
            api_dump = ', '.join(api_attrs)
        except Exception as de:
            api_dump = '<dir() failed: %s>' % de
        raise TypeError(
            "Parent object '%s' of type %s -- folder '%s' could not be created or located after trying %s. parent api: %s" % (
                parent_name, type(parent_object).__name__, FOLDER_NAME,
                ', '.join(strategies_tried) or '<no strategies available>',
                api_dump))

    if new_folder:
        new_folder_name = getattr(new_folder, 'get_name', lambda: FOLDER_NAME)()
        print("DEBUG: Folder object created: %s" % new_folder_name)

        try:
            print("DEBUG: Saving Project...")
            primary_project.save()
            print("DEBUG: Project saved successfully after folder creation.")
        except Exception as save_err:
            print("ERROR: Failed to save Project after folder creation: %s" % save_err)
            detailed_error = traceback.format_exc()
            error_message = "Error saving Project after creating folder '%s': %s\n%s" % (FOLDER_NAME, save_err, detailed_error)
            print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)

        print("Folder Created: %s" % new_folder_name)
        print("Parent Path: %s" % PARENT_PATH_REL)
        print("SCRIPT_SUCCESS: Folder created successfully.")
        sys.exit(0)
    else:
        error_message = "Failed to create folder '%s'. create_folder returned None." % FOLDER_NAME
        print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error creating folder '%s' in project '%s': %s\n%s" % (FOLDER_NAME, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message); print("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
