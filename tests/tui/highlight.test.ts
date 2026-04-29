import { describe, it, expect } from 'vitest';
import { tokenize, tokenizeLines, TokenKind } from '../../src/tui/browser/highlight';

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

describe('tokenizeLines', () => {
  it('treats every line of a multi-line (* ... *) block as comment', () => {
    const lines = [
      'x := 1; (* start',
      '  middle keep PROGRAM unhighlighted',
      '  still in comment',
      'end *) y := 2;',
    ];
    const out = tokenizeLines(lines);
    // line 0: leading "x := 1; " is text/keyword-free, then "(* start" is comment
    expect(out[0].some((t) => t.kind === 'comment' && t.text.includes('(* start'))).toBe(true);
    // line 1: ENTIRE line should be a single comment token
    expect(out[1]).toEqual([{ kind: 'comment', text: '  middle keep PROGRAM unhighlighted' }]);
    // line 2: ENTIRE line is comment
    expect(out[2]).toEqual([{ kind: 'comment', text: '  still in comment' }]);
    // line 3: starts comment, then `*) y := 2;` is text after close
    expect(out[3].some((t) => t.kind === 'comment' && t.text.startsWith('end *)'))).toBe(true);
    expect(out[3].some((t) => t.kind === 'text' && t.text.includes('y := 2'))).toBe(true);
  });

  it('handles single-line input identically to tokenize', () => {
    const single = 'PROGRAM PLC_PRG';
    expect(tokenizeLines([single])).toEqual([tokenize(single)]);
  });

  it('keeps PROGRAM keyword highlighted on a line with no open block', () => {
    const lines = ['PROGRAM A', '(* block *) END_PROGRAM'];
    const out = tokenizeLines(lines);
    expect(out[0].find((t) => t.text === 'PROGRAM')?.kind).toBe('keyword');
    expect(out[1].find((t) => t.text === 'END_PROGRAM')?.kind).toBe('keyword');
  });
});
