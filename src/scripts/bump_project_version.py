import sys, scriptengine as script_engine, traceback

# Bumps one part of the 4-part Project Information.version field of the
# primary project. Convention (per CODESYS / 3S / WAGO library practice):
#
#   Major     -- bump on incompatible API break.
#   Minor     -- bump on backward-compatible feature add.
#   Revision  -- bump on bug fix only (no API change).
#   Build     -- internal counter, often 0 for hand-released versions.
#
# Bumping a higher part resets all lower parts to 0 (e.g. bumping minor
# resets revision and build).
#
# The Version field is read/written as a property on the "Project
# Information" node (first child of the primary project). IronPython
# coerces strings like "1.2.3.4" to System.Version automatically; we
# stringify on the read side because str(System.Version) gives
# the dotted form back. None / empty are treated as "0.0.0.0".

LEVEL = "{LEVEL}"  # major | minor | revision | build

VALID_LEVELS = ('major', 'minor', 'revision', 'build')

# Standard runtime-readable version anchor. Lives as a constant in a GVL
# under Application so any IEC code can read it as
# _MCP_PROJECT_VERSION.sVersion, and a future read_running_version_online
# tool can pull it via online connect + read_variable. Kept as
# qualified_only so it can't accidentally shadow a same-named local.
VERSION_GVL_NAME = '_MCP_PROJECT_VERSION'
VERSION_GVL_DECLARATION_TEMPLATE = (
    "{attribute 'qualified_only'}\n"
    "VAR_GLOBAL CONSTANT\n"
    "    sVersion : STRING := '%s';\n"
    "END_VAR\n"
)


def parse_version(v):
    """Parse a version-like value into a 4-tuple of ints, defaulting missing
    parts to 0. Accepts None, '', '1.2', '1.2.3', '1.2.3.4', or a
    System.Version. Raises ValueError on anything that can't be parsed."""
    if v is None:
        return (0, 0, 0, 0)
    s = str(v).strip()
    if not s or s == 'None':
        return (0, 0, 0, 0)
    parts = s.split('.')
    if len(parts) > 4:
        raise ValueError("version '%s' has more than 4 parts" % s)
    nums = []
    for p in parts:
        try:
            nums.append(int(p))
        except ValueError:
            raise ValueError("version '%s' has non-integer part '%s'" % (s, p))
    while len(nums) < 4:
        nums.append(0)
    return tuple(nums)


def maintain_version_gvl(primary_project, version_str):
    """Find or create the _MCP_PROJECT_VERSION GVL under the active
    Application, and set its declaration so the running PLC carries the
    project version as a constant string. Soft-fails on any error -- the
    primary outcome of the bump (Project Information.Version) has already
    succeeded by the time this is called, so a GVL creation failure is
    logged as a WARNING but does not fail the whole tool."""
    try:
        app = getattr(primary_project, 'active_application', None)
    except Exception:
        app = None
    if app is None:
        try:
            apps = primary_project.find('Application', True)
            if apps:
                app = apps[0]
        except Exception:
            pass
    if app is None:
        print("WARNING: no active Application found -- cannot maintain %s GVL" % VERSION_GVL_NAME)
        return False

    decl = VERSION_GVL_DECLARATION_TEMPLATE % version_str

    # Try to find existing GVL with this name
    existing = None
    try:
        for child in app.get_children(False):
            try:
                if child.get_name() == VERSION_GVL_NAME:
                    existing = child
                    break
            except Exception:
                pass
    except Exception as e:
        print("WARNING: walking Application children failed: %s" % e)

    if existing is not None:
        try:
            existing.textual_declaration.replace(decl)
            print("DEBUG: updated %s -> sVersion := '%s'" % (VERSION_GVL_NAME, version_str))
            return True
        except Exception as e:
            print("WARNING: failed to update existing %s declaration: %s" % (VERSION_GVL_NAME, e))
            return False

    # Create it
    if not hasattr(app, 'create_gvl'):
        print("WARNING: Application object doesn't expose create_gvl -- cannot create %s" % VERSION_GVL_NAME)
        return False
    try:
        new_gvl = app.create_gvl(name=VERSION_GVL_NAME)
        if new_gvl is None:
            print("WARNING: create_gvl returned None for %s" % VERSION_GVL_NAME)
            return False
        new_gvl.textual_declaration.replace(decl)
        print("DEBUG: created %s with sVersion := '%s'" % (VERSION_GVL_NAME, version_str))
        return True
    except Exception as e:
        print("WARNING: failed to create %s: %s" % (VERSION_GVL_NAME, e))
        return False


def bump(parts, level):
    major, minor, revision, build = parts
    if level == 'major':
        return (major + 1, 0, 0, 0)
    if level == 'minor':
        return (major, minor + 1, 0, 0)
    if level == 'revision':
        return (major, minor, revision + 1, 0)
    if level == 'build':
        return (major, minor, revision, build + 1)
    raise ValueError("unknown bump level '%s' (must be one of %s)" % (level, ', '.join(VALID_LEVELS)))


try:
    if LEVEL not in VALID_LEVELS:
        raise ValueError("level must be one of %s, got '%s'" % (', '.join(VALID_LEVELS), LEVEL))

    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    pi = None
    for child in primary_project.get_children(False):
        try:
            if child.get_name() == 'Project Information':
                pi = child
                break
        except Exception:
            pass
    if pi is None:
        raise RuntimeError(
            "Project Information node not found at the project root. "
            "Every CODESYS project should have one as its first child; "
            "if missing, recreate it via Project menu -> Project Information.")

    before_raw = pi.version
    before_str = str(before_raw) if before_raw is not None else None

    # First-run convention: if no version is set yet, seed at 1.0.0.0 instead
    # of treating "no version" as 0.0.0.0 + bump (which would give 0.0.0.1
    # for level=build, awkward for a first canonical version). Most projects
    # start tracking at 1.0.0.0 when they first turn on versioning, and the
    # level argument is moot for the seed step.
    seed_check = parse_version(before_raw)
    if seed_check == (0, 0, 0, 0) and (before_raw is None or str(before_raw).strip() in ('', '0.0.0.0', 'None')):
        after_parts = (1, 0, 0, 0)
        after_str = '1.0.0.0'
        print("DEBUG: bump_project_version: no prior version -- seeding to 1.0.0.0 (level=%s ignored on first run)" % LEVEL)
    else:
        before_parts = seed_check
        after_parts = bump(before_parts, LEVEL)
        after_str = '%d.%d.%d.%d' % after_parts
        print("DEBUG: bump_project_version: level=%s before=%s -> after=%s" % (
            LEVEL, before_str, after_str))

    pi.version = after_str

    # Maintain the runtime-readable version anchor (_MCP_PROJECT_VERSION GVL)
    # so the running PLC carries the same string. Soft-fails so the primary
    # bump still reports success even if GVL creation hits an edge case.
    gvl_ok = maintain_version_gvl(primary_project, after_str)

    try:
        primary_project.save()
        print("DEBUG: project.save() succeeded after version bump.")
    except Exception as save_e:
        print("WARNING: project.save() raised %s -- bump applied in memory but may not persist across IDE close." % save_e)

    print("Project Information.Version: %s -> %s" % (before_str, after_str))
    if gvl_ok:
        print("Runtime anchor: %s.sVersion := '%s'" % (VERSION_GVL_NAME, after_str))
    else:
        print("Runtime anchor: %s NOT updated (see WARNING above)" % VERSION_GVL_NAME)
    print("SCRIPT_SUCCESS: bump_project_version complete.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in bump_project_version for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
