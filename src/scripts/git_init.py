import sys, scriptengine as script_engine, os, traceback

LOCAL_REPO_PATH = r"{LOCAL_REPO_PATH}"

try:
    print("DEBUG: git_init: Project='%s', LocalRepoPath='%s'" % (
        PROJECT_FILE_PATH, LOCAL_REPO_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    if not hasattr(script_engine, 'git'):
        raise RuntimeError(
            "CODESYS Git plug-in is not available (scriptengine.git not "
            "found). Install the Git package via the CODESYS Installer.")

    git = getattr(primary_project, 'git', None)
    if git is None:
        raise RuntimeError(
            "primary_project.git is None; the Git plug-in is loaded but "
            "the project does not yet have a git binding. The init() "
            "call below should establish one if a repo path is supplied.")

    # CODESYS Git uses a dual-storage model: the .project file stays where it
    # is, the git working tree lives in a SEPARATE empty directory. Pointing
    # init() at the project's own folder fails with "DirectoryNotEmpty", and
    # passing nothing previously dumped the user into that trap. Default to a
    # '<project_basename>_git' sibling and auto-create it; verify it is empty
    # before handing off to CODESYS so we surface a clear hint instead of
    # CODESYS's lower-level error.
    project_dir = os.path.dirname(PROJECT_FILE_PATH)
    project_stem = os.path.splitext(os.path.basename(PROJECT_FILE_PATH))[0]
    if not LOCAL_REPO_PATH or os.path.normcase(os.path.abspath(LOCAL_REPO_PATH)) == os.path.normcase(os.path.abspath(project_dir)):
        if LOCAL_REPO_PATH:
            print("DEBUG: requested LocalRepoPath equals the project dir; "
                  "rerouting to a sibling because CODESYS Git requires a separate empty dir.")
        # Use a sibling so we don't write into the (likely shared) project folder
        LOCAL_REPO_PATH = os.path.join(os.path.dirname(project_dir), project_stem + "_git")
        print("DEBUG: defaulted LocalRepoPath to '%s'" % LOCAL_REPO_PATH)

    if not os.path.exists(LOCAL_REPO_PATH):
        print("DEBUG: creating LocalRepoPath '%s'" % LOCAL_REPO_PATH)
        os.makedirs(LOCAL_REPO_PATH)
    elif not os.path.isdir(LOCAL_REPO_PATH):
        raise RuntimeError(
            "LocalRepoPath '%s' exists but is not a directory." % LOCAL_REPO_PATH)
    else:
        existing = os.listdir(LOCAL_REPO_PATH)
        if existing:
            raise RuntimeError(
                "LocalRepoPath '%s' is not empty (contains %d entries: %s). "
                "CODESYS Git's dual-storage model requires a fresh empty "
                "directory separate from the project's own folder. Either "
                "pass a different localRepoPath or empty this one, then "
                "retry git_init." % (
                    LOCAL_REPO_PATH, len(existing), existing[:5]))

    print("DEBUG: calling git.init('%s')" % LOCAL_REPO_PATH)
    git.init(LOCAL_REPO_PATH)
    print("DEBUG: init returned without exception.")

    # Persist the new git binding to the .project file. Per the helpme-codesys.com
    # Git scripting page, project.save() is required after mutating git ops to
    # avoid losing the binding/state when the project is closed. Soft-fail: the
    # git op already succeeded, so a save error is logged but not raised.
    try:
        primary_project.save()
        print("DEBUG: project.save() succeeded after init.")
    except Exception as save_e:
        print("WARNING: project.save() after init raised: %s -- git binding may not persist across IDE sessions." % save_e)

    # Re-read the binding to pick up the now-existing repo
    git = getattr(primary_project, 'git', None)
    branch = "?"
    if git is not None and hasattr(git, 'branch_show_current'):
        try:
            branch = str(git.branch_show_current())
        except Exception as e:
            print("DEBUG: branch_show_current after init failed: %s" % e)

    print("Initialised git repo at: %s" % LOCAL_REPO_PATH)
    print("Current branch: %s" % branch)
    print("SCRIPT_SUCCESS: git_init complete.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    raw = "%s" % e
    if 'HasGitLicense' in raw or 'HasGitLicense' in detailed:
        msg = (
            "CODESYS Git scripting requires an active CODESYS Professional "
            "Developer Edition subscription license. The plug-in is installed "
            "but the runtime 'HasGitLicense' rule returned False, so every "
            "project.git.* operation (init/commit/status/...) is gated. "
            "Activate a Professional Developer Edition subscription on this "
            "CODESYS install (see https://store.codesys.com/en/codesys-git.html, "
            "sections 'Additional Requirements' and 'Licensing'). Underlying "
            "error from CODESYS: %s" % e
        )
    else:
        msg = "Error in git_init for project '%s': %s\n%s" % (
            PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
