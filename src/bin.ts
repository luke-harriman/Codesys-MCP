#!/usr/bin/env node
/**
 * CLI entry point for codesys-mcp-sp21-plus (Codesys-MCP-SP21+).
 */

import { program } from 'commander';
import { startMcpServer } from './server';
import { ServerConfig, ExecutionMode } from './types';
import { detectInstalls, printConfig } from './detect';
import { inspectProjectFile, suggestedServerName } from './inspect';
import { readRunningVersionSsh, formatSshVersionResult } from './ssh-version';

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
  .option('--for-project <path>', 'With --print-config: pick only the install(s) matching the .project file at <path>. Mutually exclusive with --sp.')
  .option('--name <name>', 'With --print-config --sp <n>: override the MCP server entry name')
  .option('--inspect <path>', 'Read a CODESYS .project offline and print profile + mandatory libraries, then exit (no CODESYS needed)')
  .option('--ssh-version <host>', 'SSH to a CODESYS Control Linux PLC and print the running project version (extracted from the boot-application binary), then exit. Bypasses CODESYS entirely.')
  .option('--ssh-user <name>', 'With --ssh-version: SSH user (default "karstein")')
  .option('--ssh-boot-app <path>', 'With --ssh-version: path to the boot application on the PLC (default /var/opt/codesys/PlcLogic/Application/Application.app)')
  .parse(process.argv);

const opts = program.opts();

if (opts.sshVersion) {
  // --ssh-version emits to stdout (pipe-friendly); errors go to stderr with exit 1.
  readRunningVersionSsh({
    host: opts.sshVersion,
    user: opts.sshUser,
    bootAppPath: opts.sshBootApp,
  })
    .then((res) => {
      process.stdout.write(formatSshVersionResult(res) + '\n');
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    });
} else if (opts.inspect) {
  // --inspect emits to stdout (pipe-friendly); errors go to stderr with exit 1.
  inspectProjectFile(opts.inspect)
    .then((res) => {
      const lines: string[] = [];
      lines.push(`Project:         ${res.filePath}`);
      lines.push(`Profile name:    ${res.profileName}`);
      lines.push(`Profile version: ${res.profileVersion}`);
      const patchSuffix = res.patch === 0 ? ' Patch 0' : ` Patch ${res.patch}`;
      lines.push(`SP:              ${res.sp}${patchSuffix}`);
      lines.push(`Suggested entry: ${suggestedServerName(res.sp, res.patch)}`);
      lines.push('');
      lines.push(`Mandatory libraries (${res.mandatoryLibraries.length}):`);
      for (const lib of res.mandatoryLibraries) {
        const title = lib.title ?? '(unnamed)';
        const version = lib.version ?? '?';
        const guid = lib.typeGuid ? ` [TypeGuid: ${lib.typeGuid}]` : '';
        lines.push(`  - ${title} (${version})${guid}`);
      }
      process.stdout.write(lines.join('\n') + '\n');
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    });
} else if (opts.detect) {
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
  if (opts.forProject !== undefined && opts.sp !== undefined) {
    process.stderr.write(`--for-project and --sp are mutually exclusive\n`);
    process.exit(1);
  }
  const installs = detectInstalls();
  let sp: number | undefined;
  if (opts.sp !== undefined) {
    sp = parseInt(opts.sp, 10);
    if (Number.isNaN(sp)) {
      process.stderr.write(`--sp must be a number (e.g. --sp 21). Got "${opts.sp}".\n`);
      process.exit(1);
    }
  }
  if (opts.forProject !== undefined) {
    inspectProjectFile(opts.forProject)
      .then((res) => {
        const exact = installs.filter((i) => i.sp === res.sp && i.patch === res.patch);
        let filtered: typeof installs;
        let matchKind: 'exact' | 'sp-only-fallback';
        if (exact.length > 0) {
          filtered = exact;
          matchKind = 'exact';
        } else {
          const spOnly = installs.filter((i) => i.sp === res.sp);
          if (spOnly.length === 0) {
            process.stderr.write(
              `No installed CODESYS matches the project's required SP (${res.profileName}, version ${res.profileVersion}).\nRun --detect to see what's installed.\n`
            );
            process.exit(1);
          }
          filtered = spOnly;
          matchKind = 'sp-only-fallback';
        }
        try {
          process.stdout.write(
            printConfig(filtered, {
              name: opts.name,
              forProjectHint: {
                profileName: res.profileName,
                profileVersion: res.profileVersion,
                matchKind,
              },
            }) + '\n'
          );
          process.exit(0);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(1);
        }
      })
      .catch((err) => {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      });
  } else {
    try {
      process.stdout.write(printConfig(installs, { sp, name: opts.name }) + '\n');
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    }
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
