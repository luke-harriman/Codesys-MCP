#!/usr/bin/env node
// Headless vs Persistent mode benchmark for the Codesys-MCP fork.
//
// Drives CODESYS directly via the compiled HeadlessExecutor and
// CodesysLauncher classes (no MCP server in the loop -- pure timing of
// the underlying script-execution machinery).
//
// Test corpus:
//   - read-only tools that drive CODESYS scripting  (mirror_export,
//     list_project_libraries, get_all_pou_code, get_application_state,
//     save_project)
//   - write tools that mutate the project (create_pou + set_pou_code +
//     delete_object), run on a *copy* of the source project so the
//     original is untouched.
//
// Usage:
//   node tests/bench.mjs --project <path> --codesys <path-to-CODESYS.exe>
//                        --profile "<profile-name>" --iterations 2
//                        --modes headless,persistent --out tests/bench-results.json
//
// Defaults are tuned for Karstein's setup (MCPTest2 + CODESYS V3.5 SP22 P1).

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { CodesysLauncher } from '../dist/launcher.js';
import { HeadlessExecutor } from '../dist/headless.js';
import { ScriptManager } from '../dist/script-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// ---- args ----
const argv = process.argv.slice(2);
const args = {
  project: '\\\\files\\karstein.kvistad\\Documents\\Claude\\PLC\\MCPTest2\\MCPTest2.project',
  codesys: 'C:\\Program Files\\CODESYS 3.5.22.10\\CODESYS\\Common\\CODESYS.exe',
  profile: 'CODESYS V3.5 SP22 Patch 1',
  iterations: 2,
  modes: 'headless,persistent',
  out: path.join(repoRoot, 'tests', 'bench-results.json'),
};
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '');
  const v = argv[i + 1];
  if (k && v !== undefined) { args[k] = v; i++; }
}
args.iterations = Number(args.iterations);
const modes = args.modes.split(',').map(m => m.trim()).filter(Boolean);

console.log('=== bench config ===');
console.log(JSON.stringify({ project: args.project, codesys: args.codesys, profile: args.profile, iterations: args.iterations, modes, out: args.out }, null, 2));

// Set up a working copy of the project so write tests don't mutate the source.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesys-mcp-bench-'));
const projectName = path.basename(args.project);
const workProjectPath = path.join(workDir, projectName);
fs.copyFileSync(args.project, workProjectPath);
console.log(`copied project -> ${workProjectPath}`);

// ScriptManager points to the source script templates.
const scriptManager = new ScriptManager(path.join(repoRoot, 'src', 'scripts'));

// ---- test cases ----
// Each case prepares a fresh script (template + helpers) and ships it to the
// executor under test. `kind` is for the report grouping. `mutating` cases run
// AFTER all read-only cases so reads are repeatable.
//
// Note: for write cases we wrap a create/use/delete cycle into a single
// "session" -- the test measures the create+set+delete trio together
// because that's how a real user-driven edit lands.
function buildCases(projectFilePath) {
  const helper = (name, params, helpers = ['ensure_project_open']) =>
    scriptManager.prepareScriptWithHelpers(name, { PROJECT_FILE_PATH: projectFilePath, ...params }, helpers);

  return [
    // -- read-only: cold (CODESYS may have just spawned) --
    { id: 'open_project', kind: 'read', script: () => helper('open_project', {}) },
    { id: 'mirror_export', kind: 'read', script: () => helper('mirror_export', { MIRROR_ROOT: path.join(workDir, 'mcp-mirror') }) },
    { id: 'list_project_libraries', kind: 'read', script: () => helper('list_project_libraries', {}) },
    { id: 'get_all_pou_code', kind: 'read', script: () => helper('get_all_pou_code', {}) },
    { id: 'save_project', kind: 'read', script: () => helper('save_project', {}) },

    // -- write: create_pou + set_pou_code + delete_object on a throwaway FB --
    { id: 'create_pou (FB)', kind: 'write', script: () => helper('create_pou', {
        POU_NAME: 'FB_Bench',
        POU_TYPE_STR: 'FunctionBlock',
        IMPL_LANGUAGE_STR: 'ST',
        PARENT_PATH: 'PLCWinNT/Plc Logic/Application',
      }, ['ensure_project_open', 'find_object_by_path']) },
    { id: 'set_pou_code (decl+impl)', kind: 'write', script: () => helper('set_pou_code', {
        POU_FULL_PATH: 'PLCWinNT/Plc Logic/Application/FB_Bench',
        DECLARATION_CONTENT: 'FUNCTION_BLOCK FB_Bench\nVAR_INPUT\n    iX : INT;\nEND_VAR\nVAR_OUTPUT\n    iY : INT;\nEND_VAR',
        IMPLEMENTATION_CONTENT: 'iY := iX * 2;',
        SET_DECLARATION: 'True',
        SET_IMPLEMENTATION: 'True',
      }, ['ensure_project_open', 'find_object_by_path']) },
    { id: 'delete_object (FB_Bench)', kind: 'write', script: () => helper('delete_object', {
        OBJECT_PATH: 'PLCWinNT/Plc Logic/Application/FB_Bench',
      }, ['ensure_project_open', 'find_object_by_path']) },

    // -- write: bump_project_version build, then a second build to push it again
    //          (each build bump is a small +1, easily reversed in followups).
    //          Includes the post-fix sanity-check overhead.
    { id: 'bump_project_version (build)', kind: 'write', script: () => helper('bump_project_version', { LEVEL: 'build' }) },
    { id: 'bump_project_version (build #2)', kind: 'write', script: () => helper('bump_project_version', { LEVEL: 'build' }) },
  ];
}

const cases = buildCases(workProjectPath);

// ---- runner ----
async function runOne(executor, c) {
  const t0 = process.hrtime.bigint();
  const res = await executor.executeScript(c.script());
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  const ok = !!res?.success && (res.output || '').includes('SCRIPT_SUCCESS');
  return { ms, ok, outputBytes: (res?.output || '').length, errorBytes: (res?.error || '').length };
}

async function runMode(modeName) {
  console.log(`\n=== mode: ${modeName} ===`);
  const config = {
    codesysPath: args.codesys,
    profileName: args.profile,
  };

  let executor;
  let teardown = async () => {};
  if (modeName === 'headless') {
    executor = new HeadlessExecutor(config);
  } else if (modeName === 'persistent') {
    const launcher = new CodesysLauncher(config);
    console.log('  launching persistent CODESYS...');
    const launchT0 = process.hrtime.bigint();
    await launcher.launch();
    const launchMs = Number(process.hrtime.bigint() - launchT0) / 1e6;
    console.log(`  persistent CODESYS ready in ${launchMs.toFixed(0)} ms`);
    executor = launcher;
    teardown = async () => {
      console.log('  shutting down persistent CODESYS...');
      await launcher.shutdown();
    };
  } else {
    throw new Error(`unknown mode '${modeName}'`);
  }

  const results = [];
  for (const c of cases) {
    const runs = [];
    // For mutating cases, reset state between iterations: re-copy the
    // project and re-set executor's project context. Simpler approach:
    // for read-only cases run iterations*N; for write cases run only
    // ONCE (the cycle is create/set/delete which is itself self-resetting).
    const iters = c.kind === 'read' ? args.iterations : 1;
    for (let i = 0; i < iters; i++) {
      process.stdout.write(`  ${c.id} (${c.kind}, iter ${i + 1}/${iters}) ... `);
      const r = await runOne(executor, c);
      console.log(`${r.ms.toFixed(0)} ms  ${r.ok ? 'OK' : 'FAIL'}`);
      runs.push(r);
    }
    const okMs = runs.filter(r => r.ok).map(r => r.ms);
    const summary = okMs.length === 0
      ? { id: c.id, kind: c.kind, n: runs.length, allFailed: true }
      : {
          id: c.id, kind: c.kind, n: runs.length,
          min: Math.min(...okMs), max: Math.max(...okMs),
          mean: okMs.reduce((a, b) => a + b, 0) / okMs.length,
          okCount: okMs.length, runs,
        };
    results.push(summary);
  }

  await teardown();
  return results;
}

// ---- main ----
const allResults = {};
for (const mode of modes) {
  try {
    allResults[mode] = await runMode(mode);
  } catch (e) {
    console.error(`mode '${mode}' failed:`, e);
    allResults[mode] = { error: e.message };
  }
}

const finalReport = {
  timestamp: new Date().toISOString(),
  config: { project: args.project, codesys: args.codesys, profile: args.profile, iterations: args.iterations },
  workDir,
  results: allResults,
};
fs.writeFileSync(args.out, JSON.stringify(finalReport, null, 2), 'utf-8');
console.log(`\nwrote ${args.out}`);

// Print a quick markdown table for terminal-readable comparison.
console.log('\n=== summary (mean ms, OK iterations only) ===');
const ids = [...new Set(modes.flatMap(m => (allResults[m] || []).map ? allResults[m].map(r => r.id) : []))];
const header = `| Test | ${modes.map(m => `${m} (mean ms / min / max)`).join(' | ')} |`;
const sep    = `|------|${modes.map(() => '------').join('|')}|`;
console.log(header);
console.log(sep);
for (const id of ids) {
  const row = [`| ${id}`];
  for (const m of modes) {
    const r = (allResults[m] || []).find?.(x => x.id === id);
    if (!r) row.push(' n/a ');
    else if (r.allFailed) row.push(' FAIL ');
    else row.push(` ${r.mean.toFixed(0)} / ${r.min.toFixed(0)} / ${r.max.toFixed(0)} `);
  }
  row.push('|');
  console.log(row.join('|'));
}
console.log('');

// Cleanup work dir
try {
  fs.rmSync(workDir, { recursive: true, force: true });
  console.log(`cleaned up work dir: ${workDir}`);
} catch (e) {
  console.warn(`could not clean up work dir: ${e}`);
}
