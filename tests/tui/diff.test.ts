import { describe, it, expect } from 'vitest';
import { computeHunks } from '../../src/tui/shared/diff.ts';

describe('computeHunks', () => {
  it('returns ctx hunks when both sides are identical', () => {
    const a = 'one\ntwo\nthree';
    const hunks = computeHunks(a, a);
    expect(hunks.every((h) => h.kind === 'ctx')).toBe(true);
    expect(hunks).toHaveLength(3);
  });

  it('marks added lines', () => {
    const a = 'one\ntwo';
    const b = 'one\ntwo\nthree';
    const hunks = computeHunks(a, b);
    const added = hunks.filter((h) => h.kind === 'add');
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe('three');
  });

  it('marks deleted lines', () => {
    const a = 'one\ntwo\nthree';
    const b = 'one\ntwo';
    const hunks = computeHunks(a, b);
    const deleted = hunks.filter((h) => h.kind === 'del');
    expect(deleted).toHaveLength(1);
    expect(deleted[0].text).toBe('three');
  });

  it('handles a substitution as del + add', () => {
    const a = 'a\nb\nc';
    const b = 'a\nB\nc';
    const hunks = computeHunks(a, b);
    expect(hunks.some((h) => h.kind === 'del' && h.text === 'b')).toBe(true);
    expect(hunks.some((h) => h.kind === 'add' && h.text === 'B')).toBe(true);
  });

  it('reports add/ctx line numbers against the new side, del against the old side', () => {
    const a = 'a\nb\nc';
    const b = 'a\nx\nc';
    const hunks = computeHunks(a, b);
    const del = hunks.find((h) => h.kind === 'del')!;
    const add = hunks.find((h) => h.kind === 'add')!;
    expect(del.lineNo).toBe(2);
    expect(add.lineNo).toBe(2);
  });
});
