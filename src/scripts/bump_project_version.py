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

    try:
        primary_project.save()
        print("DEBUG: project.save() succeeded after version bump.")
    except Exception as save_e:
        print("WARNING: project.save() raised %s -- bump applied in memory but may not persist across IDE close." % save_e)

    print("Project Information.Version: %s -> %s" % (before_str, after_str))
    print("SCRIPT_SUCCESS: bump_project_version complete.")
    sys.exit(0)
except Exception as e:
    detailed = traceback.format_exc()
    msg = "Error in bump_project_version for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, detailed)
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
