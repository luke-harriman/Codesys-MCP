import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as url from 'url';
import { walk } from '../../src/tui/shared/scan.ts';

const fixtureRoot = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  'fixtures',
  'mini-mirror'
);

describe('scan.walk', () => {
  it('classifies every .st under the fixture mirror', async () => {
    const project = await walk(fixtureRoot);
    expect(project.devices).toHaveLength(1);
    const dev = project.devices[0];
    expect(dev.name).toBe('CodesysRpi');

    const byName = Object.fromEntries(dev.pous.map((p) => [p.name, p]));

    expect(byName['PLC_PRG'].kind).toBe('PRG');
    expect(byName['FB_Test'].kind).toBe('FB');
    expect(byName['DoSomething'].kind).toBe('METHOD');
    expect(byName['GVL_Test'].kind).toBe('GVL');
    expect(byName['ST_Sample'].kind).toBe('STRUCT');
    expect(byName['eMode'].kind).toBe('ENUM');
    expect(byName['_MCP_PROJECT_VERSION'].kind).toBe('META');
    expect(byName['FB_Sweep'].kind).toBe('FB');
    expect(byName['PropX'].kind).toBe('OTHER');
    expect(byName['Get'].kind).toBe('PROPERTY_GETTER');
    expect(byName['Set'].kind).toBe('PROPERTY_SETTER');
  });

  it('counts non-blank LOC', async () => {
    const project = await walk(fixtureRoot);
    const plcPrg = project.devices[0].pous.find((p) => p.name === 'PLC_PRG');
    expect(plcPrg).toBeDefined();
    expect(plcPrg!.loc).toBe(2);
  });

  it('sets project rootDir to the dir containing mcp-mirror/', async () => {
    const project = await walk(fixtureRoot);
    expect(project.rootDir).toBe(fixtureRoot);
  });

  it('throws a clear error if mcp-mirror/ is missing', async () => {
    await expect(walk(path.join(fixtureRoot, 'nonexistent'))).rejects.toThrow(
      /No mcp-mirror/
    );
  });
});
