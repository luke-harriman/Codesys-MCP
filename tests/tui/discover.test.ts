import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { findProjectRoot } from '../../src/tui/shared/discover.ts';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'phobics-tui-disc-'));
}

describe('findProjectRoot', () => {
  it('returns the start dir when it directly contains mcp-mirror/', async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, 'mcp-mirror'));
    expect(await findProjectRoot(root)).toBe(root);
  });

  it('walks upward to find mcp-mirror/', async () => {
    const root = await tmpDir();
    await fs.mkdir(path.join(root, 'mcp-mirror'));
    const sub = path.join(root, 'a', 'b', 'c');
    await fs.mkdir(sub, { recursive: true });
    expect(await findProjectRoot(sub)).toBe(root);
  });

  it('returns null when no mcp-mirror/ is found anywhere upward', async () => {
    const root = await tmpDir();
    expect(await findProjectRoot(root)).toBeNull();
  });
});
