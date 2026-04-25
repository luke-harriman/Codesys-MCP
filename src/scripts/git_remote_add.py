import sys, scriptengine as script_engine, traceback

REMOTE_NAME = "{REMOTE_NAME}"
REMOTE_URL = "{REMOTE_URL}"

try:
    print("DEBUG: git_remote_add: Project='%s', Name='%s', URL='%s'" % (
        PROJECT_FILE_PATH, REMOTE_NAME, REMOTE_URL))

    if not REMOTE_NAME.strip():
        raise ValueError("Remote name is empty.")
    if not REMOTE_URL.strip():
        raise ValueError("Remote URL is empty.")

    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    git = getattr(primary_project, 'git', None)
    if git is None:
        raise RuntimeError(
            "Project '%s' is not bound to a Git repository (primary_project.git "
            "is None). Run git_init first." % PROJECT_FILE_PATH)

    if not hasattr(git, 'remote_add'):
        attrs = sorted([a for a in dir(git) if not a.startswith('_')])
        raise AttributeError(
            "project.git does not expose remote_add(). Available: %s" % attrs)

    print("DEBUG: calling git.remote_add('%s', '%s')" % (REMOTE_NAME, REMOTE_URL))
    git.remote_add(REMOTE_NAME, REMOTE_URL)
    print("DEBUG: remote_add returned without exception.")

    print("Added remote '%s' -> %s" % (REMOTE_NAME, REMOTE_URL))
    print("SCRIPT_SUCCESS: git_remote_add complete.")
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
        msg = "Error in git_remote_add for project '%s': %s\n%s" % (
            PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
