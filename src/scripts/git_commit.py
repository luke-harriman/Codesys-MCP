import sys, scriptengine as script_engine, os, traceback

COMMIT_MESSAGE = """{COMMIT_MESSAGE}"""
AUTHOR_NAME = "{AUTHOR_NAME}"
AUTHOR_EMAIL = "{AUTHOR_EMAIL}"

try:
    print("DEBUG: git_commit: Project='%s', Author='%s <%s>'" % (
        PROJECT_FILE_PATH, AUTHOR_NAME, AUTHOR_EMAIL))
    print("DEBUG: message (%d chars):" % len(COMMIT_MESSAGE))
    print(COMMIT_MESSAGE)

    if not COMMIT_MESSAGE.strip():
        raise ValueError("Commit message is empty.")
    if not AUTHOR_NAME.strip():
        raise ValueError("Author name is empty.")
    if not AUTHOR_EMAIL.strip():
        raise ValueError("Author email is empty.")

    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    git = getattr(primary_project, 'git', None)
    if git is None:
        raise RuntimeError(
            "Project '%s' is not bound to a Git repository (primary_project.git "
            "is None). Run git_init first." % PROJECT_FILE_PATH)

    if not hasattr(git, 'commit_complete'):
        attrs = sorted([a for a in dir(git) if not a.startswith('_')])
        raise AttributeError(
            "project.git does not expose commit_complete(). "
            "Available attributes: %s" % attrs)

    # commit_complete signature per docs: (message, user, mail).
    # Stages all working-tree changes and commits in one shot.
    print("DEBUG: calling git.commit_complete(message, '%s', '%s')" % (AUTHOR_NAME, AUTHOR_EMAIL))
    git.commit_complete(COMMIT_MESSAGE, AUTHOR_NAME, AUTHOR_EMAIL)
    print("DEBUG: commit_complete returned without exception.")

    # Best-effort: report current branch after commit
    branch = "?"
    if hasattr(git, 'branch_show_current'):
        try:
            branch = str(git.branch_show_current())
        except Exception:
            pass

    print("Committed on branch: %s" % branch)
    print("Author: %s <%s>" % (AUTHOR_NAME, AUTHOR_EMAIL))
    print("SCRIPT_SUCCESS: git_commit complete.")
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
        msg = "Error in git_commit for project '%s': %s\n%s" % (
            PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
