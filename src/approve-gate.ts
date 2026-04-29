import * as fs from 'fs/promises';
import * as os from 'os';
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

/**
 * Generic approve-gate for tools that don't have a single existing-file -> proposed-file
 * mapping. Renders an arbitrary "before" + "after" snapshot through the TUI's approve
 * mode, with a descriptive temp-file name conveying the operation.
 *
 * For pure-create ops, oldText is ''. For pure-delete ops, newText is ''. For rename,
 * both sides are short identifier names. The diff display always communicates the op
 * intent visually (all-green for create, all-red for delete, single line each for rename).
 */
export interface ApproveGateOp {
  /** Short slug used as the synthetic filename — drives what the user sees as "<file>.st". */
  slug: string;
  /** Pre-state. Empty string for create operations. */
  oldText: string;
  /** Post-state. Empty string for delete operations. */
  newText: string;
  /** Test-only override for the spawn function. */
  spawnFn?: typeof spawnApproveTui;
}

export async function runApproveGateOp(op: ApproveGateOp): Promise<GateResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phobics-gate-'));
  const safeSlug = op.slug.replace(/[^A-Za-z0-9._-]+/g, '_');
  const oldPath = path.join(dir, `${safeSlug}.before.st`);
  const newPath = path.join(dir, `${safeSlug}.after.st`);
  await fs.writeFile(oldPath, op.oldText, 'utf8');
  await fs.writeFile(newPath, op.newText, 'utf8');
  try {
    const spawnFn = op.spawnFn ?? spawnApproveTui;
    return await spawnFn(oldPath, newPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * MCP-tool-shaped wrapper around runApproveGateOp.
 *
 * Returns null when the operation should proceed (gate disabled, accepted, or
 * mirror file missing for a non-set_pou_code op). Returns an MCP-shaped
 * response object when the call should short-circuit (rejected -> isError=false
 * with the user-rejection message; error -> isError=true with the spawn error).
 */
export interface BlockResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

export async function gateOpForTool(opts: {
  enabled: boolean;
  slug: string;
  oldText: string;
  newText: string;
  spawnFn?: typeof spawnApproveTui;
}): Promise<BlockResponse | null> {
  if (!opts.enabled) return null;
  const gate = await runApproveGateOp({
    slug: opts.slug,
    oldText: opts.oldText,
    newText: opts.newText,
    spawnFn: opts.spawnFn,
  });
  if (gate.status === 'accepted' || gate.status === 'no-existing') return null;
  if (gate.status === 'rejected') {
    return { content: [{ type: 'text', text: gate.message }], isError: false };
  }
  return {
    content: [{ type: 'text', text: `Approve gate error: ${gate.message}` }],
    isError: true,
  };
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
