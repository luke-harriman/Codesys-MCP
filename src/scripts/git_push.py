import sys, scriptengine as script_engine, traceback

# Empty strings mean "not provided" -- the script picks the lightest
# overload that matches what's available, falling back to git config /
# Windows Credential Manager / cached creds when no explicit auth is given.
BRANCH_NAME = "{BRANCH_NAME}"
USERNAME = "{USERNAME}"
TOKEN = "{TOKEN}"

try:
    print("DEBUG: git_push: Project='%s', Branch='%s', UsernameProvided=%s, TokenProvided=%s" % (
        PROJECT_FILE_PATH, BRANCH_NAME, bool(USERNAME), bool(TOKEN)))

    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    git = getattr(primary_project, 'git', None)
    if git is None:
        raise RuntimeError(
            "Project '%s' is not bound to a Git repository (primary_project.git "
            "is None). Run git_init first." % PROJECT_FILE_PATH)

    if not hasattr(git, 'push'):
        attrs = sorted([a for a in dir(git) if not a.startswith('_')])
        raise AttributeError(
            "project.git does not expose push(). Available: %s" % attrs)

    use_credentials = bool(USERNAME) and bool(TOKEN)

    if use_credentials:
        # CODESYS Git docs recommend SecureString for password params on push/
        # fetch/pull/clone. Convert here so the plain-text TOKEN doesn't sit in
        # IronPython memory longer than the call needs it.
        from System.Security import SecureString
        sec_token = SecureString()
        for c in TOKEN:
            sec_token.AppendChar(c)

        # The 3-arg push(branchName, username, password) overload requires a
        # branch name. If caller didn't pass one, derive the current branch.
        if not BRANCH_NAME:
            if hasattr(git, 'branch_show_current'):
                try:
                    BRANCH_NAME = str(git.branch_show_current())
                    print("DEBUG: derived current branch -> '%s'" % BRANCH_NAME)
                except Exception as e:
                    raise RuntimeError(
                        "git_push: credentials supplied but no branchName "
                        "given, and could not derive the current branch: %s" % e)

        print("DEBUG: calling git.push('%s', '<username>', <SecureString token>)" % BRANCH_NAME)
        git.push(BRANCH_NAME, USERNAME, sec_token)
    else:
        if BRANCH_NAME:
            print("DEBUG: calling git.push('%s')" % BRANCH_NAME)
            git.push(BRANCH_NAME)
        else:
            print("DEBUG: calling git.push() with no args -- relies on tracked upstream + cached creds")
            git.push()

    print("DEBUG: push returned without exception.")

    branch = "?"
    if hasattr(git, 'branch_show_current'):
        try:
            branch = str(git.branch_show_current())
        except Exception:
            pass

    if BRANCH_NAME:
        print("Pushed branch: %s" % BRANCH_NAME)
    else:
        print("Pushed (current branch: %s)" % branch)
    print("SCRIPT_SUCCESS: git_push complete.")
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
        msg = "Error in git_push for project '%s': %s\n%s" % (
            PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
