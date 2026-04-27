import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveMirrorRoot, MirrorPathFs } from '../../src/mirror-paths';

/**
 * Build a fake fs that knows about a single project dir, what entries it
 * contains, and whether the legacy mcp-mirror/ subdir exists.
 *
 * Why fake fs and not a tmpdir: this lets the tests document the rule by
 * stating exactly which fs calls happen, instead of materialising on disk
 * and racing the OS.
 */
function makeFakeFs(opts: {
  projectDir: string;
  entries: string[];
  mcpMirrorExists: boolean;
}): MirrorPathFs {
  const legacyMirror = path.join(opts.projectDir, 'mcp-mirror');
  return {
    existsSync: (p: string) => p === legacyMirror && opts.mcpMirrorExists,
    statSync: (p: string) => {
      if (p === legacyMirror && opts.mcpMirrorExists) {
        return { isDirectory: () => true };
      }
      throw new Error(`unexpected statSync(${p})`);
    },
    readdirSync: (p: string) => {
      if (p === opts.projectDir) return opts.entries;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
}

describe('resolveMirrorRoot', () => {
  it('rule 1: existing mcp-mirror/ wins regardless of .project sibling count', () => {
    const projectDir = 'C:\\projects\\Multi';
    const fakeFs = makeFakeFs({
      projectDir,
      entries: ['A.project', 'B.project', 'mcp-mirror'],
      mcpMirrorExists: true,
    });
    const out = resolveMirrorRoot(path.join(projectDir, 'A.project'), fakeFs);
    expect(out).toBe(path.join(projectDir, 'mcp-mirror'));
  });

  it('rule 1 also applies on a single-project parent with an existing mirror', () => {
    const projectDir = 'C:\\projects\\Solo';
    const fakeFs = makeFakeFs({
      projectDir,
      entries: ['Solo.project', 'mcp-mirror', 'README.md'],
      mcpMirrorExists: true,
    });
    const out = resolveMirrorRoot(path.join(projectDir, 'Solo.project'), fakeFs);
    expect(out).toBe(path.join(projectDir, 'mcp-mirror'));
  });

  it('rule 2: single .project sibling + no existing mirror -> legacy mcp-mirror path', () => {
    const projectDir = 'C:\\projects\\NewSolo';
    const fakeFs = makeFakeFs({
      projectDir,
      entries: ['NewSolo.project', 'README.md'],
      mcpMirrorExists: false,
    });
    const out = resolveMirrorRoot(path.join(projectDir, 'NewSolo.project'), fakeFs);
    expect(out).toBe(path.join(projectDir, 'mcp-mirror'));
  });

  it('rule 3: multiple .project siblings + no existing mirror -> per-project name', () => {
    const projectDir = 'C:\\projects\\MultiNew';
    const fakeFs = makeFakeFs({
      projectDir,
      entries: ['ProjectA.project', 'ProjectB.project', 'README.md'],
      mcpMirrorExists: false,
    });
    const outA = resolveMirrorRoot(path.join(projectDir, 'ProjectA.project'), fakeFs);
    const outB = resolveMirrorRoot(path.join(projectDir, 'ProjectB.project'), fakeFs);
    expect(outA).toBe(path.join(projectDir, 'ProjectA_mcp_mirror'));
    expect(outB).toBe(path.join(projectDir, 'ProjectB_mcp_mirror'));
    expect(outA).not.toBe(outB);
  });

  it('treats .PROJECT (uppercase) as a .project sibling on case-insensitive Windows', () => {
    const projectDir = 'C:\\projects\\MixedCase';
    const fakeFs = makeFakeFs({
      projectDir,
      entries: ['Foo.project', 'Bar.PROJECT'],
      mcpMirrorExists: false,
    });
    const out = resolveMirrorRoot(path.join(projectDir, 'Foo.project'), fakeFs);
    expect(out).toBe(path.join(projectDir, 'Foo_mcp_mirror'));
  });

  it('falls back to legacy path when readdirSync throws (perms / network blip)', () => {
    const projectDir = 'C:\\projects\\Unreadable';
    const fakeFs: MirrorPathFs = {
      existsSync: () => false,
      statSync: () => { throw new Error('not called'); },
      readdirSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    };
    const out = resolveMirrorRoot(path.join(projectDir, 'X.project'), fakeFs);
    expect(out).toBe(path.join(projectDir, 'mcp-mirror'));
  });

  it('strips .project suffix correctly when computing per-project basename', () => {
    const projectDir = 'C:\\projects\\Multi';
    const fakeFs = makeFakeFs({
      projectDir,
      entries: ['my.weird.project', 'other.project'],
      mcpMirrorExists: false,
    });
    const out = resolveMirrorRoot(path.join(projectDir, 'my.weird.project'), fakeFs);
    // path.basename(p, '.project') strips only the trailing extension.
    expect(out).toBe(path.join(projectDir, 'my.weird_mcp_mirror'));
  });
});
