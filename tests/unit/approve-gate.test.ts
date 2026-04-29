import { describe, it, expect } from 'vitest';
import { composeMergedContent, IMPL_SENTINEL } from '../../src/approve-gate';

const existing = [
  'PROGRAM PLC_PRG',
  'VAR',
  '  counter : INT := 0;',
  'END_VAR',
  IMPL_SENTINEL,
  'counter := counter + 1;',
].join('\n');

describe('composeMergedContent', () => {
  it('overrides only declaration when only declarationCode is provided', () => {
    const out = composeMergedContent(existing, {
      declarationCode: 'PROGRAM PLC_PRG\nVAR\n  counter : DINT := 0;\nEND_VAR',
      implementationCode: undefined,
    });
    expect(out).toContain('counter : DINT := 0;');
    expect(out).toContain('counter := counter + 1;');
  });

  it('overrides only implementation when only implementationCode is provided', () => {
    const out = composeMergedContent(existing, {
      declarationCode: undefined,
      implementationCode: 'counter := counter + 2;',
    });
    expect(out).toContain('counter : INT := 0;');
    expect(out).toContain('counter := counter + 2;');
  });

  it('overrides both when both are provided', () => {
    const out = composeMergedContent(existing, {
      declarationCode: 'PROGRAM X\nVAR\nEND_VAR',
      implementationCode: 'x := 1;',
    });
    expect(out).toBe(['PROGRAM X', 'VAR', 'END_VAR', IMPL_SENTINEL, 'x := 1;'].join('\n'));
  });

  it('handles existing files with no sentinel by appending one', () => {
    const noSentinel = 'PROGRAM PLC_PRG\nVAR\nEND_VAR';
    const out = composeMergedContent(noSentinel, {
      declarationCode: undefined,
      implementationCode: 'x := 1;',
    });
    expect(out).toContain(IMPL_SENTINEL);
    expect(out).toContain('x := 1;');
  });
});
