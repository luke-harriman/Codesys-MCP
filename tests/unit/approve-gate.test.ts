import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import { composeMergedContent, IMPL_SENTINEL, runApproveGateOp } from '../../src/approve-gate';

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

describe('runApproveGateOp', () => {
  it('writes before/after files and spawns the TUI with both paths', async () => {
    const captured: { existing?: string; staged?: string } = {};
    const spawnFn = vi.fn(async (existingPath: string, stagedPath: string) => {
      captured.existing = existingPath;
      captured.staged = stagedPath;
      const oldText = await fs.readFile(existingPath, 'utf8');
      const newText = await fs.readFile(stagedPath, 'utf8');
      expect(oldText).toBe('OLD');
      expect(newText).toBe('NEW');
      return { status: 'accepted' as const };
    });
    const result = await runApproveGateOp({
      slug: 'create-Application/MyFB',
      oldText: 'OLD',
      newText: 'NEW',
      spawnFn,
    });
    expect(result.status).toBe('accepted');
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it('passes the rejected status through', async () => {
    const spawnFn = vi.fn(async () => ({
      status: 'rejected' as const,
      message: 'nope',
    }));
    const result = await runApproveGateOp({
      slug: 'delete-Foo',
      oldText: 'something',
      newText: '',
      spawnFn,
    });
    expect(result.status).toBe('rejected');
  });

  it('cleans up the temp dir after the spawn returns', async () => {
    let dirSeen: string | undefined;
    const spawnFn = vi.fn(async (existingPath: string) => {
      dirSeen = existingPath.replace(/[\\/][^\\/]+$/, '');
      // dir should exist while we're in here
      await fs.access(dirSeen);
      return { status: 'accepted' as const };
    });
    await runApproveGateOp({ slug: 'x', oldText: '', newText: 'Y', spawnFn });
    // After: the dir must be gone
    await expect(fs.access(dirSeen!)).rejects.toThrow();
  });
});
