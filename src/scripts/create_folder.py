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

    # Create the folder. The keyword changed between docs and stubs:
    # Per the SP22 stub Stubs/scriptengine/ScriptObject.pyi, the signature is
    #     def create_folder(self, foldername): ...
    # NOT `name=...` (which the original fork code used and got
    # "create_folder() got an unexpected keyword argument 'name'" against
    # SP22). Use the positional form first to be agnostic to the keyword
    # name across SP releases. Fall through to alternate factories if
    # create_folder is unavailable on the parent at all.
    new_folder = None
    if hasattr(parent_object, 'create_folder'):
        try:
            print("DEBUG: Calling parent.create_folder('%s') [positional]" % FOLDER_NAME)
            new_folder = parent_object.create_folder(FOLDER_NAME)
        except Exception as e:
            print("WARN: parent.create_folder('%s') raised: %s -- trying foldername= kwarg." % (FOLDER_NAME, e))
            try:
                new_folder = parent_object.create_folder(foldername=FOLDER_NAME)
            except Exception as e2:
                print("WARN: parent.create_folder(foldername='%s') raised: %s -- trying alternate factories." % (FOLDER_NAME, e2))
                new_folder = None

    if new_folder is None and hasattr(parent_object, 'create_object'):
        # CODESYS folder type UUID -- documented "generic IEC folder" type.
        # Tried as a fallback for parents that don't expose create_folder.
        FOLDER_TYPE_UUID = '85d1215e-6520-4983-9a55-2d39d1f24cb4'
        try:
            print("DEBUG: parent.create_folder() unavailable. Trying parent.create_object(typeUuid=%s, name='%s')" % (FOLDER_TYPE_UUID, FOLDER_NAME))
            new_folder = parent_object.create_object(typeUuid=FOLDER_TYPE_UUID, name=FOLDER_NAME)
        except Exception as e:
            print("WARN: parent.create_object(typeUuid=%s) raised: %s" % (FOLDER_TYPE_UUID, e))
            new_folder = None

    if new_folder is None and hasattr(script_engine, 'types') and hasattr(script_engine.types, 'IecFolder') and hasattr(parent_object, 'add'):
        try:
            print("DEBUG: Trying parent.add(script_engine.types.IecFolder, name='%s')" % FOLDER_NAME)
            new_folder = parent_object.add(script_engine.types.IecFolder, name=FOLDER_NAME)
        except Exception as e:
            print("WARN: parent.add(types.IecFolder) raised: %s" % e)
            new_folder = None

    if new_folder is None:
        raise TypeError(
            "Parent object '%s' of type %s does not support any known folder-creation factory: "
            "tried create_folder() positional, create_folder(foldername=...), "
            "create_object(typeUuid=...), and add(script_engine.types.IecFolder)." % (
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
