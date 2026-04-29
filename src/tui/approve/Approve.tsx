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

  useInput((input, key) => {
    if (input === 'y') return onDecision('accept');
    if (input === 'n' || input === 'q' || key.escape) return onDecision('reject');
  });

  return (
    <Box flexDirection="column">
      <Text>
        ─ Approve change? {fileName} ─── + {adds} lines, − {dels} lines ─
      </Text>
      <Box flexDirection="column">
        {hunks.map((h, i) => (
          <HunkLine key={i} hunk={h} />
        ))}
      </Box>
      <Text>
        y accept   n reject   q reject & quit   ESC reject
      </Text>
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
