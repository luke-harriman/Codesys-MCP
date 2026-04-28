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

  React.useEffect(() => {
    if (!cursor || cursor.kind !== 'pou' || !cursor.pou) return;
    const handle = setTimeout(() => {
      writeSelection({ device: cursor.device, pou: cursor.pou!, viewerLine: scrollTop + 1 });
    }, 200);
    return () => clearTimeout(handle);
  }, [cursor, scrollTop, writeSelection]);

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
