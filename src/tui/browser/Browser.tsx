import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Project, POU, Selection, Hunk } from '../shared/types.js';
import { Tree, devicePath, pouPath } from './Tree.js';
import { Viewer } from './Viewer.js';
import { formatStaleness, ResizeWarning } from './Statusbar.js';
import { computeHunks } from '../shared/diff.js';

export interface BrowserProps {
  project: Project;
  readPou: (pou: POU) => Promise<string>;
  writeSelection: (s: Selection) => void;
  onQuit: () => void;
  onRescan?: () => void;
  onOpenInEditor?: (absPath: string) => void;
}

interface FlatRow {
  path: string;
  kind: 'device' | 'pou';
  device: string;
  pou?: POU;
}

function flatten(project: Project, expanded: Set<string>, filter: string): FlatRow[] {
  const f = filter.toLowerCase();
  const rows: FlatRow[] = [];
  for (const dev of project.devices) {
    const matchingPous = f
      ? dev.pous.filter((p) => p.name.toLowerCase().includes(f))
      : dev.pous;
    if (f && matchingPous.length === 0) continue;
    rows.push({ path: devicePath(dev.name), kind: 'device', device: dev.name });
    const isExpanded = f ? true : expanded.has(devicePath(dev.name));
    if (!isExpanded) continue;
    for (const p of matchingPous) {
      rows.push({ path: pouPath(dev.name, p.relPath), kind: 'pou', device: dev.name, pou: p });
    }
  }
  return rows;
}

export function Browser({ project, readPou, writeSelection, onQuit, onRescan, onOpenInEditor }: BrowserProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [cursorIdx, setCursorIdx] = React.useState(0);
  const [text, setText] = React.useState<string | null>(null);
  const [scrollTop] = React.useState(0);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [filterMode, setFilterMode] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  const [crossDiff, setCrossDiff] = React.useState<{
    leftLabel: string;
    rightLabel: string;
    leftText: string;
    rightText: string;
  } | null>(null);
  const [crossPicker, setCrossPicker] = React.useState<{
    pou: POU;
    candidates: Array<{ device: string; pou: POU }>;
    cursor: number;
  } | null>(null);

  const filteredProject = React.useMemo(() => {
    if (!filter) return project;
    const f = filter.toLowerCase();
    return {
      ...project,
      devices: project.devices
        .map((d) => ({ ...d, pous: d.pous.filter((p) => p.name.toLowerCase().includes(f)) }))
        .filter((d) => d.pous.length > 0),
    };
  }, [project, filter]);

  const effectiveExpanded = React.useMemo(() => {
    if (!filter) return expanded;
    const next = new Set(expanded);
    for (const d of filteredProject.devices) next.add(devicePath(d.name));
    return next;
  }, [expanded, filter, filteredProject]);

  const rows = React.useMemo(
    () => flatten(filteredProject, effectiveExpanded, ''),
    [filteredProject, effectiveExpanded]
  );
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

  const openCrossDiff = React.useCallback(
    async (currentDevice: string, currentPou: POU) => {
      const candidates: Array<{ device: string; pou: POU }> = [];
      for (const dev of project.devices) {
        if (dev.name === currentDevice) continue;
        const peer = dev.pous.find((p) => p.name === currentPou.name);
        if (peer) candidates.push({ device: dev.name, pou: peer });
      }
      if (candidates.length === 0) return;
      if (candidates.length === 1) {
        const peer = candidates[0];
        const [a, b] = await Promise.all([readPou(currentPou), readPou(peer.pou)]);
        setCrossDiff({
          leftLabel: `${currentDevice}/${currentPou.name}`,
          rightLabel: `${peer.device}/${peer.pou.name}`,
          leftText: a,
          rightText: b,
        });
        return;
      }
      setCrossPicker({ pou: currentPou, candidates, cursor: 0 });
    },
    [project, readPou]
  );

  useInput((input, key) => {
    if (crossDiff) {
      if (key.escape || input === 'q') setCrossDiff(null);
      return;
    }
    if (crossPicker) {
      if (key.escape) {
        setCrossPicker(null);
        return;
      }
      if (input === 'j' || key.downArrow) {
        setCrossPicker((p) =>
          p ? { ...p, cursor: Math.min(p.cursor + 1, p.candidates.length - 1) } : p
        );
        return;
      }
      if (input === 'k' || key.upArrow) {
        setCrossPicker((p) => (p ? { ...p, cursor: Math.max(p.cursor - 1, 0) } : p));
        return;
      }
      if (key.return) {
        const peer = crossPicker.candidates[crossPicker.cursor];
        const cur = cursor;
        if (cur?.kind === 'pou' && cur.pou) {
          const currentDevice = cur.device;
          const currentPou = cur.pou;
          Promise.all([readPou(currentPou), readPou(peer.pou)])
            .then(([a, b]) => {
              setCrossDiff({
                leftLabel: `${currentDevice}/${currentPou.name}`,
                rightLabel: `${peer.device}/${peer.pou.name}`,
                leftText: a,
                rightText: b,
              });
              setCrossPicker(null);
            })
            .catch(() => setCrossPicker(null));
        }
        return;
      }
      return;
    }
    if (filterMode) {
      if (key.escape) {
        setFilter('');
        setFilterMode(false);
        return;
      }
      if (key.return) {
        setFilterMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFilter((s) => s + input);
        return;
      }
      return;
    }
    if (input === '?') {
      setHelpOpen((v) => !v);
      return;
    }
    if (helpOpen) {
      if (key.escape) setHelpOpen(false);
      return;
    }
    if (input === '/') {
      setFilterMode(true);
      setCursorIdx(0);
      return;
    }
    if (key.escape && filter) {
      setFilter('');
      return;
    }
    if (input === 'q') return onQuit();
    if (input === 'r' && onRescan) return onRescan();
    if (input === 'o' && onOpenInEditor && cursor?.kind === 'pou' && cursor.pou) {
      return onOpenInEditor(cursor.pou.absPath);
    }
    if (input === 'd' && cursor?.kind === 'pou' && cursor.pou) {
      void openCrossDiff(cursor.device, cursor.pou);
      return;
    }
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

  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;
  const stale = formatStaleness(project.mirrorMtimeMs);

  return (
    <Box flexDirection="column">
      <Text>
        ─ {project.rootDir.split(/[/\\]/).pop()} ─{stale ? ` mirror ${stale} old ` : ' '}─
      </Text>
      <ResizeWarning columns={columns} rows={termRows} />
      {helpOpen && <HelpOverlay />}
      {crossDiff && (
        <CrossDeviceDiff
          leftLabel={crossDiff.leftLabel}
          rightLabel={crossDiff.rightLabel}
          leftText={crossDiff.leftText}
          rightText={crossDiff.rightText}
        />
      )}
      {crossPicker && <CrossPicker state={crossPicker} />}
      {(filterMode || filter) && (
        <Text color={filterMode ? 'cyan' : undefined}>
          Filter: {filter}{filterMode ? '_' : ''}
        </Text>
      )}
      <Box flexDirection="row">
        <Box flexDirection="column" width="40%">
          <Tree project={filteredProject} cursorPath={cursor?.path ?? ''} expanded={effectiveExpanded} />
        </Box>
        <Box flexDirection="column" width="60%">
          <Viewer pou={cursor?.pou ?? null} text={text} scrollTop={scrollTop} visibleRows={20} />
        </Box>
      </Box>
      <Text>j/k nav  l expand  h collapse  / filter  o open  d cross-diff  r rescan  ? help  q quit</Text>
    </Box>
  );
}

function CrossPicker({
  state,
}: {
  state: { pou: POU; candidates: Array<{ device: string; pou: POU }>; cursor: number };
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Cross-device diff: pick peer for {state.pou.name}</Text>
      {state.candidates.map((c, i) => (
        <Text key={c.device} color={i === state.cursor ? 'cyan' : undefined}>
          {i === state.cursor ? '▶ ' : '  '}
          {c.device}/{c.pou.name}
        </Text>
      ))}
      <Text dimColor>j/k pick  Enter open  Esc cancel</Text>
    </Box>
  );
}

function CrossDeviceDiff({
  leftLabel,
  rightLabel,
  leftText,
  rightText,
}: {
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
}): React.ReactElement {
  const hunks = React.useMemo(() => computeHunks(leftText, rightText), [leftText, rightText]);
  const adds = hunks.filter((h) => h.kind === 'add').length;
  const dels = hunks.filter((h) => h.kind === 'del').length;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Cross-device diff: {leftLabel} → {rightLabel}  (+{adds} −{dels})</Text>
      {hunks.map((h, i) => {
        const sigil = h.kind === 'add' ? '+' : h.kind === 'del' ? '-' : ' ';
        const color = h.kind === 'add' ? 'green' : h.kind === 'del' ? 'red' : undefined;
        return (
          <Text key={i} color={color}>
            {sigil} {String(h.lineNo).padStart(4, ' ')}  {h.text}
          </Text>
        );
      })}
      <Text dimColor>q / Esc close</Text>
    </Box>
  );
}

function HelpOverlay(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keybindings</Text>
      <Text>  j / ↓     move cursor down</Text>
      <Text>  k / ↑     move cursor up</Text>
      <Text>  l / →     expand device</Text>
      <Text>  h / ←     collapse device</Text>
      <Text>  /         filter POU list (Enter commits, Esc clears)</Text>
      <Text>  o         open highlighted POU in $EDITOR (or VS Code)</Text>
      <Text>  d         diff highlighted POU against same-named POU in another device</Text>
      <Text>  r         re-scan mcp-mirror/</Text>
      <Text>  ?         toggle this help</Text>
      <Text>  Esc       close help</Text>
      <Text>  q         quit</Text>
    </Box>
  );
}
