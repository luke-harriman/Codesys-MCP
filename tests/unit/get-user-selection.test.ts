import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { buildGetUserSelectionResponse } from '../../src/server';

async function tmpFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phobics-tool-'));
  const f = path.join(dir, 'tui-state.json');
  await fs.writeFile(f, content, 'utf8');
  return f;
}

const fresh = () =>
  JSON.stringify({
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

describe('buildGetUserSelectionResponse', () => {
  it('returns a structured payload for a fresh state file', async () => {
    const f = await tmpFile(fresh());
    const res = await buildGetUserSelectionResponse(f);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('FB_Test');
    expect(res.content[0].text).toContain('D1');
  });

  it('returns "no active selection" text when state file is missing', async () => {
    const res = await buildGetUserSelectionResponse('/nonexistent.json');
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/no active selection/i);
  });

  it('returns "no active selection" text when state is stale', async () => {
    const old = JSON.stringify({
      ...JSON.parse(fresh()),
      updated_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const f = await tmpFile(old);
    const res = await buildGetUserSelectionResponse(f);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/no active selection/i);
  });
});
