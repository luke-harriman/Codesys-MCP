import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

export const IMPL_SENTINEL = '(* === IMPLEMENTATION === *)';

export interface SetPouCodeArgs {
  declarationCode?: string;
  implementationCode?: string;
}

export type GateResult =
  | { status: 'accepted' }
  | { status: 'rejected'; message: string }
  | { status: 'no-existing' }
  | { status: 'error'; message: string };

function splitOnSentinel(text: string): { decl: string; impl: string } {
  const idx = text.indexOf(IMPL_SENTINEL);
  if (idx < 0) {
    return { decl: text, impl: '' };
  }
  const decl = text.slice(0, idx).replace(/\s+$/, '');
  const after = text.slice(idx + IMPL_SENTINEL.length);
  const impl = after.replace(/^\r?\n/, '');
  return { decl, impl };
}

export function composeMergedContent(existing: string, args: SetPouCodeArgs): string {
  const { decl, impl } = splitOnSentinel(existing);
  const newDecl = args.declarationCode ?? decl;
  const newImpl = args.implementationCode ?? impl;
  return [newDecl, IMPL_SENTINEL, newImpl].join('\n');
}

async function findMirrorFile(
  projectFilePath: string,
  pouPath: string
): Promise<string | null> {
  const projectDir = path.dirname(path.resolve(projectFilePath));
  const mirrorRoot = path.join(projectDir, 'mcp-mirror');
  try {
    await fs.access(mirrorRoot);
  } catch {
    return null;
  }
  const leaf = pouPath.split(/[./]/).pop()!;
  const matches: string[] = [];
  await collectMatches(mirrorRoot, `${leaf}.st`, matches);
  return matches.length === 1 ? matches[0] : null;
}

async function collectMatches(dir: string, leafName: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await collectMatches(full, leafName, out);
    } else if (e.isFile() && e.name === leafName) {
      out.push(full);
    }
  }
}

async function spawnApproveTui(existingPath: string, stagedPath: string): Promise<GateResult> {
  const tuiBin = path.join(__dirname, 'tui', 'index.js');
  return new Promise<GateResult>((resolve) => {
    const child = spawn(process.execPath, [tuiBin, 'approve', existingPath, stagedPath], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => {
      if (code === 0) resolve({ status: 'accepted' });
      else if (code === 1)
        resolve({ status: 'rejected', message: 'User rejected the change in phobiCS-tui.' });
      else
        resolve({
          status: 'error',
          message: `phobiCS-tui exited with code ${code}.`,
        });
    });
  });
}

export interface RunGateOpts {
  projectFilePath: string;
  pouPath: string;
  args: SetPouCodeArgs;
  spawnFn?: typeof spawnApproveTui;
}

export async function runApproveGate(opts: RunGateOpts): Promise<GateResult> {
  const existingPath = await findMirrorFile(opts.projectFilePath, opts.pouPath);
  if (!existingPath) {
    return { status: 'no-existing' };
  }
  let existing: string;
  try {
    existing = await fs.readFile(existingPath, 'utf8');
  } catch (err) {
    return { status: 'error', message: `read failed: ${(err as Error).message}` };
  }
  const proposed = composeMergedContent(existing, opts.args);

  const stagedPath = `${existingPath}.staged`;
  await fs.writeFile(stagedPath, proposed, 'utf8');
  try {
    const spawnFn = opts.spawnFn ?? spawnApproveTui;
    return await spawnFn(existingPath, stagedPath);
  } finally {
    await fs.rm(stagedPath, { force: true });
  }
}
