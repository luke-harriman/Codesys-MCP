import sys, scriptengine as script_engine, os, traceback, time, codecs

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
    lines.append(u'(* Generated:    %s *)' % time.strftime('%Y-%m-%d %H:%M:%S'))
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
    print("DEBUG: mirror_export: Project='%s' MirrorRoot='%s'" % (PROJECT_FILE_PATH, MIRROR_ROOT))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    if not MIRROR_ROOT.strip():
        raise ValueError("MIRROR_ROOT is empty -- pass mirrorRoot to the tool or rely on the default '<projectDir>/MCP/mirror'.")

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
