# -*- coding: utf-8 -*-
# Shared text-encoding helpers for IronPython 2.7 inside CODESYS.
# Prepended to other scripts via ScriptManager.prepareScriptWithHelpers.

def _to_unicode(s):
    """Coerce any byte/str/unicode value to unicode, defensively.

    CODESYS textual fields return bytes in the system's ANSI code page:
    cp1252 on Western European Windows, cp936 (GBK) on Chinese Windows.
    IronPython 2.7's json.dumps with the default ensure_ascii=True invokes
    a defective decode path (py_encode_basestring_ascii calls
    s.decode('utf-8') even on unicode), so callers must serialise with
    ensure_ascii=False AND ensure all string values are unicode.
    """
    if s is None:
        return u""
    if isinstance(s, unicode):
        return s
    try:
        return s.decode('utf-8')
    except UnicodeDecodeError:
        try:
            return s.decode('cp936')       # GBK — Chinese Windows
        except UnicodeDecodeError:
            try:
                return s.decode('cp1252')  # Western European Windows
            except UnicodeDecodeError:
                return s.decode('latin-1', errors='replace')


def _json_default(o):
    """Default for json.dumps: coerce IronPython long ints (and other .NET-
    backed numeric proxies) to plain int, falling back to str. Without this,
    json.dumps raises 'TypeError: ... is not JSON serializable' on the 48-bit
    sentinel values that CODESYS message positions occasionally return.
    """
    try:
        return int(o)
    except Exception:
        try:
            return str(o)
        except Exception:
            return None


def emit_result(payload):
    """Write a structured result block to stdout for Node-side parsing.

    Format: a single fenced JSON block delimited by `### RESULT_JSON ###` and
    `### END_RESULT_JSON ###` markers. Keeps debug prints (everywhere else
    in the script) out of the structured channel. Encodes as utf-8 bytes so
    non-ASCII data round-trips through subprocess stdout under IronPython.
    """
    import json
    import sys
    text = json.dumps(payload, ensure_ascii=False, default=_json_default)
    if isinstance(text, unicode):
        text = text.encode('utf-8')
    sys.stdout.write("### RESULT_JSON ###\n")
    sys.stdout.write(text)
    sys.stdout.write("\n### END_RESULT_JSON ###\n")
    sys.stdout.flush()
