import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readSelection, FRESHNESS_MS } from '../../src/state-read';

async function tmpFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phobics-read-'));
  const f = path.join(dir, 'tui-state.json');
  await fs.writeFile(f, content, 'utf8');
  return f;
}

const FRESH = JSON.stringify({
  version: 1,
  updated_at: new Date().toISOString(),
  project_dir: '/p',
  device: 'D1',
  selection: {
    kind: 'FB',
    name: 'FB_Test',
    path: 'a/FB_Test.st',
    abs_path: '/abs/a/FB_Test.st',
  },
  viewer_line: 12,
});

describe('readSelection', () => {
  it('returns the parsed payload when fresh', async () => {
    const f = await tmpFile(FRESH);
    const r = await readSelection(f);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.payload.device).toBe('D1');
      expect(r.payload.selection.name).toBe('FB_Test');
    }
  });

  it('returns stale when updated_at is older than the freshness window', async () => {
    const old = JSON.stringify({
      ...JSON.parse(FRESH),
      updated_at: new Date(Date.now() - FRESHNESS_MS - 5000).toISOString(),
    });
    const f = await tmpFile(old);
    const r = await readSelection(f);
    expect(r.status).toBe('stale');
  });

  it('returns missing when the file does not exist', async () => {
    const r = await readSelection('/nonexistent/tui-state.json');
    expect(r.status).toBe('missing');
  });

  it('returns invalid when the JSON is malformed', async () => {
    const f = await tmpFile('not json');
    const r = await readSelection(f);
    expect(r.status).toBe('invalid');
  });
});
