export type TokenKind = 'keyword' | 'type' | 'comment' | 'string' | 'text';

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  'PROGRAM', 'END_PROGRAM',
  'FUNCTION', 'END_FUNCTION',
  'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
  'METHOD', 'END_METHOD',
  'PROPERTY', 'END_PROPERTY',
  'INTERFACE', 'END_INTERFACE',
  'STRUCT', 'END_STRUCT',
  'TYPE', 'END_TYPE',
  'ACTION', 'END_ACTION',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP', 'VAR_CONFIG', 'VAR_EXTERNAL', 'VAR_STAT', 'END_VAR',
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
  'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE',
  'REPEAT', 'UNTIL', 'END_REPEAT',
  'RETURN', 'EXIT', 'CONTINUE',
  'AND', 'OR', 'XOR', 'NOT', 'MOD',
  'TRUE', 'FALSE',
  'CONSTANT', 'RETAIN', 'PERSISTENT', 'ABSTRACT', 'FINAL', 'PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL',
  'EXTENDS', 'IMPLEMENTS', 'GET', 'SET', 'REFERENCE', 'POINTER', 'ARRAY',
  'WITH', 'AT',
  'SUPER', 'THIS',
]);

const TYPES = new Set([
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT',
  'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL',
  'TIME', 'LTIME', 'DATE', 'TIME_OF_DAY', 'TOD', 'LTOD', 'DATE_AND_TIME', 'DT', 'LDT',
  'STRING', 'WSTRING', 'CHAR', 'WCHAR',
  'ANY', 'ANY_BIT', 'ANY_INT', 'ANY_NUM', 'ANY_REAL', 'ANY_STRING',
]);

const IDENT_RE = /[A-Z_][A-Z0-9_]*/;

export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let pending = '';

  const flushPending = () => {
    if (!pending) return;
    // Walk pending and split at every uppercase identifier boundary, so
    // identifiers (whether keyword/type or plain) come out as their own
    // tokens. Anything else (whitespace, punctuation, lowercase ids) is
    // emitted as 'text'.
    const re = /[A-Z_][A-Z0-9_]*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(pending)) !== null) {
      const word = m[0];
      const start = m.index;
      if (start > last) out.push({ kind: 'text', text: pending.slice(last, start) });
      const kind: TokenKind = KEYWORDS.has(word) ? 'keyword' : TYPES.has(word) ? 'type' : 'text';
      out.push({ kind, text: word });
      last = start + word.length;
    }
    if (last < pending.length) out.push({ kind: 'text', text: pending.slice(last) });
    pending = '';
  };

  while (i < line.length) {
    // (* ... *) inline comment
    if (line[i] === '(' && line[i + 1] === '*') {
      flushPending();
      const end = line.indexOf('*)', i + 2);
      if (end < 0) {
        out.push({ kind: 'comment', text: line.slice(i) });
        i = line.length;
      } else {
        out.push({ kind: 'comment', text: line.slice(i, end + 2) });
        i = end + 2;
      }
      continue;
    }
    // // line comment
    if (line[i] === '/' && line[i + 1] === '/') {
      flushPending();
      out.push({ kind: 'comment', text: line.slice(i) });
      i = line.length;
      continue;
    }
    // 'single' or "double" strings (no escape handling beyond doubled quotes)
    if (line[i] === "'" || line[i] === '"') {
      flushPending();
      const quote = line[i];
      let end = i + 1;
      while (end < line.length && line[end] !== quote) end++;
      const close = end < line.length ? end + 1 : end;
      out.push({ kind: 'string', text: line.slice(i, close) });
      i = close;
      continue;
    }
    pending += line[i];
    i++;
  }
  flushPending();
  // Normalize: empty trailing 'text' tokens are fine; we keep them so the line's column structure is preserved.
  return out;
}
