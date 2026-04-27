/**
 * Resolution rules for the source-mirror directory written by mirror_export.
 *
 * Why this is non-trivial: the historical default was always
 * `<projectDir>/mcp-mirror/`. That breaks when two `.project` files share
 * a parent directory (e.g. `Multi plc test/ProjectA.project` +
 * `Multi plc test/ProjectB.project` both default to the same mirror, and
 * each `mirror_export` call clobbers the other's output -- and worse,
 * `release_project_version`'s git-tag-based history mis-attributes commits
 * across projects).
 *
 * The fix has to be backwards-compatible: existing projects already have
 * `mcp-mirror/` directories whose path is baked into v* tags + commit
 * history. Renaming the dir would break that history. So the resolution
 * logic preserves the legacy path whenever it can:
 *
 *   1. If `<projectDir>/mcp-mirror/` already exists, use it (legacy mode,
 *      single-project parent dir on existing setups).
 *   2. Else if `<projectDir>` contains exactly one `.project` file, use
 *      `<projectDir>/mcp-mirror/` (legacy default for new single-project
 *      setups too -- preserves the well-known docs path).
 *   3. Else (multiple `.project` siblings, no existing mcp-mirror) use
 *      `<projectDir>/<basename>_mcp_mirror/` so each project gets its own
 *      mirror tree without collision.
 *
 * The logic is mirrored verbatim in src/scripts/mirror_export.py so the
 * CODESYS-side script computes the same default. Keep them in sync.
 */
import * as path from 'path';
import * as fs from 'fs';

/**
 * Filesystem facade so tests can inject a fake without touching real disk.
 */
export interface MirrorPathFs {
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isDirectory: () => boolean };
  readdirSync: (p: string) => string[];
}

const realFs: MirrorPathFs = {
  existsSync: (p) => fs.existsSync(p),
  statSync: (p) => fs.statSync(p),
  readdirSync: (p) => fs.readdirSync(p),
};

/**
 * Resolve the mirror root for a given .project file. Returns an absolute
 * path. The fs argument is for tests; production callers omit it.
 *
 * Defensive on every fs call -- a permissions hiccup or a stat race must
 * not crash the auto-mirror flow. Worst case we fall back to the legacy
 * `<projectDir>/mcp-mirror/` path.
 */
export function resolveMirrorRoot(
  projectFilePath: string,
  fsImpl: MirrorPathFs = realFs
): string {
  const projectDir = path.dirname(projectFilePath);
  const legacy = path.join(projectDir, 'mcp-mirror');

  // Rule 1: existing mcp-mirror/ wins, regardless of how many .project
  // files sit beside it. Preserves git history on every project ever
  // mirrored before this fix landed.
  try {
    if (fsImpl.existsSync(legacy)) {
      const st = fsImpl.statSync(legacy);
      if (st.isDirectory()) return legacy;
    }
  } catch {
    // existsSync should never throw, but statSync can race with deletion;
    // fall through to the .project-count branch.
  }

  // Rules 2 + 3: count .project siblings. One = legacy path, multiple =
  // per-project naming.
  let projectSiblings = 0;
  try {
    const entries = fsImpl.readdirSync(projectDir);
    for (const e of entries) {
      // Case-insensitive match -- Windows treats Foo.PROJECT and foo.project
      // as the same extension.
      if (e.toLowerCase().endsWith('.project')) projectSiblings++;
    }
  } catch {
    // Project dir unreadable (network share blip, perms). Default to legacy
    // so we don't surprise anyone with a new path on transient failure.
    return legacy;
  }

  if (projectSiblings <= 1) return legacy;

  const base = path.basename(projectFilePath, '.project');
  return path.join(projectDir, `${base}_mcp_mirror`);
}
