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
        { name: 'PLC_PRG', kind: 'PRG', relPath: 'PLC_PRG.st', absPath: '/abs/D1/PLC_PRG.st', loc: 5, mtimeMs: 0 },
        { name: 'FB_X',     kind: 'FB',  relPath: 'FB_X.st',     absPath: '/abs/D1/FB_X.st',     loc: 9, mtimeMs: 0 },
      ],
    },
    {
      name: 'D2',
      pous: [
        { name: 'PLC_PRG', kind: 'PRG', relPath: 'PLC_PRG.st', absPath: '/abs/D2/PLC_PRG.st', loc: 5, mtimeMs: 0 },
      ],
    },
  ],
};

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('<Browser>', () => {
  it('shows device row, expands it on l, then moves cursor onto the first POU on j', async () => {
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
    await flush();
    expect(lastFrame()).toContain('D1');
    stdin.write('l');
    await flush();
    expect(lastFrame()).toContain('PLC_PRG');
    stdin.write('j');
    await flush();
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
    await flush();
    stdin.write('l');
    await flush();
    stdin.write('j');
    await new Promise((r) => setTimeout(r, 250));
    expect(onWriteSelection).toHaveBeenCalled();
    const arg = onWriteSelection.mock.calls.at(-1)![0];
    expect(arg.device).toBe('D1');
    expect(arg.pou.name).toBe('PLC_PRG');
  });

  it('calls onQuit on q', async () => {
    const onQuit = vi.fn();
    const { stdin } = render(
      <Browser
        project={project}
        readPou={async () => ''}
        writeSelection={() => {}}
        onQuit={onQuit}
      />
    );
    await flush();
    stdin.write('q');
    await flush();
    expect(onQuit).toHaveBeenCalled();
  });

  it('d on a POU with one same-name peer in another device opens the cross-device diff', async () => {
    const reads: Record<string, string> = {
      '/abs/D1/PLC_PRG.st': 'PROGRAM PLC_PRG\nVAR\n  v : INT;\nEND_VAR',
      '/abs/D2/PLC_PRG.st': 'PROGRAM PLC_PRG\nVAR\n  v : DINT;\nEND_VAR',
    };
    const { stdin, lastFrame } = render(
      <Browser
        project={project}
        readPou={async (pou) => reads[pou.absPath] ?? ''}
        writeSelection={() => {}}
        onQuit={() => {}}
      />
    );
    await flush();
    stdin.write('l');
    await flush();
    stdin.write('j');
    await flush();
    stdin.write('d');
    await flush();
    // wait for both readPou promises to settle
    await new Promise((r) => setTimeout(r, 50));
    const out = lastFrame()!;
    expect(out).toMatch(/Cross-device diff/);
    expect(out).toContain('D1');
    expect(out).toContain('D2');
  });

  it('toggles a help overlay on ?', async () => {
    const { stdin, lastFrame } = render(
      <Browser
        project={project}
        readPou={async () => ''}
        writeSelection={() => {}}
        onQuit={() => {}}
      />
    );
    await flush();
    expect(lastFrame()).not.toContain('Keybindings');
    stdin.write('?');
    await flush();
    expect(lastFrame()).toContain('Keybindings');
    stdin.write('?');
    await flush();
    expect(lastFrame()).not.toContain('Keybindings');
  });

  it('/ enters filter mode; typed chars filter the POU list', async () => {
    const { stdin, lastFrame } = render(
      <Browser
        project={project}
        readPou={async () => ''}
        writeSelection={() => {}}
        onQuit={() => {}}
      />
    );
    await flush();
    stdin.write('/');
    await flush();
    expect(lastFrame()).toMatch(/Filter:/);
    stdin.write('F');
    stdin.write('B');
    await flush();
    expect(lastFrame()).toContain('FB_X');
    expect(lastFrame()).not.toContain('PLC_PRG');
  });

  it('Esc cancels filter mode and clears the filter', async () => {
    const { stdin, lastFrame } = render(
      <Browser
        project={project}
        readPou={async () => ''}
        writeSelection={() => {}}
        onQuit={() => {}}
      />
    );
    await flush();
    stdin.write('l');
    await flush();
    stdin.write('/');
    await flush();
    stdin.write('F');
    await flush();
    stdin.write('B');
    await flush();
    expect(lastFrame()).not.toContain('PLC_PRG');
    stdin.write(String.fromCharCode(27));
    await flush();
    expect(lastFrame()).toContain('PLC_PRG');
    expect(lastFrame()).not.toMatch(/Filter:/);
  });

  it('calls onOpenInEditor on o with the highlighted POU absPath', async () => {
    const onOpenInEditor = vi.fn();
    const { stdin } = render(
      <Browser
        project={project}
        readPou={async () => ''}
        writeSelection={() => {}}
        onQuit={() => {}}
        onOpenInEditor={onOpenInEditor}
      />
    );
    await flush();
    stdin.write('l');
    await flush();
    stdin.write('j');
    await flush();
    stdin.write('o');
    await flush();
    expect(onOpenInEditor).toHaveBeenCalledWith('/abs/D1/PLC_PRG.st');
  });

  it('does not call onOpenInEditor when cursor is on a device row', async () => {
    const onOpenInEditor = vi.fn();
    const { stdin } = render(
      <Browser
        project={project}
        readPou={async () => ''}
        writeSelection={() => {}}
        onQuit={() => {}}
        onOpenInEditor={onOpenInEditor}
      />
    );
    await flush();
    stdin.write('o');
    await flush();
    expect(onOpenInEditor).not.toHaveBeenCalled();
  });

  it('calls onRescan on r', async () => {
    const onRescan = vi.fn();
    const { stdin } = render(
      <Browser
        project={project}
        readPou={async () => ''}
        writeSelection={() => {}}
        onQuit={() => {}}
        onRescan={onRescan}
      />
    );
    await flush();
    stdin.write('r');
    await flush();
    expect(onRescan).toHaveBeenCalled();
  });

  it('closes the help overlay on Esc', async () => {
    const { stdin, lastFrame } = render(
      <Browser
        project={project}
        readPou={async () => ''}
        writeSelection={() => {}}
        onQuit={() => {}}
      />
    );
    await flush();
    stdin.write('?');
    await flush();
    expect(lastFrame()).toContain('Keybindings');
    stdin.write(String.fromCharCode(27));
    await flush();
    expect(lastFrame()).not.toContain('Keybindings');
  });
});
