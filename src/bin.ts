#!/usr/bin/env node
/**
 * CLI entry point for codesys-mcp-sp21-plus (Codesys-MCP-SP21+).
 */

import { program } from 'commander';
import { startMcpServer } from './server';
import { ServerConfig, ExecutionMode } from './types';
import { detectInstalls, printConfig } from './detect';

let version = '0.1.0';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('../package.json');
  version = pkg.version;
} catch {
  // ignore
}

program
  .name('codesys-mcp-sp21-plus')
  .description('MCP server for CODESYS with persistent UI instance')
  .version(version)
  .option(
    '-p, --codesys-path <path>',
    'Path to CODESYS executable',
    process.env.CODESYS_PATH || 'C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe'
  )
  .option(
    '-f, --codesys-profile <profile>',
    'CODESYS profile name',
    process.env.CODESYS_PROFILE || 'CODESYS V3.5 SP21'
  )
  .option(
    '-w, --workspace <dir>',
    'Workspace directory for relative project paths',
    process.cwd()
  )
  .option(
    '-m, --mode <mode>',
    'Execution mode: persistent (UI) or headless (--noUI)',
    'persistent'
  )
  .option('--no-auto-launch', 'Do not auto-launch CODESYS on startup')
  .option('--fallback-headless', 'Fall back to headless if persistent fails', true)
  .option('--keep-alive', 'Keep CODESYS running after server stops', false)
  .option('--auto-mirror', 'Re-run mirror_export after every modifying tool so an external editor watching <projectDir>/mcp-mirror/ sees changes live', false)
  .option('--timeout <ms>', 'Default command timeout in ms', '60000')
  .option('--verbose', 'Enable verbose logging')
  .option('--debug', 'Enable debug logging (more verbose)')
  .option('--detect', 'Detect installed CODESYS versions and exit')
  .option('--print-config', 'Print a ready-to-paste .mcp.json snippet for every detected install and exit')
  .option('--sp <number>', 'With --print-config: emit only the entry for CODESYS V3.5 SP<number>')
  .option('--name <name>', 'With --print-config --sp <n>: override the MCP server entry name')
  .parse(process.argv);

const opts = program.opts();

if (opts.detect) {
  const installs = detectInstalls();
  process.stderr.write('Scanning for CODESYS installations...\n\n');
  if (installs.length === 0) {
    process.stderr.write('  (no installations matching "CODESYS X.Y.Z.W" found)\n');
  } else {
    for (const i of installs) {
      process.stderr.write(`  [OK] ${i.installDir}\n`);
      process.stderr.write(`        Exe:     ${i.exePath}\n`);
      process.stderr.write(`        Profile: ${i.profileName}\n`);
      process.stderr.write(`        Suggested entry name: ${i.serverName}\n`);
    }
  }
  process.stderr.write(`\nFound ${installs.length} CODESYS installation(s).\n`);
  process.exit(0);
} else if (opts.printConfig) {
  const installs = detectInstalls();
  let sp: number | undefined;
  if (opts.sp !== undefined) {
    sp = parseInt(opts.sp, 10);
    if (Number.isNaN(sp)) {
      process.stderr.write(`--sp must be a number (e.g. --sp 21). Got "${opts.sp}".\n`);
      process.exit(1);
    }
  }
  try {
    process.stdout.write(printConfig(installs, { sp, name: opts.name }) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
} else {
  // Build server config
  const config: ServerConfig = {
    codesysPath: opts.codesysPath.trim(),
    profileName: opts.codesysProfile.trim(),
    workspaceDir: opts.workspace.trim(),
    autoLaunch: opts.autoLaunch !== false,
    keepAlive: opts.keepAlive || false,
    timeoutMs: parseInt(opts.timeout, 10) || 60000,
    fallbackHeadless: opts.fallbackHeadless !== false,
    verbose: opts.verbose || false,
    debug: opts.debug || false,
    mode: (opts.mode === 'headless' ? 'headless' : 'persistent') as ExecutionMode,
    autoMirror: opts.autoMirror || false,
  };

  process.stderr.write(`Starting CODESYS MCP Server v${version}\n`);
  process.stderr.write(`  CODESYS Path: ${config.codesysPath}\n`);
  process.stderr.write(`  Profile: ${config.profileName}\n`);
  process.stderr.write(`  Mode: ${config.mode}\n`);
  process.stderr.write(`  Auto-launch: ${config.autoLaunch}\n`);
  if (config.autoMirror) {
    process.stderr.write(`  Auto-mirror: ENABLED (mirror_export runs after every edit)\n`);
  }

  startMcpServer(config).catch((err) => {
    process.stderr.write(`FATAL: ${err.message}\n`);
    process.exit(1);
  });
}
