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
    #                                                       -- on the project itself,
    #                                                          accepts an explicit view GUID
    # On SP22 specifically, calling .create_folder('X') on an Application object
    # returns None silently (no exception, no folder created). The reliable
    # pathway is to call create_folder on the PROJECT with an explicit
    # structured_view GUID -- the SV_POU view is where Application's children
    # live, so a folder there will appear under Application in the IDE tree.
    #
    # SV_POU GUID = {21AF5390-2942-461a-BF89-951AAF6999F1}. (Documented in the
    # ScriptProject.pyi stub; constant since SP3.5.2.0.)
    SV_POU_GUID_STR = '21AF5390-2942-461a-BF89-951AAF6999F1'
    sv_pou_guid = None
    try:
        from System import Guid
        sv_pou_guid = Guid(SV_POU_GUID_STR)
    except Exception as guid_e:
        print("WARN: Could not construct System.Guid for SV_POU: %s" % guid_e)

    new_folder = None

    # Strategy 1: project-level create_folder with explicit POU view. This is
    # the only call shape that reliably works on SP22 Application children.
    if hasattr(primary_project, 'create_folder') and sv_pou_guid is not None:
        try:
            print("DEBUG: Trying primary_project.create_folder('%s', SV_POU)" % FOLDER_NAME)
            new_folder = primary_project.create_folder(FOLDER_NAME, sv_pou_guid)
            if new_folder is not None:
                print("DEBUG: project.create_folder(SV_POU) succeeded.")
        except Exception as e:
            print("WARN: primary_project.create_folder('%s', SV_POU) raised: %s" % (FOLDER_NAME, e))
            new_folder = None

    # Strategy 2: parent.create_folder (positional). Works pre-SP21 and on
    # parents whose factories haven't been pinned to project-level.
    if new_folder is None and hasattr(parent_object, 'create_folder'):
        try:
            print("DEBUG: Trying parent.create_folder('%s') [positional]" % FOLDER_NAME)
            new_folder = parent_object.create_folder(FOLDER_NAME)
            if new_folder is not None:
                print("DEBUG: parent.create_folder() positional succeeded.")
        except Exception as e:
            print("WARN: parent.create_folder('%s') raised: %s" % (FOLDER_NAME, e))
            new_folder = None
        if new_folder is None:
            try:
                new_folder = parent_object.create_folder(foldername=FOLDER_NAME)
                if new_folder is not None:
                    print("DEBUG: parent.create_folder(foldername=) succeeded.")
            except Exception as e2:
                print("WARN: parent.create_folder(foldername='%s') raised: %s" % (FOLDER_NAME, e2))
                new_folder = None

    # Strategy 3: project-level create_folder default view (POU).
    if new_folder is None and hasattr(primary_project, 'create_folder'):
        try:
            print("DEBUG: Trying primary_project.create_folder('%s') [default view]" % FOLDER_NAME)
            new_folder = primary_project.create_folder(FOLDER_NAME)
            if new_folder is not None:
                print("DEBUG: project.create_folder() default-view succeeded.")
        except Exception as e:
            print("WARN: primary_project.create_folder('%s') raised: %s" % (FOLDER_NAME, e))
            new_folder = None

    # Strategy 4: generic create_object with the folder type UUID. Last-ditch
    # for non-standard parent types.
    if new_folder is None and hasattr(parent_object, 'create_object'):
        FOLDER_TYPE_UUID = '85d1215e-6520-4983-9a55-2d39d1f24cb4'
        try:
            print("DEBUG: Trying parent.create_object(typeUuid=%s, name='%s')" % (FOLDER_TYPE_UUID, FOLDER_NAME))
            new_folder = parent_object.create_object(typeUuid=FOLDER_TYPE_UUID, name=FOLDER_NAME)
        except Exception as e:
            print("WARN: parent.create_object(typeUuid=%s) raised: %s" % (FOLDER_TYPE_UUID, e))
            new_folder = None

    # Strategy 5: types.IecFolder + parent.add (very old API).
    if new_folder is None and hasattr(script_engine, 'types') and hasattr(script_engine.types, 'IecFolder') and hasattr(parent_object, 'add'):
        try:
            print("DEBUG: Trying parent.add(script_engine.types.IecFolder, name='%s')" % FOLDER_NAME)
            new_folder = parent_object.add(script_engine.types.IecFolder, name=FOLDER_NAME)
        except Exception as e:
            print("WARN: parent.add(types.IecFolder) raised: %s" % e)
            new_folder = None

    if new_folder is None:
        raise TypeError(
            "Parent object '%s' of type %s -- folder creation failed for all known strategies: "
            "(1) primary_project.create_folder(name, SV_POU), "
            "(2) parent.create_folder(name), "
            "(3) primary_project.create_folder(name) default view, "
            "(4) parent.create_object(typeUuid='85d1215e-...'), "
            "(5) parent.add(script_engine.types.IecFolder)." % (
                parent_name, type(parent_object).__name__))

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
