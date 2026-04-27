import sys, scriptengine as script_engine, os, traceback, codecs

# Mirrors the CODESYS project tree into a filesystem layout under MIRROR_ROOT
# so the project becomes browseable / diffable / AI-editable as plain text.
#
#  - Structural nodes (Device, Application, Folder, ...) become directories.
#  - Code-bearing nodes (Program, FB, Function, Method, Property, DUT, GVL,
#    Interface, ...) become .st files in their parent directory.
#  - If a code-bearing node has child code objects (e.g. an FB with methods)
#    those children land in a sibling subdirectory with the parent's name.
#  - Filesystem-illegal characters in CODESYS object names are replaced with
#    '_'; the original CODESYS project path is recorded as a header comment
#    in each file so a future write-back tool can map it back to set_pou_code's
#    pouPath.
#
# Phase 1: read-only export. No write-back here.

MIRROR_ROOT = r"{MIRROR_ROOT}"
ILLEGAL = '<>:"|?*'


def resolve_mirror_root(project_file_path):
    """Default mirror dir when the TS caller passes MIRROR_ROOT=''.

    Mirrors src/mirror-paths.ts resolveMirrorRoot() verbatim so the CODESYS-
    side script and the Node side agree on the same path. WHY a per-project
    fallback at all: when two .project files share a parent dir, both used to
    default to <projectDir>/mcp-mirror/ and clobber each other's exports
    (and worse, release_project_version's git-tag history mis-attributes
    commits). Existing single-project setups keep the legacy mcp-mirror/
    path so v* tag history stays valid.
    """
    project_dir = os.path.dirname(project_file_path)
    legacy = os.path.join(project_dir, 'mcp-mirror')
    # Rule 1: existing mcp-mirror/ wins, regardless of how many .project
    # siblings sit beside it. Preserves git history on every project ever
    # mirrored before this fix landed.
    try:
        if os.path.isdir(legacy):
            return legacy
    except Exception:
        pass
    # Rules 2 + 3: count .project siblings. <=1 = legacy path, multiple =
    # per-project naming.
    siblings = 0
    try:
        for entry in os.listdir(project_dir):
            if entry.lower().endswith('.project'):
                siblings += 1
    except Exception:
        # Project dir unreadable (network share blip, perms). Default to
        # legacy so we don't surprise anyone with a new path on transient
        # failure.
        return legacy
    if siblings <= 1:
        return legacy
    base = os.path.basename(project_file_path)
    if base.lower().endswith('.project'):
        base = base[:-len('.project')]
    return os.path.join(project_dir, base + '_mcp_mirror')


def sanitise(name):
    s = (name or '').replace('/', '_').replace('\\', '_')
    for c in ILLEGAL:
        s = s.replace(c, '_')
    s = s.strip().rstrip('.')
    return s if s else '_unnamed_'


def _strip_leading_noise(decl):
    """Drop leading whitespace, // and (* *) comments, and {attribute := ''}
    pragmas so the kind classifier matches the actual IEC keyword."""
    s = decl
    changed = True
    while changed:
        changed = False
        s2 = s.lstrip()
        if s2 != s:
            s = s2
            changed = True
        if s.startswith('//'):
            nl = s.find('\n')
            s = s[nl + 1:] if nl >= 0 else ''
            changed = True
            continue
        if s.startswith('(*'):
            end = s.find('*)')
            s = s[end + 2:] if end >= 0 else ''
            changed = True
            continue
        if s.startswith('{'):
            end = s.find('}')
            s = s[end + 1:] if end >= 0 else ''
            changed = True
            continue
    return s


def classify(decl):
    if not decl:
        return 'UNKNOWN'
    head = _strip_leading_noise(decl).upper()
    if head.startswith('TYPE'):
        return 'DUT'
    if head.startswith('VAR_GLOBAL'):
        return 'GVL'
    if head.startswith('PROGRAM'):
        return 'PROGRAM'
    if head.startswith('FUNCTION_BLOCK'):
        return 'FB'
    if head.startswith('FUNCTION'):
        return 'FUNCTION'
    if head.startswith('METHOD'):
        return 'METHOD'
    if head.startswith('PROPERTY'):
        return 'PROPERTY'
    if head.startswith('INTERFACE'):
        return 'INTERFACE'
    return 'OTHER'


def get_text(obj, attr):
    if not hasattr(obj, attr):
        return ''
    try:
        x = getattr(obj, attr)
        if x and hasattr(x, 'text'):
            return x.text or ''
    except Exception:
        pass
    return ''


def write_one(parent_dir, name, decl, impl, project_path):
    if not os.path.exists(parent_dir):
        os.makedirs(parent_dir)
    kind = classify(decl)
    fname = sanitise(name) + '.st'
    fpath = os.path.join(parent_dir, fname)

    lines = []
    lines.append(u'(* === CODESYS export -- %s === *)' % kind)
    lines.append(u'(* Project path: %s *)' % project_path)
    # NOTE: deliberately NO 'Generated: <timestamp>' line. Including a
    # wall-clock time in the file content meant every mirror_export run
    # produced byte-different output even when the underlying CODESYS code
    # was unchanged -- which broke the auto-classifier in
    # release_project_version (it diffed mcp-mirror/ against the latest v*
    # tag and saw every file as M, triggering phantom releases).
    # The git commit history is the source of truth for when each file
    # changed; the in-file timestamp was redundant.
    lines.append(u'')
    if decl:
        lines.append(decl.rstrip())
        lines.append(u'')
    if impl:
        if decl:
            lines.append(u'(* ============ IMPLEMENTATION ============ *)')
            lines.append(u'')
        lines.append(impl.rstrip())
        lines.append(u'')

    # UTF-8 because CODESYS POU text occasionally contains non-ASCII (smart
    # quotes, degree signs, etc.). IronPython 2.7's builtin open() defaults to
    # ASCII and would raise.
    f = codecs.open(fpath, 'w', encoding='utf-8')
    try:
        f.write(u'\n'.join(unicode(l) for l in lines))
    finally:
        f.close()
    return fpath, kind, os.path.getsize(fpath)


def walk(node, parent_fs_dir, parent_proj_path, stats):
    try:
        gn = getattr(node, 'get_name', None)
        name = gn() if gn else '?'
    except Exception:
        name = '?'
    safe_name = sanitise(name)
    proj_path = (parent_proj_path + '/' + name) if parent_proj_path else name

    decl = get_text(node, 'textual_declaration')
    impl = get_text(node, 'textual_implementation')

    if decl or impl:
        try:
            fpath, kind, size = write_one(parent_fs_dir, name, decl, impl, proj_path)
            stats['files'].append({'path': fpath, 'project_path': proj_path, 'kind': kind, 'bytes': size})
        except Exception as e:
            stats['errors'].append({'project_path': proj_path, 'error': str(e)})

    new_dir = os.path.join(parent_fs_dir, safe_name)
    try:
        children = list(node.get_children(False))
    except Exception:
        children = []
    if children:
        if not os.path.exists(new_dir):
            try:
                os.makedirs(new_dir)
                stats['dirs_created'] += 1
            except Exception as e:
                stats['errors'].append({'project_path': proj_path, 'error': 'mkdir: %s' % e})
                return
        for c in children:
            walk(c, new_dir, proj_path, stats)


try:
    # Empty MIRROR_ROOT means "use the default" -- the TS auto-mirror caller
    # passes '' so the resolution stays in one place. Resolve here via the
    # same rule as src/mirror-paths.ts so the CODESYS-side and Node-side
    # defaults agree (legacy mcp-mirror/ if present or single-project parent;
    # <basename>_mcp_mirror/ when multiple .project files share the dir).
    if not MIRROR_ROOT.strip():
        MIRROR_ROOT = resolve_mirror_root(PROJECT_FILE_PATH)
    print("DEBUG: mirror_export: Project='%s' MirrorRoot='%s'" % (PROJECT_FILE_PATH, MIRROR_ROOT))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    if not os.path.exists(MIRROR_ROOT):
        os.makedirs(MIRROR_ROOT)

    stats = {'files': [], 'dirs_created': 0, 'errors': []}

    for child in primary_project.get_children(False):
        walk(child, MIRROR_ROOT, '', stats)

    by_kind = {}
    total_bytes = 0
    for entry in stats['files']:
        by_kind[entry['kind']] = by_kind.get(entry['kind'], 0) + 1
        total_bytes += entry['bytes']

    print("--- Mirror summary ---")
    print("Files written:    %d" % len(stats['files']))
    print("Directories made: %d" % stats['dirs_created'])
    print("Total bytes:      %d" % total_bytes)
    print("By kind:")
    for k in sorted(by_kind.keys()):
        print("  %-10s %d" % (k, by_kind[k]))
    if stats['errors']:
        print("Errors: %d" % len(stats['errors']))
        for er in stats['errors'][:10]:
            print("  %s -> %s" % (er.get('project_path', '?'), er.get('error', '?')))
    print("SCRIPT_SUCCESS: mirror exported to %s" % MIRROR_ROOT)
    sys.exit(0)
except Exception as e:
    msg = "Error in mirror_export for project '%s': %s\n%s" % (
        PROJECT_FILE_PATH, e, traceback.format_exc())
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
