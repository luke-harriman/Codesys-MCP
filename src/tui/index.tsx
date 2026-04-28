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
