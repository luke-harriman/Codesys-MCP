import sys, scriptengine as script_engine, traceback

REMOTE_NAME = "{REMOTE_NAME}"
BRANCH_NAME = "{BRANCH_NAME}"  # may be empty -> defaults to current branch

try:
    print("DEBUG: git_branch_set_upstream_to: Project='%s', Remote='%s', Branch='%s'" % (
        PROJECT_FILE_PATH, REMOTE_NAME, BRANCH_NAME))

    if not REMOTE_NAME.strip():
        raise ValueError("Remote name is empty.")

    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    git = getattr(primary_project, 'git', None)
    if git is None:
        raise RuntimeError(
            "Project '%s' is not bound to a Git repository (primary_project.git "
            "is None). Run git_init first." % PROJECT_FILE_PATH)

    if not hasattr(git, 'branch_set_upstream_to'):
        attrs = sorted([a for a in dir(git) if not a.startswith('_')])
        raise AttributeError(
            "project.git does not expose branch_set_upstream_to(). "
            "Available: %s" % attrs)

    if BRANCH_NAME:
        print("DEBUG: calling git.branch_set_upstream_to('%s', '%s')" % (
            REMOTE_NAME, BRANCH_NAME))
        git.branch_set_upstream_to(REMOTE_NAME, BRANCH_NAME)
    else:
        print("DEBUG: calling git.branch_set_upstream_to('%s') -- defaults to current branch" % REMOTE_NAME)
        git.branch_set_upstream_to(REMOTE_NAME)
    print("DEBUG: branch_set_upstream_to returned without exception.")

    # Per helpme-codesys.com Git scripting docs: persist project state after
    # tracking-config changes. Soft-fail (git op already succeeded).
    try:
        primary_project.save()
        print("DEBUG: project.save() succeeded after branch_set_upstream_to.")
    except Exception as save_e:
        print("WARNING: project.save() after branch_set_upstream_to raised: %s -- tracking config may not persist across IDE sessions." % save_e)

    current = "?"
    if hasattr(git, 'branch_show_current'):
        try:
            current = str(git.branch_show_current())
        except Exception:
            pass

    if BRANCH_NAME:
        print("Branch '%s' now tracks upstream '%s'" % (BRANCH_NAME, REMOTE_NAME))
    else:
        print("Current branch '%s' now tracks upstream '%s'" % (current, REMOTE_NAME))
    print("SCRIPT_SUCCESS: git_branch_set_upstream_to complete.")
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
        msg = "Error in git_branch_set_upstream_to for project '%s': %s\n%s" % (
            PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
