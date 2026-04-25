import sys, scriptengine as script_engine, os, traceback

try:
    print("DEBUG: git_status: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    # The project's git repo is exposed as primary_project.git when the
    # CODESYS Git plug-in is loaded AND the project is in a git working
    # tree. Probe defensively: not every CODESYS install ships Git.
    git = getattr(primary_project, 'git', None)
    if git is None:
        # Fall back to script_engine.git presence to distinguish "Git
        # plug-in missing" from "project not in a repo".
        if not hasattr(script_engine, 'git'):
            raise RuntimeError(
                "CODESYS Git plug-in is not available on this install "
                "(scriptengine.git not found). Install the Git package "
                "via the CODESYS Installer.")
        raise RuntimeError(
            "Project '%s' is not bound to a Git repository. Use git_init "
            "to initialise one, or open a project that is already in a "
            "working tree." % PROJECT_FILE_PATH)

    # Early license probe -- has_working_tree is a cheap, license-gated query
    # per the SP22 stubs (Stubs/scriptengine/GitScriptProject.pyi). Letting a
    # HasGitLicense failure escape here routes through the outer except, which
    # rewrites it into a clear "PDE subscription needed" message instead of
    # being swallowed by the per-method probe loop below.
    if hasattr(git, 'has_working_tree'):
        try:
            git.has_working_tree()
        except Exception as probe_e:
            if 'HasGitLicense' in str(probe_e):
                raise
            print("DEBUG: license probe (has_working_tree) raised non-license error: %s" % probe_e)

    git_attrs = sorted([a for a in dir(git) if not a.startswith('_')])
    print("DEBUG: project.git attributes: %s" % git_attrs)

    # Branch name: documented as branch_show_current().
    branch = "?"
    try:
        if hasattr(git, 'branch_show_current'):
            branch = str(git.branch_show_current())
        elif hasattr(git, 'current_branch'):
            v = git.current_branch
            branch = str(v() if callable(v) else v)
    except Exception as e:
        print("DEBUG: branch lookup failed: %s" % e)

    # Probe for status / diff / changes methods. Doc page didn't specify
    # exact names, so try several. Reports any that returned a value.
    status_lines = []
    for method_name in ('status', 'get_status', 'changes', 'get_changes',
                        'diff', 'get_diff', 'changed_files'):
        if not hasattr(git, method_name):
            continue
        try:
            attr = getattr(git, method_name)
            value = attr() if callable(attr) else attr
            status_lines.append("  %s -> %r" % (method_name, value))
        except Exception as e:
            status_lines.append("  %s -> (raised) %s: %s" % (method_name, type(e).__name__, e))

    print("Project: %s" % os.path.basename(PROJECT_FILE_PATH))
    print("Current branch: %s" % branch)
    if status_lines:
        print("Status probe results:")
        for line in status_lines:
            print(line)
    else:
        print("Status probe results: (none of status/changes/diff/changed_files exposed)")
    print("project.git surface: %s" % git_attrs)

    print("SCRIPT_SUCCESS: git_status reported.")
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
        msg = "Error in git_status for project '%s': %s\n%s" % (
            PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
