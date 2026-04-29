import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { writeSelection } from '../../src/tui/shared/state-write.ts';
import { Selection } from '../../src/tui/shared/types.ts';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'phobics-tui-'));
}

const sampleSelection: Selection = {
  device: 'CodesysRpi',
  pou: {
    name: 'FB_Test',
    kind: 'FB',
    relPath: 'Plc Logic/Application/FB_Test.st',
    absPath: '/abs/Plc Logic/Application/FB_Test.st',
    loc: 87,
    mtimeMs: 0,
  },
  viewerLine: 12,
};

describe('writeSelection', () => {
  it('writes a JSON file atomically with v1 envelope', async () => {
    const dir = await tmpDir();
    const target = path.join(dir, 'tui-state.json');
    await writeSelection(target, '/abs/project', sampleSelection);

    const text = await fs.readFile(target, 'utf8');
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(1);
    expect(parsed.project_dir).toBe('/abs/project');
    expect(parsed.device).toBe('CodesysRpi');
    expect(parsed.selection.name).toBe('FB_Test');
    expect(parsed.selection.kind).toBe('FB');
    expect(parsed.viewer_line).toBe(12);
    expect(typeof parsed.updated_at).toBe('string');
    expect(() => new Date(parsed.updated_at)).not.toThrow();
  });

  it('creates parent directories as needed', async () => {
    const dir = await tmpDir();
    const target = path.join(dir, 'a', 'b', 'tui-state.json');
    await writeSelection(target, '/abs/project', sampleSelection);
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
  });

  it('does not leave the .tmp file behind on success', async () => {
    const dir = await tmpDir();
    const target = path.join(dir, 'tui-state.json');
    await writeSelection(target, '/abs/project', sampleSelection);
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });
});
