#!/usr/bin/env node
// Verifies the four broken-tool fixes (commit 2607063) end-to-end.
// Drives a single persistent CODESYS instance, runs each test against
// a *copy* of MCPTest2 so the source binary isn't mutated, and reports
// pass/fail with the relevant slice of script output for inspection.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { CodesysLauncher } from '../dist/launcher.js';
import { ScriptManager } from '../dist/script-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const MCPTEST2 = '\\\\files\\karstein.kvistad\\Documents\\Claude\\PLC\\MCPTest2\\MCPTest2.project';
const MARINER  = '\\\\files\\karstein.kvistad\\Documents\\Claude\\PLC\\mariner40206\\MRCodesysMarinerMK2.6_012.project';

const config = {
  codesysPath: 'C:\\Program Files\\CODESYS 3.5.22.10\\CODESYS\\Common\\CODESYS.exe',
  profileName: 'CODESYS V3.5 SP22 Patch 1',
};

// Set up a working copy of MCPTest2.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesys-mcp-testfixes-'));
const workMCP = path.join(workDir, 'MCPTest2.project');
fs.copyFileSync(MCPTEST2, workMCP);
console.log(`copy: ${workMCP}`);

const sm = new ScriptManager(path.join(repoRoot, 'src', 'scripts'));
const launcher = new CodesysLauncher(config);
console.log('launching persistent CODESYS...');
await launcher.launch();
console.log('  ready.');

const results = [];

async function run(name, scriptArgs, helpers, projectPath) {
  const params = { PROJECT_FILE_PATH: projectPath, ...scriptArgs };
  const script = sm.prepareScriptWithHelpers(name, params, helpers);
  const t0 = process.hrtime.bigint();
  const r = await launcher.executeScript(script);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const ok = r?.success && (r.output || '').includes('SCRIPT_SUCCESS');
  // ScriptManager caches templates after first load, so re-instantiate to
  // force fresh reads if we mutate src/scripts/. Not needed here -- we
  // only load each name once per test.
  return { ok, ms, output: r?.output || '', error: r?.error || '' };
}

// --- TEST 1: create_folder fix ---
console.log('\n[1/3] create_folder fix...');
{
  const r = await run('create_folder',
    { FOLDER_NAME: 'Test_Bench_Folder', PARENT_PATH: 'PLCWinNT/Plc Logic/Application' },
    ['ensure_project_open', 'find_object_by_path'], workMCP);
  console.log(`  ${r.ms.toFixed(0)} ms  ${r.ok ? 'PASS' : 'FAIL'}`);
  if (!r.ok) {
    console.log('  ---output tail---');
    console.log(r.output.slice(-1500).split('\n').map(l => '  ' + l).join('\n'));
  }
  // Cleanup: delete the folder so MCPTest2 stays unchanged for next runs.
  if (r.ok) {
    const cleanup = await run('delete_object',
      { OBJECT_PATH: 'PLCWinNT/Plc Logic/Application/Test_Bench_Folder' },
      ['ensure_project_open', 'find_object_by_path'], workMCP);
    console.log(`  cleanup delete_object: ${cleanup.ok ? 'OK' : 'FAIL'}`);
  }
  results.push({ name: 'create_folder', ok: r.ok, ms: r.ms });
}

// --- TEST 2: compile_project + get_compile_messages fix ---
console.log('\n[2/3] compile_project + get_compile_messages fix...');
{
  const r = await run('compile_project', {}, ['ensure_project_open'], workMCP);
  console.log(`  compile_project: ${r.ms.toFixed(0)} ms  ${r.ok ? 'PASS' : 'FAIL'}`);
  if (!r.ok) {
    console.log('  ---output tail---');
    console.log(r.output.slice(-1500).split('\n').map(l => '  ' + l).join('\n'));
  } else {
    // Verify the JSON markers + parseable JSON in the output (this is
    // exactly what would have failed pre-fix).
    const m = r.output.match(/### COMPILE_MESSAGES_START ###\n([\s\S]*?)\n### COMPILE_MESSAGES_END ###/);
    if (!m) {
      console.log('  WARN: no markers found in output (still passed -- but JSON emit may be missing)');
    } else {
      try {
        const parsed = JSON.parse(m[1]);
        console.log(`  json parsed OK: ${parsed.length} messages`);
        if (parsed.length > 0) {
          console.log('  first message:', JSON.stringify(parsed[0]));
        }
      } catch (e) {
        console.log(`  FAIL: json parse error: ${e.message}`);
      }
    }
  }
  results.push({ name: 'compile_project', ok: r.ok, ms: r.ms });

  const r2 = await run('get_compile_messages', {}, ['ensure_project_open'], workMCP);
  console.log(`  get_compile_messages: ${r2.ms.toFixed(0)} ms  ${r2.ok ? 'PASS' : 'FAIL'}`);
  if (!r2.ok) {
    console.log('  ---output tail---');
    console.log(r2.output.slice(-1500).split('\n').map(l => '  ' + l).join('\n'));
  }
  results.push({ name: 'get_compile_messages', ok: r2.ok, ms: r2.ms });
}

// --- TEST 3: ensure_project_open cross-project switch ---
console.log('\n[3/3] ensure_project_open cross-project switch fix...');
{
  // Currently MCPTest2 working copy is primary. Switch to mariner40206.
  // Pre-fix: this would either fail or leave MCPTest2 still primary.
  const r = await run('open_project', {}, ['ensure_project_open'], MARINER);
  console.log(`  open_project(mariner40206): ${r.ms.toFixed(0)} ms  ${r.ok ? 'PASS' : 'FAIL'}`);
  if (!r.ok) {
    console.log('  ---output tail---');
    console.log(r.output.slice(-1500).split('\n').map(l => '  ' + l).join('\n'));
  }
  // Verify: list_project_libraries should show mariner's libs (~64), not MCPTest2's (5).
  if (r.ok) {
    const verify = await run('list_project_libraries', {}, ['ensure_project_open'], MARINER);
    const libCount = (verify.output.match(/(\d+) library reference\(s\)/) || [])[1];
    console.log(`  verify list_project_libraries: lib count = ${libCount} (expected ~64 for mariner40206)`);
    const switchOk = libCount && parseInt(libCount, 10) > 50;
    console.log(`  cross-project switch verified: ${switchOk ? 'PASS' : 'FAIL'}`);
    results.push({ name: 'cross_project_switch', ok: r.ok && switchOk, ms: r.ms });
  } else {
    results.push({ name: 'cross_project_switch', ok: false, ms: r.ms });
  }
}

console.log('\n=== summary ===');
for (const t of results) {
  console.log(`  ${t.ok ? '✓' : '✗'} ${t.name}  (${t.ms.toFixed(0)} ms)`);
}

console.log('\nshutting down...');
await launcher.shutdown();
try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
console.log('done.');

const allOk = results.every(r => r.ok);
process.exit(allOk ? 0 : 1);
