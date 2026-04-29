import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

const BIN = path.resolve('dist/tui/index.js');

beforeAll(async () => {
  await fs.access(BIN);
});

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('phobiCS-tui (integration, no-TTY paths only)', () => {
  it('--version prints version and exits 0', async () => {
    const r = await run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/phobiCS-tui v\d/);
  });

  it('approve with missing file exits 2', async () => {
    const r = await run(['approve', '/nonexistent/old.st', '/nonexistent/new.st']);
    expect(r.code).toBe(2);
  });

  it('approve with no args exits 2 with usage on stderr', async () => {
    const r = await run(['approve']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/usage:/);
  });
});
