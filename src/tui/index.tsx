import React from 'react';
import { render } from 'ink';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
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
    const onOpenInEditor = (absPath: string) => {
      const editor = process.env.EDITOR || 'code';
      try {
        const child = spawn(editor, [absPath], { stdio: 'ignore', detached: true, shell: true });
        child.unref();
      } catch (err) {
        process.stderr.write(`phobiCS-tui: open-in-editor failed: ${(err as Error).message}\n`);
      }
    };
    const onRescan = async () => {
      try {
        const next = await walk(root);
        app.rerender(
          <Browser
            project={next}
            readPou={readPou}
            writeSelection={onWriteSelection}
            onQuit={onQuit}
            onRescan={onRescan}
            onOpenInEditor={onOpenInEditor}
          />
        );
      } catch (err) {
        process.stderr.write(`phobiCS-tui: rescan failed: ${(err as Error).message}\n`);
      }
    };
    const app = render(
      <Browser
        project={project!}
        readPou={readPou}
        writeSelection={onWriteSelection}
        onQuit={onQuit}
        onRescan={onRescan}
        onOpenInEditor={onOpenInEditor}
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
