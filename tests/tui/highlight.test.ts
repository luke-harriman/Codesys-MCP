import { describe, it, expect } from 'vitest';
import { tokenize, TokenKind } from '../../src/tui/browser/highlight';

function kinds(line: string): TokenKind[] {
  return tokenize(line).map((t) => t.kind);
}

function texts(line: string): string[] {
  return tokenize(line).map((t) => t.text);
}

describe('tokenize', () => {
  it('returns a single text token for plain identifiers', () => {
    expect(tokenize('foo bar baz')).toEqual([{ kind: 'text', text: 'foo bar baz' }]);
  });

  it('flags ST keywords (uppercase)', () => {
    const ts = tokenize('PROGRAM PLC_PRG');
    expect(ts.find((t) => t.text === 'PROGRAM')?.kind).toBe('keyword');
    expect(ts.find((t) => t.text === 'PLC_PRG')?.kind).toBe('text');
  });

  it('flags END_VAR / END_IF compound keywords', () => {
    const ts = tokenize('END_VAR END_IF END_FOR');
    expect(ts.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual([
      'END_VAR',
      'END_IF',
      'END_FOR',
    ]);
  });

  it('flags IEC types', () => {
    const ts = tokenize('counter : INT := 0;');
    expect(ts.find((t) => t.text === 'INT')?.kind).toBe('type');
  });

  it('does not flag lowercase variants of keywords', () => {
    const ts = tokenize('program plc_prg');
    expect(ts.every((t) => t.kind !== 'keyword')).toBe(true);
  });

  it('captures (* ... *) comments inline', () => {
    expect(kinds('x := 1; (* a comment *) y := 2;')).toContain('comment');
    expect(texts('x := 1; (* a comment *) y := 2;')).toContain('(* a comment *)');
  });

  it('captures // line comments to end of line', () => {
    const ts = tokenize('x := 1; // trailing');
    expect(ts.at(-1)?.kind).toBe('comment');
    expect(ts.at(-1)?.text).toBe('// trailing');
  });

  it("captures 'single-quoted' and \"double-quoted\" strings", () => {
    expect(texts("s := 'hello';")).toContain("'hello'");
    expect(texts('s := "hi";')).toContain('"hi"');
  });
});
