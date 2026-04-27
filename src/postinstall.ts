#!/usr/bin/env node
/**
 * Runs after `npm install [-g] codesys-mcp-sp21-plus`.
 *
 * Goals:
 *   - Confirm to the user that the install worked + show the version
 *   - Dump the FULL ready-to-paste .mcp.json snippet for every detected install
 *   - Stay silent during dev (`npm install` inside a clone of the repo) and
 *     during CI to avoid polluting output.
 *
 * Failure-tolerant: any error (no Windows, no CODESYS, fs perms) is caught
 * and downgraded to a friendly note. We never block the install.
 */

function isDevOrCi(): boolean {
  // Skip during local installs / dev clones.
  if (process.env.npm_config_global !== 'true') return true;
  // Skip in CI.
  if (process.env.CI === 'true') return true;
  if (process.env.npm_config_ci === 'true') return true;
  return false;
}

async function main(): Promise<void> {
  if (isDevOrCi()) {
    return;
  }

  let version = 'unknown';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    version = require('../package.json').version;
  } catch {
    // ignore
  }

  process.stdout.write(`\n=== codesys-mcp-sp21-plus v${version} installed ===\n\n`);

  if (process.platform !== 'win32') {
    process.stdout.write(
      `(CODESYS detection only runs on Windows -- this server requires Windows + CODESYS.)\n\n`
    );
    return;
  }

  let installs: Array<{ serverName: string; profileName: string }>;
  let printConfig: (
    installs: unknown[],
    opts?: Record<string, unknown>
  ) => string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const detectMod = require('./detect');
    installs = detectMod.detectInstalls();
    printConfig = detectMod.printConfig;
  } catch (err) {
    process.stdout.write(
      `(CODESYS install detection failed: ${(err as Error).message})\n\n`
    );
    return;
  }

  if (installs.length === 0) {
    process.stdout.write(
      `No CODESYS installations detected under "C:\\Program Files" / "C:\\Program Files (x86)".\n` +
      `Install CODESYS first, then run \`codesys-mcp-sp21-plus --print-config\` to generate\n` +
      `the .mcp.json snippet.\n\n`
    );
    return;
  }

  process.stdout.write(`Add the following to your .mcp.json (Claude Code configuration):\n\n`);
  try {
    process.stdout.write(printConfig(installs) + '\n\n');
  } catch (err) {
    process.stdout.write(`(printConfig failed: ${(err as Error).message})\n\n`);
    return;
  }
  process.stdout.write(
    `Re-run anytime with: codesys-mcp-sp21-plus --print-config\n` +
    `Filter to one SP family with:  codesys-mcp-sp21-plus --print-config --sp 22\n\n`
  );
}

main().catch((err) => {
  // Never fail the install over a banner.
  process.stdout.write(`\n(post-install banner failed: ${(err as Error).message})\n\n`);
});
