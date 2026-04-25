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

    if not LOCAL_REPO_PATH:
        # Default: init a repo in the project's own directory
        LOCAL_REPO_PATH = os.path.dirname(PROJECT_FILE_PATH)

    print("DEBUG: calling git.init('%s')" % LOCAL_REPO_PATH)
    git.init(LOCAL_REPO_PATH)
    print("DEBUG: init returned without exception.")

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
