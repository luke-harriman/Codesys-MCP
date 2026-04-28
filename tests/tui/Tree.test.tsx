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
    expect(out).toMatch(/▶ FB_Test/);
  });
});
