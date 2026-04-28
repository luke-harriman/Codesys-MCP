# phobiCS-tui v0.1 + v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the in-fork ink TUI for browsing CODESYS-exported ST and gating modifying MCP tool calls behind a y/n diff prompt, plus the `get_user_selection` MCP tool that reads the TUI's selection state.

**Architecture:** New ESM subpackage at `src/tui/` (the rest of the fork stays CommonJS). React + ink renders three things: (1) a split-pane mirror browser, (2) a single-screen approve diff prompt, (3) a state file under `%LOCALAPPDATA%/codesys-mcp/tui-state.json` so the MCP server can answer "what is the user looking at right now?". A new bin `phobiCS-tui` wraps the ESM entry point. A new MCP tool `get_user_selection` reads the state file. Approve gate is opt-in via `--approve-edits` on the MCP server CLI.

**Tech Stack:** TypeScript 5.5, Node ≥ 18, ink 5 (React-for-terminal), ink-testing-library, diff (npm), vitest. Runtime CommonJS for the MCP server stays untouched; only `src/tui/` and `dist/tui/` are ESM.

**Spec:** [`docs/superpowers/specs/2026-04-28-tui-design.md`](../specs/2026-04-28-tui-design.md)

---

## File structure

Files created or modified by this plan:

```
package.json                                — add deps + bin + build scripts
tsconfig.tui.json                           — NEW, ESM emit for src/tui/ → dist/tui/
src/tui/package.json                        — NEW, {"type":"module"} sub-manifest
src/tui/index.tsx                           — bin entry, argv parsing, mode dispatch
src/tui/app.tsx                             — top-level <App>, picks browser vs approve
src/tui/shared/types.ts                     — Project, Device, POU, Selection, Hunk
src/tui/shared/scan.ts                      — walks mcp-mirror/, classifies *.st
src/tui/shared/diff.ts                      — wraps `diff` package, returns Hunk[]
src/tui/shared/state-paths.ts               — pure path resolution, no I/O
src/tui/shared/state-write.ts               — atomic write of Selection JSON
src/tui/shared/discover.ts                  — mirror dir auto-discovery from cwd
src/tui/approve/Approve.tsx                 — diff view + y/n keybind
src/tui/browser/Tree.tsx                    — collapsible POU tree
src/tui/browser/Viewer.tsx                  — source viewer (plain text in v0.1)
src/tui/browser/Browser.tsx                 — composes layout, owns selection state
src/state-read.ts                           — NEW, CJS, reads tui-state.json (used by MCP)
src/server.ts                               — register get_user_selection tool
src/bin.ts                                  — add --approve-edits CLI flag (no-op wiring; v0.1 plumbs but doesn't yet gate writes)
tests/tui/fixtures/mini-mirror/             — small canned mirror tree for scan tests
tests/tui/scan.test.ts                      — golden classification + LOC tests
tests/tui/diff.test.ts                      — hunk shape tests
tests/tui/state-paths.test.ts               — path resolution tests
tests/tui/state-write.test.ts               — atomic write tests
tests/tui/discover.test.ts                  — mirror dir auto-discovery tests
tests/tui/Approve.test.tsx                  — ink-testing-library snapshots
tests/tui/Tree.test.tsx                     — tree expand/cursor tests
tests/tui/Browser.test.tsx                  — selection-state-write integration
tests/tui/index.integration.test.ts         — spawn the built bin, assert exit codes
tests/unit/state-read.test.ts               — CJS state reader tests
tests/unit/get-user-selection.test.ts       — MCP tool wiring test
```

Each TUI source file stays below ~300 LOC. Components own only their visual concern; navigation/selection state lives in `Browser.tsx`.

---

## Task 1: Set up the ESM TUI subpackage

**Files:**
- Modify: `package.json`
- Create: `tsconfig.tui.json`
- Create: `src/tui/package.json`
- Create: `src/tui/index.tsx`

- [ ] **Step 1: Add ink + dev deps**

```bash
npm install ink@^5.0.0 react@^18.3.1
npm install --save-dev @types/react@^18.3.1 ink-testing-library@^4.0.0 diff@^5.2.0 @types/diff@^5.2.0
```

- [ ] **Step 2: Create `tsconfig.tui.json` for ESM emit**

Create `tsconfig.tui.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist/tui",
    "rootDir": "src/tui",
    "jsx": "react",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/tui/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Mark TUI subdir as ESM**

Create `src/tui/package.json`:

```json
{
  "type": "module"
}
```

- [ ] **Step 4: Create the bin entry point**

Create `src/tui/index.tsx`:

```tsx
#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Text } from 'ink';

const argv = process.argv.slice(2);

if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('phobiCS-tui v0.1.0\n');
  process.exit(0);
}

render(<Text>phobiCS-tui — coming soon</Text>);
```

- [ ] **Step 5: Update `package.json` build + bin**

Replace the `bin` and `scripts` sections of `package.json`:

```json
"bin": {
  "codesys-mcp-sp21-plus": "dist/bin.js",
  "phobiCS-tui": "dist/tui/index.js"
},
"scripts": {
  "build": "tsc && tsc -p tsconfig.tui.json && node -e \"require('fs').cpSync('src/scripts','dist/scripts',{recursive:true})\" && node -e \"const fs=require('fs');const p='dist/tui/index.js';fs.writeFileSync(p,'#!/usr/bin/env node\\n'+fs.readFileSync(p,'utf8'));\"",
  "build:tui": "tsc -p tsconfig.tui.json",
  "test": "vitest --run",
  "test:watch": "vitest",
  "typecheck": "tsc --noEmit && tsc -p tsconfig.tui.json --noEmit",
  "prepublishOnly": "npm run build && npm test"
}
```

The post-tsc shebang prepend is needed because `tsc` strips the `#!/usr/bin/env node` line.

- [ ] **Step 6: Build and smoke-test**

Run:

```bash
npm run build
node dist/tui/index.js --version
```

Expected stdout: `phobiCS-tui v0.1.0`

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.tui.json src/tui/
git commit -m "tui: scaffold phobiCS-tui ESM subpackage with ink"
```

---

## Task 2: Domain types

**Files:**
- Create: `src/tui/shared/types.ts`

- [ ] **Step 1: Write the type definitions**

Create `src/tui/shared/types.ts`:

```ts
export type POUKind =
  | 'PRG'
  | 'FB'
  | 'GVL'
  | 'STRUCT'
  | 'ENUM'
  | 'METHOD'
  | 'PROPERTY_GETTER'
  | 'PROPERTY_SETTER'
  | 'META'
  | 'OTHER';

export interface POU {
  /** Display name without .st extension */
  name: string;
  kind: POUKind;
  /** Path relative to the device root, with forward slashes. */
  relPath: string;
  absPath: string;
  /** Non-blank line count */
  loc: number;
  mtimeMs: number;
}

export interface Device {
  /** Top-level subdir under mcp-mirror/, e.g. "CodesysRpi" */
  name: string;
  pous: POU[];
}

export interface Project {
  /** The project's parent directory (the dir that contains mcp-mirror/) */
  rootDir: string;
  /** Mirror dir mtime — used for the "stale" indicator */
  mirrorMtimeMs: number;
  devices: Device[];
}

export interface Selection {
  device: string;
  pou: POU;
  viewerLine: number;
}

export type HunkKind = 'add' | 'del' | 'ctx';

export interface Hunk {
  kind: HunkKind;
  /** 1-based line number in the side this hunk belongs to (new-side for add/ctx, old-side for del). */
  lineNo: number;
  text: string;
}
```

- [ ] **Step 2: Verify types compile**

Run:

```bash
npm run build:tui
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/tui/shared/types.ts
git commit -m "tui: add domain types (Project, POU, Hunk, Selection)"
```

---

## Task 3: Mirror scanner

**Files:**
- Create: `src/tui/shared/scan.ts`
- Create: `tests/tui/fixtures/mini-mirror/` (canned mirror tree)
- Create: `tests/tui/scan.test.ts`

- [ ] **Step 1: Write the canned mini-mirror fixture**

Create the directory tree under `tests/tui/fixtures/mini-mirror/` with these files. (Use `mkdir -p` and `printf` or write each file.)

```
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/PLC_PRG.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/FB_Test.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/FB_Test/DoSomething.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/GVL_Test.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/ST_Sample.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/eMode.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/_MCP_PROJECT_VERSION.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/FB_Sweep/PropX/Get.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/FB_Sweep/PropX/Set.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/FB_Sweep/PropX.st
tests/tui/fixtures/mini-mirror/mcp-mirror/CodesysRpi/Plc Logic/Application/FB_Sweep.st
```

Contents — every file gets exactly this content (LOC counting is verified separately):

```
(* fixture *)
LINE_TWO := 0;
```

That's 1 non-blank line of "real code" but actually 2 non-blank lines (the comment counts). Spec defines LOC as "non-blank line count", so each file has LOC = 2.

- [ ] **Step 2: Write the failing test**

Create `tests/tui/scan.test.ts`:

```ts
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
    expect(byName['PropX'].kind).toBe('OTHER'); // The property declarator file
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
```

Note: vitest needs `*.ts` extension allowance for `.ts` imports under ESM. If the test fails with "Unknown extension .ts", add `"resolve": { "extensions": [".ts", ".tsx", ".js"] }` to a `vitest.config.ts` or use `.js` extensions in imports. Adjust during step 4 if needed.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/tui/scan.test.ts`

Expected: FAIL — `walk` is not exported from a missing module.

- [ ] **Step 4: Implement `walk`**

Create `src/tui/shared/scan.ts`:

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { POU, POUKind, Device, Project } from './types.js';

const MIRROR_DIR = 'mcp-mirror';

export async function walk(rootDir: string): Promise<Project> {
  const mirrorDir = path.join(rootDir, MIRROR_DIR);
  let mirrorStat;
  try {
    mirrorStat = await fs.stat(mirrorDir);
  } catch {
    throw new Error(
      `No mcp-mirror/ found at ${rootDir}. Run mirror_export in CODESYS first.`
    );
  }

  const deviceNames = (await fs.readdir(mirrorDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const devices: Device[] = [];
  for (const name of deviceNames) {
    const pous = await collectPous(path.join(mirrorDir, name));
    devices.push({ name, pous });
  }

  return {
    rootDir,
    mirrorMtimeMs: mirrorStat.mtimeMs,
    devices,
  };
}

async function collectPous(deviceRoot: string): Promise<POU[]> {
  const stFiles = await listStFilesRecursive(deviceRoot);
  const stPathSet = new Set(stFiles.map((f) => f.toLowerCase()));
  const out: POU[] = [];

  for (const abs of stFiles) {
    const rel = path
      .relative(deviceRoot, abs)
      .split(path.sep)
      .join('/');
    const stat = await fs.stat(abs);
    const text = await fs.readFile(abs, 'utf8');
    const loc = text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    const name = path.basename(abs, '.st');
    const kind = classify(abs, name, stPathSet);

    out.push({
      name,
      kind,
      relPath: rel,
      absPath: abs,
      loc,
      mtimeMs: stat.mtimeMs,
    });
  }
  return out;
}

async function listStFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listStFilesRecursive(full)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.st')) {
      out.push(full);
    }
  }
  return out;
}

function classify(absPath: string, name: string, stPathSet: Set<string>): POUKind {
  if (name === 'PLC_PRG') return 'PRG';
  if (name === '_MCP_PROJECT_VERSION') return 'META';
  if (name === 'Get') return parentHasSiblingSt(absPath, stPathSet) ? 'PROPERTY_GETTER' : 'OTHER';
  if (name === 'Set') return parentHasSiblingSt(absPath, stPathSet) ? 'PROPERTY_SETTER' : 'OTHER';
  if (/^FB_/.test(name)) return 'FB';
  if (/^GVL_/.test(name)) return 'GVL';
  if (/^ST_/.test(name)) return 'STRUCT';
  if (/^e[A-Z]/.test(name)) return 'ENUM';
  if (parentHasSiblingSt(absPath, stPathSet)) return 'METHOD';
  return 'OTHER';
}

/**
 * If absPath sits inside a directory whose name matches a sibling .st file
 * in the parent (e.g. Foo/Bar.st sibling to Foo/Bar/<this>.st), the file is
 * a child of that POU (method or property accessor).
 */
function parentHasSiblingSt(absPath: string, stPathSet: Set<string>): boolean {
  const parentDir = path.dirname(absPath);
  const grandparentDir = path.dirname(parentDir);
  const parentName = path.basename(parentDir);
  const sibling = path.join(grandparentDir, `${parentName}.st`).toLowerCase();
  return stPathSet.has(sibling);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/tui/scan.test.ts`

Expected: PASS — 4 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/tui/shared/scan.ts tests/tui/scan.test.ts tests/tui/fixtures/
git commit -m "tui: add mirror scanner with classification + LOC"
```

---

## Task 4: State-file path resolution

**Files:**
- Create: `src/tui/shared/state-paths.ts`
- Create: `tests/tui/state-paths.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tui/state-paths.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { stateFilePath } from '../../src/tui/shared/state-paths.ts';

const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
const ORIG_ENV = { ...process.env };

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  process.env = { ...ORIG_ENV };
});

afterEach(() => {
  Object.defineProperty(process, 'platform', ORIG_PLATFORM);
  process.env = { ...ORIG_ENV };
});

describe('stateFilePath', () => {
  it('uses %LOCALAPPDATA%/codesys-mcp/tui-state.json on Windows', () => {
    setPlatform('win32');
    process.env.LOCALAPPDATA = 'C:\\\\Users\\\\u\\\\AppData\\\\Local';
    const p = stateFilePath();
    expect(p).toBe(
      path.join('C:\\\\Users\\\\u\\\\AppData\\\\Local', 'codesys-mcp', 'tui-state.json')
    );
  });

  it('uses $XDG_STATE_HOME/codesys-mcp/tui-state.json when set', () => {
    setPlatform('linux');
    process.env.XDG_STATE_HOME = '/tmp/xdg-state';
    const p = stateFilePath();
    expect(p).toBe('/tmp/xdg-state/codesys-mcp/tui-state.json');
  });

  it('falls back to ~/.local/state on Linux without XDG_STATE_HOME', () => {
    setPlatform('linux');
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = '/home/u';
    const p = stateFilePath();
    expect(p).toBe('/home/u/.local/state/codesys-mcp/tui-state.json');
  });

  it('throws on Windows when LOCALAPPDATA is unset', () => {
    setPlatform('win32');
    delete process.env.LOCALAPPDATA;
    expect(() => stateFilePath()).toThrow(/LOCALAPPDATA/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tui/state-paths.test.ts`

Expected: FAIL — `stateFilePath` is not exported.

- [ ] **Step 3: Implement `stateFilePath`**

Create `src/tui/shared/state-paths.ts`:

```ts
import * as os from 'os';
import * as path from 'path';

const APP_DIR = 'codesys-mcp';
const FILE_NAME = 'tui-state.json';

export function stateFilePath(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error('LOCALAPPDATA is not set; cannot resolve TUI state file path');
    }
    return path.join(localAppData, APP_DIR, FILE_NAME);
  }
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ?? path.join(os.homedir(), '.local', 'state');
  return path.join(base, APP_DIR, FILE_NAME);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tui/state-paths.test.ts`

Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tui/shared/state-paths.ts tests/tui/state-paths.test.ts
git commit -m "tui: add state-file path resolver (Windows + XDG)"
```

---

## Task 5: State-file atomic write

**Files:**
- Create: `src/tui/shared/state-write.ts`
- Create: `tests/tui/state-write.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tui/state-write.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tui/state-write.test.ts`

Expected: FAIL — `writeSelection` is not exported.

- [ ] **Step 3: Implement `writeSelection`**

Create `src/tui/shared/state-write.ts`:

```ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { Selection } from './types.js';

export async function writeSelection(
  filePath: string,
  projectDir: string,
  selection: Selection
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    project_dir: projectDir,
    device: selection.device,
    selection: {
      kind: selection.pou.kind,
      name: selection.pou.name,
      path: selection.pou.relPath,
      abs_path: selection.pou.absPath,
    },
    viewer_line: selection.viewerLine,
  };

  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tui/state-write.test.ts`

Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tui/shared/state-write.ts tests/tui/state-write.test.ts
git commit -m "tui: add atomic Selection JSON writer"
```

---

## Task 6: Diff hunks

**Files:**
- Create: `src/tui/shared/diff.ts`
- Create: `tests/tui/diff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tui/diff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeHunks } from '../../src/tui/shared/diff.ts';

describe('computeHunks', () => {
  it('returns ctx hunks when both sides are identical', () => {
    const a = 'one\ntwo\nthree';
    const hunks = computeHunks(a, a);
    expect(hunks.every((h) => h.kind === 'ctx')).toBe(true);
    expect(hunks).toHaveLength(3);
  });

  it('marks added lines', () => {
    const a = 'one\ntwo';
    const b = 'one\ntwo\nthree';
    const hunks = computeHunks(a, b);
    const added = hunks.filter((h) => h.kind === 'add');
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe('three');
  });

  it('marks deleted lines', () => {
    const a = 'one\ntwo\nthree';
    const b = 'one\ntwo';
    const hunks = computeHunks(a, b);
    const deleted = hunks.filter((h) => h.kind === 'del');
    expect(deleted).toHaveLength(1);
    expect(deleted[0].text).toBe('three');
  });

  it('handles a substitution as del + add', () => {
    const a = 'a\nb\nc';
    const b = 'a\nB\nc';
    const hunks = computeHunks(a, b);
    expect(hunks.some((h) => h.kind === 'del' && h.text === 'b')).toBe(true);
    expect(hunks.some((h) => h.kind === 'add' && h.text === 'B')).toBe(true);
  });

  it('reports add/ctx line numbers against the new side, del against the old side', () => {
    const a = 'a\nb\nc';
    const b = 'a\nx\nc';
    const hunks = computeHunks(a, b);
    const del = hunks.find((h) => h.kind === 'del')!;
    const add = hunks.find((h) => h.kind === 'add')!;
    expect(del.lineNo).toBe(2);
    expect(add.lineNo).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tui/diff.test.ts`

Expected: FAIL — `computeHunks` is not exported.

- [ ] **Step 3: Implement `computeHunks`**

Create `src/tui/shared/diff.ts`:

```ts
import { diffLines } from 'diff';
import { Hunk } from './types.js';

export function computeHunks(oldText: string, newText: string): Hunk[] {
  const parts = diffLines(oldText, newText);
  const out: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const part of parts) {
    const lines = part.value.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (part.added) {
      for (const text of lines) {
        out.push({ kind: 'add', lineNo: newLine, text });
        newLine++;
      }
    } else if (part.removed) {
      for (const text of lines) {
        out.push({ kind: 'del', lineNo: oldLine, text });
        oldLine++;
      }
    } else {
      for (const text of lines) {
        out.push({ kind: 'ctx', lineNo: newLine, text });
        oldLine++;
        newLine++;
      }
    }
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tui/diff.test.ts`

Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tui/shared/diff.ts tests/tui/diff.test.ts
git commit -m "tui: add line-based diff hunk computation"
```

---

## Task 7: Mirror dir auto-discovery

**Files:**
- Create: `src/tui/shared/discover.ts`
- Create: `tests/tui/discover.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tui/discover.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tui/discover.test.ts`

Expected: FAIL — `findProjectRoot` is not exported.

- [ ] **Step 3: Implement `findProjectRoot`**

Create `src/tui/shared/discover.ts`:

```ts
import * as fs from 'fs/promises';
import * as path from 'path';

export async function findProjectRoot(startDir: string): Promise<string | null> {
  let cur = path.resolve(startDir);
  while (true) {
    try {
      const stat = await fs.stat(path.join(cur, 'mcp-mirror'));
      if (stat.isDirectory()) return cur;
    } catch {
      // not here, walk up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tui/discover.test.ts`

Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tui/shared/discover.ts tests/tui/discover.test.ts
git commit -m "tui: add mcp-mirror auto-discovery"
```

---

## Task 8: Approve-mode component

**Files:**
- Create: `src/tui/approve/Approve.tsx`
- Create: `tests/tui/Approve.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/tui/Approve.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Approve } from '../../src/tui/approve/Approve.tsx';

const OLD = 'PROGRAM PLC_PRG\nVAR\n  counter : INT := 0;\nEND_VAR';
const NEW = 'PROGRAM PLC_PRG\nVAR\n  counter : DINT := 0;\n  overflow : BOOL;\nEND_VAR';

describe('<Approve>', () => {
  it('renders both deletions and additions in a unified diff', () => {
    const { lastFrame } = render(
      <Approve fileName="PLC_PRG.st" oldText={OLD} newText={NEW} onDecision={() => {}} />
    );
    const out = lastFrame()!;
    expect(out).toContain('counter : INT := 0;');
    expect(out).toContain('counter : DINT := 0;');
    expect(out).toContain('overflow : BOOL;');
    expect(out).toMatch(/Approve change\? PLC_PRG\.st/);
  });

  it('reports add/del totals in the header', () => {
    const { lastFrame } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={() => {}} />
    );
    const out = lastFrame()!;
    expect(out).toMatch(/\+ 2 lines.*− 1 lines/);
  });

  it('calls onDecision("accept") when y is pressed', () => {
    const decision = vi.fn();
    const { stdin } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={decision} />
    );
    stdin.write('y');
    expect(decision).toHaveBeenCalledWith('accept');
  });

  it('calls onDecision("reject") when n is pressed', () => {
    const decision = vi.fn();
    const { stdin } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={decision} />
    );
    stdin.write('n');
    expect(decision).toHaveBeenCalledWith('reject');
  });

  it('calls onDecision("reject") when q is pressed', () => {
    const decision = vi.fn();
    const { stdin } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={decision} />
    );
    stdin.write('q');
    expect(decision).toHaveBeenCalledWith('reject');
  });

  it('calls onDecision("reject") on escape', () => {
    const decision = vi.fn();
    const { stdin } = render(
      <Approve fileName="x.st" oldText={OLD} newText={NEW} onDecision={decision} />
    );
    stdin.write(''); // ESC
    expect(decision).toHaveBeenCalledWith('reject');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tui/Approve.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `<Approve>`**

Create `src/tui/approve/Approve.tsx`:

```tsx
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { computeHunks } from '../shared/diff.js';
import { Hunk } from '../shared/types.js';

export type Decision = 'accept' | 'reject';

export interface ApproveProps {
  fileName: string;
  oldText: string;
  newText: string;
  onDecision: (d: Decision) => void;
}

export function Approve({ fileName, oldText, newText, onDecision }: ApproveProps): React.ReactElement {
  const hunks = React.useMemo(() => computeHunks(oldText, newText), [oldText, newText]);
  const adds = hunks.filter((h) => h.kind === 'add').length;
  const dels = hunks.filter((h) => h.kind === 'del').length;

  useInput((input, key) => {
    if (input === 'y') return onDecision('accept');
    if (input === 'n' || input === 'q' || key.escape) return onDecision('reject');
  });

  return (
    <Box flexDirection="column">
      <Text>
        ─ Approve change? {fileName} ─── + {adds} lines, − {dels} lines ─
      </Text>
      <Box flexDirection="column">
        {hunks.map((h, i) => (
          <HunkLine key={i} hunk={h} />
        ))}
      </Box>
      <Text>
        y accept   n reject   q reject & quit   ESC reject
      </Text>
    </Box>
  );
}

function HunkLine({ hunk }: { hunk: Hunk }): React.ReactElement {
  const sigil = hunk.kind === 'add' ? '+' : hunk.kind === 'del' ? '-' : ' ';
  const color = hunk.kind === 'add' ? 'green' : hunk.kind === 'del' ? 'red' : undefined;
  const lineNoStr = String(hunk.lineNo).padStart(4, ' ');
  return (
    <Text color={color}>
      {sigil} {lineNoStr}  {hunk.text}
    </Text>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tui/Approve.test.tsx`

Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tui/approve/Approve.tsx tests/tui/Approve.test.tsx
git commit -m "tui: add Approve component with y/n keybind"
```

---

## Task 9: Approve-mode dispatch in `index.tsx`

**Files:**
- Modify: `src/tui/index.tsx`
- Create: `tests/tui/index.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tui/index.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

const BIN = path.resolve('dist/tui/index.js');

beforeAll(async () => {
  await fs.access(BIN); // require a prior `npm run build`
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
```

The accept (`y`) and reject (`n`) keybinds are covered by ink-testing-library
in Task 8; spawning the binary and piping stdin into ink without a TTY is
flaky on Windows so we don't try to integration-test that path.

- [ ] **Step 2: Replace `src/tui/index.tsx` with the dispatcher**

Overwrite `src/tui/index.tsx`:

```tsx
#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import * as fs from 'fs/promises';
import { Approve, Decision } from './approve/Approve.js';

const argv = process.argv.slice(2);

async function main(): Promise<number> {
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write('phobiCS-tui v0.1.0\n');
    return 0;
  }
  if (argv[0] === 'approve') {
    return runApprove(argv[1], argv[2]);
  }
  process.stdout.write('phobiCS-tui — browser mode coming in a later task\n');
  return 0;
}

async function runApprove(oldPath: string | undefined, newPath: string | undefined): Promise<number> {
  if (!oldPath || !newPath) {
    process.stderr.write('usage: phobiCS-tui approve <existing> <proposed>\n');
    return 2;
  }
  let oldText: string;
  let newText: string;
  try {
    oldText = await fs.readFile(oldPath, 'utf8');
    newText = await fs.readFile(newPath, 'utf8');
  } catch (err) {
    process.stderr.write(`phobiCS-tui: ${(err as Error).message}\n`);
    return 2;
  }

  return new Promise<number>((resolve) => {
    const onDecision = (d: Decision) => {
      app.unmount();
      resolve(d === 'accept' ? 0 : 1);
    };
    const fileName = oldPath.split(/[/\\]/).pop() ?? oldPath;
    const app = render(
      <Approve fileName={fileName} oldText={oldText} newText={newText} onDecision={onDecision} />
    );

    process.on('SIGTERM', () => {
      app.unmount();
      resolve(1);
    });
    process.on('SIGINT', () => {
      app.unmount();
      resolve(1);
    });
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`phobiCS-tui: ${err}\n`);
    process.exit(2);
  });
```

- [ ] **Step 3: Build and run integration test**

Run:

```bash
npm run build
npx vitest run tests/tui/index.integration.test.ts
```

Expected: PASS — 3 tests passing.

- [ ] **Step 4: Commit**

```bash
git add src/tui/index.tsx tests/tui/index.integration.test.ts
git commit -m "tui: wire approve dispatch in bin entry"
```

---

## Task 10: Tree component (browser mode)

**Files:**
- Create: `src/tui/browser/Tree.tsx`
- Create: `tests/tui/Tree.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/tui/Tree.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Tree } from '../../src/tui/browser/Tree.tsx';
import { Project } from '../../src/tui/shared/types.ts';

const project: Project = {
  rootDir: '/p',
  mirrorMtimeMs: 0,
  devices: [
    {
      name: 'CodesysRpi',
      pous: [
        { name: 'PLC_PRG', kind: 'PRG', relPath: 'a/PLC_PRG.st', absPath: '/abs/a/PLC_PRG.st', loc: 5, mtimeMs: 0 },
        { name: 'FB_Test', kind: 'FB',  relPath: 'a/FB_Test.st', absPath: '/abs/a/FB_Test.st', loc: 87, mtimeMs: 0 },
      ],
    },
  ],
};

describe('<Tree>', () => {
  it('renders devices and POU rows when expanded', () => {
    const { lastFrame } = render(
      <Tree
        project={project}
        cursorPath="device:CodesysRpi"
        expanded={new Set(['device:CodesysRpi'])}
      />
    );
    const out = lastFrame()!;
    expect(out).toContain('CodesysRpi');
    expect(out).toContain('PLC_PRG');
    expect(out).toContain('FB_Test');
    expect(out).toContain('PRG');
    expect(out).toContain('FB');
  });

  it('does not show POU rows when device is collapsed', () => {
    const { lastFrame } = render(
      <Tree project={project} cursorPath="device:CodesysRpi" expanded={new Set()} />
    );
    const out = lastFrame()!;
    expect(out).toContain('CodesysRpi');
    expect(out).not.toContain('PLC_PRG');
  });

  it('marks the cursor row', () => {
    const { lastFrame } = render(
      <Tree
        project={project}
        cursorPath="pou:CodesysRpi:a/FB_Test.st"
        expanded={new Set(['device:CodesysRpi'])}
      />
    );
    const out = lastFrame()!;
    // the cursor row should contain a leading marker we can grep for
    expect(out).toMatch(/▶ FB_Test/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tui/Tree.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `<Tree>`**

Create `src/tui/browser/Tree.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { Project, POU } from '../shared/types.js';

export interface TreeProps {
  project: Project;
  cursorPath: string;
  expanded: Set<string>;
}

export function devicePath(deviceName: string): string {
  return `device:${deviceName}`;
}
export function pouPath(deviceName: string, relPath: string): string {
  return `pou:${deviceName}:${relPath}`;
}

export function Tree({ project, cursorPath, expanded }: TreeProps): React.ReactElement {
  const rows: React.ReactElement[] = [];
  for (const dev of project.devices) {
    const dPath = devicePath(dev.name);
    const isExpanded = expanded.has(dPath);
    const isCursor = cursorPath === dPath;
    rows.push(
      <Text key={dPath}>
        {isCursor ? '▶ ' : '  '}
        {isExpanded ? '▾ ' : '▸ '}
        {dev.name}  {dev.pous.length} POUs
      </Text>
    );
    if (!isExpanded) continue;
    for (const p of dev.pous) {
      const pPath = pouPath(dev.name, p.relPath);
      const isPCursor = cursorPath === pPath;
      rows.push(
        <Text key={pPath}>
          {isPCursor ? '▶ ' : '    '}
          {p.name.padEnd(18)} {p.kind.padEnd(6)} {String(p.loc).padStart(4)} L
        </Text>
      );
    }
  }
  return <Box flexDirection="column">{rows}</Box>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tui/Tree.test.tsx`

Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tui/browser/Tree.tsx tests/tui/Tree.test.tsx
git commit -m "tui: add Tree component (collapsible device/POU listing)"
```

---

## Task 11: Viewer component (browser mode)

**Files:**
- Create: `src/tui/browser/Viewer.tsx`

- [ ] **Step 1: Implement the viewer (no syntax highlighting in v0.1)**

Create `src/tui/browser/Viewer.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { POU } from '../shared/types.js';

export interface ViewerProps {
  pou: POU | null;
  text: string | null;
  scrollTop: number;
  visibleRows: number;
}

export function Viewer({ pou, text, scrollTop, visibleRows }: ViewerProps): React.ReactElement {
  if (!pou || text == null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>(no POU selected)</Text>
      </Box>
    );
  }
  const lines = text.split(/\r?\n/);
  const slice = lines.slice(scrollTop, scrollTop + visibleRows);
  return (
    <Box flexDirection="column">
      <Text bold>
        {pou.name}.st  ({pou.kind}, {pou.loc} L)
      </Text>
      {slice.map((l, i) => (
        <Text key={scrollTop + i}>
          {String(scrollTop + i + 1).padStart(4, ' ')}  {l}
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: Smoke-build**

Run: `npm run build:tui`

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/tui/browser/Viewer.tsx
git commit -m "tui: add plain-text Viewer (highlighting deferred)"
```

---

## Task 12: Browser composer + state writes

**Files:**
- Create: `src/tui/browser/Browser.tsx`
- Create: `tests/tui/Browser.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/tui/Browser.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Browser } from '../../src/tui/browser/Browser.tsx';
import { Project } from '../../src/tui/shared/types.ts';

const project: Project = {
  rootDir: '/p',
  mirrorMtimeMs: 0,
  devices: [
    {
      name: 'D1',
      pous: [
        { name: 'PLC_PRG', kind: 'PRG', relPath: 'PLC_PRG.st', absPath: '/abs/PLC_PRG.st', loc: 5, mtimeMs: 0 },
        { name: 'FB_X',     kind: 'FB',  relPath: 'FB_X.st',     absPath: '/abs/FB_X.st',     loc: 9, mtimeMs: 0 },
      ],
    },
  ],
};

describe('<Browser>', () => {
  it('shows device row, expands it on l, then moves cursor onto the first POU on j', () => {
    const onWriteSelection = vi.fn();
    const readPou = async () => 'PROGRAM PLC_PRG\nEND_PROGRAM';
    const { stdin, lastFrame } = render(
      <Browser
        project={project}
        readPou={readPou}
        writeSelection={onWriteSelection}
        onQuit={() => {}}
      />
    );
    expect(lastFrame()).toContain('D1');
    stdin.write('l'); // expand device
    expect(lastFrame()).toContain('PLC_PRG');
    stdin.write('j'); // move cursor onto PLC_PRG
    expect(lastFrame()).toMatch(/▶ PLC_PRG/);
  });

  it('calls writeSelection when a POU is highlighted', async () => {
    const onWriteSelection = vi.fn();
    const readPou = async () => 'PROGRAM X\nEND_PROGRAM';
    const { stdin } = render(
      <Browser
        project={project}
        readPou={readPou}
        writeSelection={onWriteSelection}
        onQuit={() => {}}
      />
    );
    stdin.write('l');
    stdin.write('j');
    // give the debounce a beat
    await new Promise((r) => setTimeout(r, 250));
    expect(onWriteSelection).toHaveBeenCalled();
    const arg = onWriteSelection.mock.calls.at(-1)![0];
    expect(arg.device).toBe('D1');
    expect(arg.pou.name).toBe('PLC_PRG');
  });

  it('calls onQuit on q', () => {
    const onQuit = vi.fn();
    const { stdin } = render(
      <Browser
        project={project}
        readPou={async () => ''}
        writeSelection={() => {}}
        onQuit={onQuit}
      />
    );
    stdin.write('q');
    expect(onQuit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tui/Browser.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `<Browser>`**

Create `src/tui/browser/Browser.tsx`:

```tsx
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Project, POU, Selection } from '../shared/types.js';
import { Tree, devicePath, pouPath } from './Tree.js';
import { Viewer } from './Viewer.js';

export interface BrowserProps {
  project: Project;
  readPou: (pou: POU) => Promise<string>;
  writeSelection: (s: Selection) => void;
  onQuit: () => void;
}

interface FlatRow {
  path: string;
  kind: 'device' | 'pou';
  device: string;
  pou?: POU;
}

function flatten(project: Project, expanded: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const dev of project.devices) {
    rows.push({ path: devicePath(dev.name), kind: 'device', device: dev.name });
    if (!expanded.has(devicePath(dev.name))) continue;
    for (const p of dev.pous) {
      rows.push({ path: pouPath(dev.name, p.relPath), kind: 'pou', device: dev.name, pou: p });
    }
  }
  return rows;
}

export function Browser({ project, readPou, writeSelection, onQuit }: BrowserProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [cursorIdx, setCursorIdx] = React.useState(0);
  const [text, setText] = React.useState<string | null>(null);
  const [scrollTop] = React.useState(0);

  const rows = React.useMemo(() => flatten(project, expanded), [project, expanded]);
  const cursor = rows[Math.min(cursorIdx, rows.length - 1)];

  // Debounced selection write whenever a POU is highlighted.
  React.useEffect(() => {
    if (!cursor || cursor.kind !== 'pou' || !cursor.pou) return;
    const handle = setTimeout(() => {
      writeSelection({ device: cursor.device, pou: cursor.pou!, viewerLine: scrollTop + 1 });
    }, 200);
    return () => clearTimeout(handle);
  }, [cursor, scrollTop, writeSelection]);

  // Lazy file read whenever a POU is highlighted.
  React.useEffect(() => {
    if (!cursor || cursor.kind !== 'pou' || !cursor.pou) {
      setText(null);
      return;
    }
    let cancelled = false;
    readPou(cursor.pou).then((t) => {
      if (!cancelled) setText(t);
    });
    return () => {
      cancelled = true;
    };
  }, [cursor, readPou]);

  useInput((input, key) => {
    if (input === 'q') return onQuit();
    if (input === 'j' || key.downArrow) {
      setCursorIdx((i) => Math.min(i + 1, rows.length - 1));
    } else if (input === 'k' || key.upArrow) {
      setCursorIdx((i) => Math.max(i - 1, 0));
    } else if (input === 'l' || key.return || key.rightArrow) {
      if (cursor && cursor.kind === 'device') {
        setExpanded((e) => {
          const next = new Set(e);
          next.add(cursor.path);
          return next;
        });
      }
    } else if (input === 'h' || key.leftArrow) {
      if (cursor && cursor.kind === 'device') {
        setExpanded((e) => {
          const next = new Set(e);
          next.delete(cursor.path);
          return next;
        });
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text>─ {project.rootDir.split(/[/\\]/).pop()} ─</Text>
      <Box flexDirection="row">
        <Box flexDirection="column" width="40%">
          <Tree project={project} cursorPath={cursor?.path ?? ''} expanded={expanded} />
        </Box>
        <Box flexDirection="column" width="60%">
          <Viewer pou={cursor?.pou ?? null} text={text} scrollTop={scrollTop} visibleRows={20} />
        </Box>
      </Box>
      <Text>j/k nav  l expand  h collapse  q quit</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tui/Browser.test.tsx`

Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tui/browser/Browser.tsx tests/tui/Browser.test.tsx
git commit -m "tui: add Browser composer with debounced selection writes"
```

---

## Task 13: Browser-mode dispatch in `index.tsx`

**Files:**
- Modify: `src/tui/index.tsx`

- [ ] **Step 1: Wire browser mode into the dispatcher**

Replace `src/tui/index.tsx` with:

```tsx
#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import * as fs from 'fs/promises';
import { Approve, Decision } from './approve/Approve.js';
import { Browser } from './browser/Browser.js';
import { walk } from './shared/scan.js';
import { findProjectRoot } from './shared/discover.js';
import { writeSelection } from './shared/state-write.js';
import { stateFilePath } from './shared/state-paths.js';
import { Selection } from './shared/types.js';

const argv = process.argv.slice(2);

async function main(): Promise<number> {
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write('phobiCS-tui v0.1.0\n');
    return 0;
  }
  if (argv[0] === 'approve') return runApprove(argv[1], argv[2]);
  return runBrowser(argv[0]);
}

async function runBrowser(maybeRoot: string | undefined): Promise<number> {
  const root = maybeRoot
    ? maybeRoot
    : (await findProjectRoot(process.cwd())) ?? null;
  if (!root) {
    process.stderr.write(
      `No mcp-mirror/ found near ${process.cwd()}. Run mirror_export in CODESYS first.\n`
    );
    return 1;
  }
  let project;
  try {
    project = await walk(root);
  } catch (err) {
    process.stderr.write(`phobiCS-tui: ${(err as Error).message}\n`);
    return 1;
  }

  const stateFile = stateFilePath();

  return new Promise<number>((resolve) => {
    const onWriteSelection = (s: Selection) => {
      writeSelection(stateFile, project!.rootDir, s).catch((err) => {
        process.stderr.write(`phobiCS-tui: state write failed: ${err}\n`);
      });
    };
    const onQuit = () => {
      app.unmount();
      resolve(0);
    };
    const readPou = (pou: { absPath: string }) => fs.readFile(pou.absPath, 'utf8');
    const app = render(
      <Browser
        project={project!}
        readPou={readPou}
        writeSelection={onWriteSelection}
        onQuit={onQuit}
      />
    );
  });
}

async function runApprove(oldPath: string | undefined, newPath: string | undefined): Promise<number> {
  if (!oldPath || !newPath) {
    process.stderr.write('usage: phobiCS-tui approve <existing> <proposed>\n');
    return 2;
  }
  let oldText: string;
  let newText: string;
  try {
    oldText = await fs.readFile(oldPath, 'utf8');
    newText = await fs.readFile(newPath, 'utf8');
  } catch (err) {
    process.stderr.write(`phobiCS-tui: ${(err as Error).message}\n`);
    return 2;
  }
  return new Promise<number>((resolve) => {
    const onDecision = (d: Decision) => {
      app.unmount();
      resolve(d === 'accept' ? 0 : 1);
    };
    const fileName = oldPath.split(/[/\\]/).pop() ?? oldPath;
    const app = render(
      <Approve fileName={fileName} oldText={oldText} newText={newText} onDecision={onDecision} />
    );
    process.on('SIGTERM', () => {
      app.unmount();
      resolve(1);
    });
    process.on('SIGINT', () => {
      app.unmount();
      resolve(1);
    });
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`phobiCS-tui: ${err}\n`);
    process.exit(2);
  });
```

- [ ] **Step 2: Smoke-test the browser-mode error path**

Run:

```bash
npm run build
node dist/tui/index.js ./does-not-exist-phobics-test; echo "exit=$?"
```

This exercises the explicit-path + walk error path without needing a
TTY (browser mode itself needs interactive stdin and isn't easily
scriptable). The build also catches any TS compile error from the new
imports.

Expected stderr contains: `phobiCS-tui: No mcp-mirror/ found at ./does-not-exist-phobics-test. Run mirror_export in CODESYS first.`

Expected: `exit=1`.

- [ ] **Step 3: Commit**

```bash
git add src/tui/index.tsx
git commit -m "tui: wire browser dispatch with auto-discovery + state writes"
```

---

## Task 14: CJS state reader (used by MCP server)

**Files:**
- Create: `src/state-read.ts`
- Create: `tests/unit/state-read.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/state-read.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/state-read.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `readSelection`**

Create `src/state-read.ts`:

```ts
import * as fs from 'fs';

export const FRESHNESS_MS = 60_000;

export interface SelectionPayload {
  version: 1;
  updated_at: string;
  project_dir: string;
  device: string;
  selection: {
    kind: string;
    name: string;
    path: string;
    abs_path: string;
  };
  viewer_line: number;
}

export type ReadResult =
  | { status: 'ok'; payload: SelectionPayload }
  | { status: 'missing' }
  | { status: 'stale' }
  | { status: 'invalid'; reason: string };

export async function readSelection(filePath: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return { status: 'missing' };
  }
  let parsed: SelectionPayload;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'invalid', reason: (err as Error).message };
  }
  if (parsed.version !== 1) {
    return { status: 'invalid', reason: `unsupported version ${parsed.version}` };
  }
  const ageMs = Date.now() - new Date(parsed.updated_at).getTime();
  if (Number.isNaN(ageMs) || ageMs > FRESHNESS_MS) {
    return { status: 'stale' };
  }
  return { status: 'ok', payload: parsed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/state-read.test.ts`

Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/state-read.ts tests/unit/state-read.test.ts
git commit -m "feat(state): add CJS reader for phobiCS-tui state file"
```

---

## Task 15: Register `get_user_selection` MCP tool

**Files:**
- Modify: `src/server.ts`
- Create: `tests/unit/get-user-selection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/get-user-selection.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/get-user-selection.test.ts`

Expected: FAIL — `buildGetUserSelectionResponse` is not exported from `src/server`.

- [ ] **Step 3: Add the helper + register the tool**

Open `src/server.ts`. Add this near the top after the existing imports:

```ts
import { readSelection } from './state-read';
import * as osMod from 'os';
```

Then add this exported helper above `startMcpServer` (find the `startMcpServer` function near the bottom of the file; place the helper just before it):

```ts
export async function buildGetUserSelectionResponse(stateFilePath: string) {
  const r = await readSelection(stateFilePath);
  if (r.status === 'ok') {
    const lines = [
      `User is currently looking at:`,
      `  Device:  ${r.payload.device}`,
      `  POU:     ${r.payload.selection.name} (${r.payload.selection.kind})`,
      `  Path:    ${r.payload.selection.path}`,
      `  AbsPath: ${r.payload.selection.abs_path}`,
      `  Project: ${r.payload.project_dir}`,
      `  Viewer line: ${r.payload.viewer_line}`,
      `  Updated: ${r.payload.updated_at}`,
    ];
    return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: false };
  }
  if (r.status === 'invalid') {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Invalid TUI state file: ${r.reason}. No active selection.`,
        },
      ],
      isError: false,
    };
  }
  return {
    content: [{ type: 'text' as const, text: 'No active selection (TUI not running or stale).' }],
    isError: false,
  };
}

function defaultStateFilePath(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      return path.join(osMod.homedir(), 'AppData', 'Local', 'codesys-mcp', 'tui-state.json');
    }
    return path.join(localAppData, 'codesys-mcp', 'tui-state.json');
  }
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ?? path.join(osMod.homedir(), '.local', 'state');
  return path.join(base, 'codesys-mcp', 'tui-state.json');
}
```

(`defaultStateFilePath` is intentionally duplicated from `src/tui/shared/state-paths.ts`. The TUI subpackage is ESM and the MCP server is CJS; the duplication is ~10 lines and changes near-zero. Both functions live in their respective module systems with no cross-import.)

Then inside `startMcpServer`, register the tool. Find the registration of `get_codesys_status` (around `s.tool('get_codesys_status', ...)`) and add this directly after:

```ts
s.tool(
  'get_user_selection',
  'Get the POU the user is currently looking at in the phobiCS-tui browser, if any. Returns a freshness-checked snapshot from the TUI state file. Useful for grounding modifying tool calls in what the user has selected.',
  async () => buildGetUserSelectionResponse(defaultStateFilePath())
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/get-user-selection.test.ts`

Expected: PASS — 3 tests passing.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`

Expected: PASS — all existing tests plus the new ones.

- [ ] **Step 6: Build everything**

Run: `npm run build`

Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts tests/unit/get-user-selection.test.ts
git commit -m "feat(mcp): register get_user_selection tool"
```

---

## Task 16: Wire `--approve-edits` CLI flag (no-op plumbing)

**Files:**
- Modify: `src/bin.ts`
- Modify: `src/types.ts` (add `approveEdits?: boolean` to ServerConfig)
- Modify: `src/server.ts` (read it; v0.1 just logs that it's present)

- [ ] **Step 1: Add `approveEdits` to `ServerConfig`**

Open `src/types.ts`. Find the `ServerConfig` interface and add this field:

```ts
/**
 * If true, modifying tools (set_pou_code et al.) will shell out to
 * phobiCS-tui in approve mode and only proceed on exit 0. Off by default
 * so existing scripted flows are not regressed.
 */
approveEdits?: boolean;
```

- [ ] **Step 2: Add the CLI option to `src/bin.ts`**

Open `src/bin.ts`. In the `program.option(...)` chain near `--auto-mirror`, add:

```ts
.option('--approve-edits', 'Gate modifying MCP tools behind a phobiCS-tui y/n diff prompt', false)
```

In the config-build block (where `autoMirror: opts.autoMirror || false` is set), add:

```ts
approveEdits: opts.approveEdits || false,
```

In the startup banner (after the `Auto-mirror:` line), add:

```ts
if (config.approveEdits) {
  process.stderr.write(`  Approve edits: ENABLED (modifying tools will prompt via phobiCS-tui)\n`);
}
```

- [ ] **Step 3: Surface the flag in `src/server.ts`**

In `src/server.ts`, find the existing `serverLog.info(...)` startup lines (e.g. `serverLog.info(\`Mode: ${config.mode}\`)`). Add right after:

```ts
serverLog.info(`Approve edits: ${config.approveEdits ? 'ON' : 'off'}`);
```

(v0.1 stops here. Tasks that actually call the TUI from `set_pou_code` are part of v0.2-followup, not this plan — landing the flag now keeps the user-facing surface stable.)

- [ ] **Step 4: Build + run typecheck**

Run:

```bash
npm run build
npm run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 5: Smoke-test**

Run:

```bash
node dist/bin.js --help | grep approve
```

Expected stdout includes the line:

```
--approve-edits  Gate modifying MCP tools behind a phobiCS-tui y/n diff prompt (default: false)
```

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/bin.ts src/server.ts
git commit -m "feat(cli): add --approve-edits flag (off by default; v0.1 plumbing)"
```

---

## Task 17: Wire `set_pou_code` → approve TUI when `--approve-edits` is on

**Files:**
- Create: `src/approve-gate.ts`
- Create: `tests/unit/approve-gate.test.ts`
- Modify: `src/server.ts` (gate `set_pou_code` on the flag)

The gate reads the existing mirror `.st` for the POU (best-effort glob),
composes the proposed merged content using the same `(* === IMPLEMENTATION === *)`
sentinel CODESYS uses, then spawns `phobiCS-tui approve <existing>
<staged>`. Exit 0 → proceed with the script. Exit 1 → return a graceful
"user rejected" response. Exit 2 → return an error.

When the flag is off (default), `set_pou_code` runs unchanged.

- [ ] **Step 1: Write the failing test for the merge composer**

Create `tests/unit/approve-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { composeMergedContent, IMPL_SENTINEL } from '../../src/approve-gate';

const existing = [
  'PROGRAM PLC_PRG',
  'VAR',
  '  counter : INT := 0;',
  'END_VAR',
  IMPL_SENTINEL,
  'counter := counter + 1;',
].join('\n');

describe('composeMergedContent', () => {
  it('overrides only declaration when only declarationCode is provided', () => {
    const out = composeMergedContent(existing, {
      declarationCode: 'PROGRAM PLC_PRG\nVAR\n  counter : DINT := 0;\nEND_VAR',
      implementationCode: undefined,
    });
    expect(out).toContain('counter : DINT := 0;');
    expect(out).toContain('counter := counter + 1;'); // impl preserved
  });

  it('overrides only implementation when only implementationCode is provided', () => {
    const out = composeMergedContent(existing, {
      declarationCode: undefined,
      implementationCode: 'counter := counter + 2;',
    });
    expect(out).toContain('counter : INT := 0;'); // decl preserved
    expect(out).toContain('counter := counter + 2;');
  });

  it('overrides both when both are provided', () => {
    const out = composeMergedContent(existing, {
      declarationCode: 'PROGRAM X\nVAR\nEND_VAR',
      implementationCode: 'x := 1;',
    });
    expect(out).toBe(['PROGRAM X', 'VAR', 'END_VAR', IMPL_SENTINEL, 'x := 1;'].join('\n'));
  });

  it('handles existing files with no sentinel by appending one', () => {
    const noSentinel = 'PROGRAM PLC_PRG\nVAR\nEND_VAR';
    const out = composeMergedContent(noSentinel, {
      declarationCode: undefined,
      implementationCode: 'x := 1;',
    });
    expect(out).toContain(IMPL_SENTINEL);
    expect(out).toContain('x := 1;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/approve-gate.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the gate module**

Create `src/approve-gate.ts`:

```ts
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
  | { status: 'no-existing' } // mirror file not found; gate skipped, caller proceeds
  | { status: 'error'; message: string };

/**
 * Splits an existing merged .st file into its decl and impl halves at the
 * IMPL_SENTINEL line. If the sentinel is absent, returns the whole text as
 * decl and an empty impl.
 */
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

/**
 * Best-effort search for the mirror .st file for the given POU. The pouPath
 * is typically 'Application/PLC_PRG' or 'Application/FB_Test.Method1'. We
 * glob the mirror tree for the leaf .st filename. Exactly-one match wins;
 * 0 or >1 matches return null and the gate falls back to no-existing.
 */
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
  // shallow recursive listing — the mirror tree depth is bounded
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

/**
 * Spawns phobiCS-tui in approve mode and returns the user's decision.
 * Resolves with the exit code mapped to a GateResult.
 */
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
  /** Override for the spawn function — used in tests to avoid actually launching the TUI. */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/approve-gate.test.ts`

Expected: PASS — 4 tests passing.

- [ ] **Step 5: Wire `runApproveGate` into `set_pou_code`**

In `src/server.ts`, add this import near the existing imports:

```ts
import { runApproveGate } from './approve-gate';
```

Then inside the `set_pou_code` tool handler, find this block:

```ts
const result = await executor.executeScript(script);
return await formatModifyingResponse(
  result,
  `Code set for '${sanPouPath}' in ${args.projectFilePath}. Project saved.`,
  escProjPath,
  mirrorCtx
);
```

Replace it with:

```ts
if (config.approveEdits) {
  const gate = await runApproveGate({
    projectFilePath: escProjPath,
    pouPath: sanPouPath,
    args: {
      declarationCode: args.declarationCode,
      implementationCode: args.implementationCode,
    },
  });
  if (gate.status === 'rejected') {
    return {
      content: [{ type: 'text' as const, text: gate.message }],
      isError: false,
    };
  }
  if (gate.status === 'error') {
    return {
      content: [{ type: 'text' as const, text: `Approve gate error: ${gate.message}` }],
      isError: true,
    };
  }
  // 'accepted' or 'no-existing' → fall through and apply the change.
}
const result = await executor.executeScript(script);
return await formatModifyingResponse(
  result,
  `Code set for '${sanPouPath}' in ${args.projectFilePath}. Project saved.`,
  escProjPath,
  mirrorCtx
);
```

- [ ] **Step 6: Build + typecheck**

Run:

```bash
npm run build
npm run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 7: Smoke-test the off path**

Run the existing fork test suite to make sure the gate is truly off when
the flag is off:

```bash
npm test
```

Expected: PASS — all tests green, no regression in any existing
`set_pou_code` test.

- [ ] **Step 8: Commit**

```bash
git add src/approve-gate.ts tests/unit/approve-gate.test.ts src/server.ts
git commit -m "feat(approve-gate): wire set_pou_code through phobiCS-tui when --approve-edits"
```

---

## Task 18: README + push

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a TUI section to `README.md`**

Open `README.md`. Find the "## Tools" section and add a new section just before it (or wherever Tools are introduced):

```markdown
## phobiCS-tui

This package ships a small Bubble Tea-style ink TUI for browsing
CODESYS-exported ST. After installing, run:

```
phobiCS-tui                          # auto-discovers mcp-mirror/ from cwd
phobiCS-tui <projectDir>             # explicit project directory
phobiCS-tui approve <a.st> <b.st>    # diff prompt; exit 0 = accept, 1 = reject, 2 = error
```

The browser writes the current selection to `%LOCALAPPDATA%/codesys-mcp/
tui-state.json` (Windows) or `~/.local/state/codesys-mcp/tui-state.json`
(Linux/Mac). The MCP tool `get_user_selection` reads it so an agent can
ground its actions in what the user is looking at.

Approve mode is opt-in for the MCP server's modifying tools — start the
server with `--approve-edits` to wire it in. Off by default.
```

- [ ] **Step 2: Commit + push**

```bash
git add README.md
git commit -m "docs: README section for phobiCS-tui + --approve-edits"
git push origin main
```

---

## Self-review checklist (run before declaring done)

- [ ] Every spec section in `docs/superpowers/specs/2026-04-28-tui-design.md` v0.1/v0.2 is covered by a task above.
- [ ] No "TBD" / "implement later" / "similar to Task N" anywhere.
- [ ] Every component named in one task is referenced consistently in later tasks (case + spelling).
- [ ] Tests precede implementation in every task.
- [ ] Every commit message starts with `feat:` / `fix:` / `tui:` / `docs:` / etc. — matches the fork's existing style (`fix(server):`, `feat(cli):`).
- [ ] `npm run build` succeeds at the end of every task that touches code.
- [ ] `npm test` succeeds at the end of Task 15.
- [ ] The `dist/tui/index.js` shebang prepend works on Windows (the build script uses Node, not POSIX `chmod +x`).

## Out of scope for v0.1 / v0.2 (deferred)

- Syntax highlighting in `<Viewer>` (plain text in v0.1; revisit when needed).
- Side-by-side diff toggle (`v` keybind in approve mode).
- Cross-device diff (`d` keybind in browser mode).
- Filter input (`/` keybind).
- Open in VSCode (`o` keybind).
- Re-scan (`r` keybind) — the TUI scans once at startup; users restart it for now.
- Help overlay (`?` keybind).
- Stale-mirror indicator in the statusbar.
- Resize warning on small terminals.
- Approve-gate wiring for tools other than `set_pou_code` (e.g., `delete_object`,
  `rename_object`, `create_method`). v0.1 wires only `set_pou_code`. The other
  modifying tools stay un-gated until a follow-up plan extends `runApproveGate`.
- `connect_to_device` script fix (separate fork PR per the spec).
- v0.3 inline live values (blocked on `connect_to_device` fix).
- v0.4 online dashboard.
