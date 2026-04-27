import { describe, it, expect } from 'vitest';
import { detectInstalls, printConfig, CodesysInstall } from '../../src/detect';

function makeFakeFs(installDirs: { base: string; entries: string[]; existsExe: (p: string) => boolean }[]) {
  return {
    readdirSync: ((dir: string) => {
      const match = installDirs.find((d) => d.base === dir);
      if (!match) {
        const err: NodeJS.ErrnoException = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return match.entries;
    }) as unknown as typeof import('fs').readdirSync,
    existsSync: ((p: string | Buffer | URL) => {
      const s = String(p);
      for (const d of installDirs) {
        if (d.existsExe(s)) return true;
      }
      return false;
    }) as typeof import('fs').existsSync,
  };
}

describe('detectInstalls', () => {
  it('parses 3.5.21.50 -> SP21 Patch 5 with derived names', () => {
    const fakeFs = makeFakeFs([
      {
        base: 'C:\\Program Files',
        entries: ['CODESYS 3.5.21.50', 'Some Other App'],
        existsExe: (p) => p.toLowerCase().includes('codesys 3.5.21.50') && p.endsWith('CODESYS.exe'),
      },
    ]);
    const installs = detectInstalls(['C:\\Program Files'], fakeFs);
    expect(installs).toHaveLength(1);
    expect(installs[0].sp).toBe(21);
    expect(installs[0].patch).toBe(5);
    expect(installs[0].profileName).toBe('CODESYS V3.5 SP21 Patch 5');
    expect(installs[0].serverName).toBe('codesys-sp21-patch5');
  });

  it('omits Patch suffix when raw patch is 0', () => {
    const fakeFs = makeFakeFs([
      {
        base: 'C:\\Program Files',
        entries: ['CODESYS 3.5.21.0'],
        existsExe: (p) => p.endsWith('CODESYS.exe'),
      },
    ]);
    const installs = detectInstalls(['C:\\Program Files'], fakeFs);
    expect(installs).toHaveLength(1);
    expect(installs[0].profileName).toBe('CODESYS V3.5 SP21');
    expect(installs[0].serverName).toBe('codesys-sp21');
  });

  it('skips dirs that do not match CODESYS X.Y.Z.W pattern', () => {
    const fakeFs = makeFakeFs([
      {
        base: 'C:\\Program Files (x86)',
        entries: ['CODESYS', 'CODESYS Old', 'CODESYS 3.5'],
        existsExe: (p) => p.endsWith('CODESYS.exe'),
      },
    ]);
    const installs = detectInstalls(['C:\\Program Files (x86)'], fakeFs);
    expect(installs).toHaveLength(0);
  });

  it('skips dirs where the exe is missing', () => {
    const fakeFs = makeFakeFs([
      {
        base: 'C:\\Program Files',
        entries: ['CODESYS 3.5.21.50', 'CODESYS 3.5.22.10'],
        existsExe: (p) => p.toLowerCase().includes('3.5.22.10'),
      },
    ]);
    const installs = detectInstalls(['C:\\Program Files'], fakeFs);
    expect(installs).toHaveLength(1);
    expect(installs[0].sp).toBe(22);
  });

  it('sorts by SP then patch ascending', () => {
    const fakeFs = makeFakeFs([
      {
        base: 'C:\\Program Files',
        entries: ['CODESYS 3.5.22.10', 'CODESYS 3.5.21.50', 'CODESYS 3.5.21.30'],
        existsExe: (p) => p.endsWith('CODESYS.exe'),
      },
    ]);
    const installs = detectInstalls(['C:\\Program Files'], fakeFs);
    expect(installs.map((i) => `${i.sp}.${i.patch}`)).toEqual(['21.3', '21.5', '22.1']);
  });

  it('deduplicates the same exe across search dirs', () => {
    const fakeFs = makeFakeFs([
      {
        base: 'C:\\Program Files',
        entries: ['CODESYS 3.5.21.50'],
        existsExe: (p) => p.endsWith('CODESYS.exe'),
      },
      {
        base: 'C:\\Program Files',
        entries: ['CODESYS 3.5.21.50'],
        existsExe: (p) => p.endsWith('CODESYS.exe'),
      },
    ]);
    const installs = detectInstalls(['C:\\Program Files', 'C:\\Program Files'], fakeFs);
    expect(installs).toHaveLength(1);
  });
});

const fixture = (overrides: Partial<CodesysInstall> = {}): CodesysInstall => ({
  installDir: 'C:\\Program Files\\CODESYS 3.5.22.10',
  exePath: 'C:\\Program Files\\CODESYS 3.5.22.10\\CODESYS\\Common\\CODESYS.exe',
  version: '3.5.22.10',
  major: 3,
  minor: 5,
  sp: 22,
  patch: 1,
  profileName: 'CODESYS V3.5 SP22 Patch 1',
  serverName: 'codesys-sp22-patch1',
  ...overrides,
});

describe('printConfig', () => {
  const sp19 = fixture({
    installDir: 'C:\\Program Files\\CODESYS 3.5.19.40',
    exePath: 'C:\\Program Files\\CODESYS 3.5.19.40\\CODESYS\\Common\\CODESYS.exe',
    version: '3.5.19.40',
    sp: 19,
    patch: 4,
    profileName: 'CODESYS V3.5 SP19 Patch 4',
    serverName: 'codesys-sp19-patch4',
  });
  const sp21 = fixture({
    installDir: 'C:\\Program Files\\CODESYS 3.5.21.50',
    exePath: 'C:\\Program Files\\CODESYS 3.5.21.50\\CODESYS\\Common\\CODESYS.exe',
    version: '3.5.21.50',
    sp: 21,
    patch: 5,
    profileName: 'CODESYS V3.5 SP21 Patch 5',
    serverName: 'codesys-sp21-patch5',
  });
  const sp22 = fixture();

  it('emits one entry named "codesys" when there is exactly one install', () => {
    const out = printConfig([sp22], { date: '2026-04-27' });
    expect(out).toContain('Detected 1 CODESYS installation');
    expect(out).not.toContain('CAVEAT');
    expect(out).toContain('"codesys": {');
    expect(out).toContain('"--codesys-profile", "CODESYS V3.5 SP22 Patch 1"');
  });

  it('emits one block per install with derived names when multiple', () => {
    const out = printConfig([sp19, sp21, sp22], { date: '2026-04-27' });
    expect(out).toContain('Detected 3 CODESYS installations');
    expect(out).toContain('Multiple entries can be active');
    expect(out).toContain("don't open the SAME .project");
    expect(out).toContain('"codesys-sp19-patch4": {');
    expect(out).toContain('"codesys-sp21-patch5": {');
    expect(out).toContain('"codesys-sp22-patch1": {');
  });

  it('--sp filters to a single SP family and collapses the name to "codesys" when one match', () => {
    const out = printConfig([sp19, sp21, sp22], { sp: 21, date: '2026-04-27' });
    expect(out).toContain('"codesys": {');
    expect(out).toContain('"--codesys-profile", "CODESYS V3.5 SP21 Patch 5"');
    expect(out).not.toContain('SP22');
    expect(out).not.toContain('SP19');
  });

  it('--sp keeps descriptive names when multiple patches match', () => {
    const sp21patch3 = fixture({
      installDir: 'C:\\Program Files\\CODESYS 3.5.21.30',
      exePath: 'C:\\Program Files\\CODESYS 3.5.21.30\\CODESYS\\Common\\CODESYS.exe',
      version: '3.5.21.30',
      sp: 21,
      patch: 3,
      profileName: 'CODESYS V3.5 SP21 Patch 3',
      serverName: 'codesys-sp21-patch3',
    });
    const out = printConfig([sp19, sp21, sp21patch3, sp22], { sp: 21, date: '2026-04-27' });
    expect(out).toContain('"codesys-sp21-patch3": {');
    expect(out).toContain('"codesys-sp21-patch5": {');
  });

  it('throws a clear error when --sp matches no install', () => {
    expect(() => printConfig([sp22], { sp: 21 })).toThrow(/SP21/);
  });

  it('throws when no installs detected at all', () => {
    expect(() => printConfig([])).toThrow(/No CODESYS installations detected/);
  });

  it('--name overrides the entry name when paired with --sp narrowing to one', () => {
    const out = printConfig([sp19, sp22], { sp: 22, name: 'production', date: '2026-04-27' });
    expect(out).toContain('"production": {');
    expect(out).not.toContain('"codesys-sp22-patch1": {');
  });

  it('--name without single-install narrowing throws', () => {
    expect(() => printConfig([sp19, sp22], { name: 'whatever' })).toThrow(/--name only works/);
  });

  it('produces parseable JSON when comments are stripped', () => {
    const out = printConfig([sp19, sp22], { date: '2026-04-27' });
    const stripped = out
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    const parsed = JSON.parse(stripped);
    expect(parsed.mcpServers['codesys-sp19-patch4'].args).toContain('--codesys-path');
    expect(parsed.mcpServers['codesys-sp22-patch1'].args).toContain('--codesys-profile');
  });

  it('forProjectHint exact: header mentions matching profile', () => {
    const out = printConfig([sp22], {
      date: '2026-04-27',
      forProjectHint: {
        profileName: 'CODESYS V3.5 SP22 Patch 1',
        profileVersion: '3.5.22.10',
        matchKind: 'exact',
      },
    });
    expect(out).toContain('Filtered by --for-project');
    expect(out).toContain('matches CODESYS V3.5 SP22 Patch 1');
    expect(out).toContain('project saved on 3.5.22.10');
    expect(out).not.toContain('Falling back');
  });

  it('forProjectHint sp-only-fallback: header warns about patch difference', () => {
    const sp22patch3 = fixture({
      installDir: 'C:\\Program Files\\CODESYS 3.5.22.30',
      exePath: 'C:\\Program Files\\CODESYS 3.5.22.30\\CODESYS\\Common\\CODESYS.exe',
      version: '3.5.22.30',
      sp: 22,
      patch: 3,
      profileName: 'CODESYS V3.5 SP22 Patch 3',
      serverName: 'codesys-sp22-patch3',
    });
    const out = printConfig([sp22, sp22patch3], {
      date: '2026-04-27',
      forProjectHint: {
        profileName: 'CODESYS V3.5 SP22 Patch 1',
        profileVersion: '3.5.22.10',
        matchKind: 'sp-only-fallback',
      },
    });
    expect(out).toContain("No exact match for project's saved profile");
    expect(out).toContain('CODESYS V3.5 SP22 Patch 1, version 3.5.22.10');
    expect(out).toContain('Falling back to all installed SP22 versions');
    expect(out).toContain('patch difference will trigger');
    expect(out).toContain('CODESYS conversion dialog');
  });

  it('forProjectHint with single install collapses entry name to "codesys"', () => {
    const out = printConfig([sp22], {
      date: '2026-04-27',
      forProjectHint: {
        profileName: 'CODESYS V3.5 SP22 Patch 1',
        profileVersion: '3.5.22.10',
        matchKind: 'exact',
      },
    });
    expect(out).toContain('"codesys": {');
    expect(out).not.toContain('"codesys-sp22-patch1": {');
    expect(out).toContain('Detected 1 CODESYS installation');
  });

  it('forProjectHint with multiple sp-fallback matches keeps descriptive names', () => {
    const sp22patch3 = fixture({
      installDir: 'C:\\Program Files\\CODESYS 3.5.22.30',
      exePath: 'C:\\Program Files\\CODESYS 3.5.22.30\\CODESYS\\Common\\CODESYS.exe',
      version: '3.5.22.30',
      sp: 22,
      patch: 3,
      profileName: 'CODESYS V3.5 SP22 Patch 3',
      serverName: 'codesys-sp22-patch3',
    });
    const out = printConfig([sp22, sp22patch3], {
      date: '2026-04-27',
      forProjectHint: {
        profileName: 'CODESYS V3.5 SP22 Patch 1',
        profileVersion: '3.5.22.10',
        matchKind: 'sp-only-fallback',
      },
    });
    expect(out).toContain('"codesys-sp22-patch1": {');
    expect(out).toContain('"codesys-sp22-patch3": {');
    expect(out).not.toContain('"codesys": {');
  });

  it('forProjectHint --name override works when single match', () => {
    const out = printConfig([sp22], {
      name: 'production',
      date: '2026-04-27',
      forProjectHint: {
        profileName: 'CODESYS V3.5 SP22 Patch 1',
        profileVersion: '3.5.22.10',
        matchKind: 'exact',
      },
    });
    expect(out).toContain('"production": {');
    expect(out).not.toContain('"codesys-sp22-patch1": {');
  });
});
