import React from 'react';
import { Box, Text, useInput } from 'ink';
import { computeHunks } from '../shared/diff.js';
import { Hunk } from '../shared/types.js';

export type Decision = 'accept' | 'reject';

export interface ApproveProps {
  fileName: string;
  oldText: string;
  newText: string;
  onDecision: (d: Decision) => void;
}

export function Approve({ fileName, oldText, newText, onDecision }: ApproveProps): React.ReactElement {
  const hunks = React.useMemo(() => computeHunks(oldText, newText), [oldText, newText]);
  const adds = hunks.filter((h) => h.kind === 'add').length;
  const dels = hunks.filter((h) => h.kind === 'del').length;
  const [sideBySide, setSideBySide] = React.useState(false);

  useInput((input, key) => {
    if (input === 'v') {
      setSideBySide((v) => !v);
      return;
    }
    if (input === 'y') return onDecision('accept');
    if (input === 'n' || input === 'q' || key.escape) return onDecision('reject');
  });

  return (
    <Box flexDirection="column">
      <Text>
        ─ Approve change? {fileName} ─── + {adds} lines, − {dels} lines ─
      </Text>
      {sideBySide ? <SideBySide hunks={hunks} /> : <UnifiedView hunks={hunks} />}
      <Text>
        y accept   n reject   v toggle side-by-side   q reject &amp; quit   ESC reject
      </Text>
    </Box>
  );
}

function UnifiedView({ hunks }: { hunks: Hunk[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {hunks.map((h, i) => (
        <HunkLine key={i} hunk={h} />
      ))}
    </Box>
  );
}

function HunkLine({ hunk }: { hunk: Hunk }): React.ReactElement {
  const sigil = hunk.kind === 'add' ? '+' : hunk.kind === 'del' ? '-' : ' ';
  const color = hunk.kind === 'add' ? 'green' : hunk.kind === 'del' ? 'red' : undefined;
  const lineNoStr = String(hunk.lineNo).padStart(4, ' ');
  return (
    <Text color={color}>
      {sigil} {lineNoStr}  {hunk.text}
    </Text>
  );
}

function pairForSideBySide(hunks: Hunk[]): Array<[Hunk | null, Hunk | null]> {
  const out: Array<[Hunk | null, Hunk | null]> = [];
  let i = 0;
  while (i < hunks.length) {
    if (hunks[i].kind === 'ctx') {
      out.push([hunks[i], hunks[i]]);
      i++;
      continue;
    }
    const dels: Hunk[] = [];
    const adds: Hunk[] = [];
    while (i < hunks.length && hunks[i].kind !== 'ctx') {
      if (hunks[i].kind === 'del') dels.push(hunks[i]);
      else adds.push(hunks[i]);
      i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let j = 0; j < max; j++) {
      out.push([dels[j] ?? null, adds[j] ?? null]);
    }
  }
  return out;
}

function SideBySide({ hunks }: { hunks: Hunk[] }): React.ReactElement {
  const rows = React.useMemo(() => pairForSideBySide(hunks), [hunks]);
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <SideBySideRow key={i} left={row[0]} right={row[1]} />
      ))}
    </Box>
  );
}

function SideBySideRow({ left, right }: { left: Hunk | null; right: Hunk | null }): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Box width="50%">
        <HalfLine hunk={left} side="left" />
      </Box>
      <Text> │ </Text>
      <Box width="50%">
        <HalfLine hunk={right} side="right" />
      </Box>
    </Box>
  );
}

function HalfLine({ hunk, side }: { hunk: Hunk | null; side: 'left' | 'right' }): React.ReactElement {
  if (!hunk) return <Text> </Text>;
  const color =
    hunk.kind === 'add' ? 'green' : hunk.kind === 'del' ? 'red' : undefined;
  const sigil =
    hunk.kind === 'add' ? '+' : hunk.kind === 'del' ? '-' : ' ';
  // For ctx, show ' '; for del on left, show '-'; for add on right, show '+'.
  // (Cross-cell pollution like 'add' on the left side shouldn't happen given pairForSideBySide.)
  void side;
  return (
    <Text color={color}>
      {sigil} {String(hunk.lineNo).padStart(4, ' ')}  {hunk.text}
    </Text>
  );
}
