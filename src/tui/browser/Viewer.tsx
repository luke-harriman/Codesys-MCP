import React from 'react';
import { Box, Text } from 'ink';
import { POU } from '../shared/types.js';

export interface ViewerProps {
  pou: POU | null;
  text: string | null;
  scrollTop: number;
  visibleRows: number;
}

export function Viewer({ pou, text, scrollTop, visibleRows }: ViewerProps): React.ReactElement {
  if (!pou || text == null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>(no POU selected)</Text>
      </Box>
    );
  }
  const lines = text.split(/\r?\n/);
  const slice = lines.slice(scrollTop, scrollTop + visibleRows);
  return (
    <Box flexDirection="column">
      <Text bold>
        {pou.name}.st  ({pou.kind}, {pou.loc} L)
      </Text>
      {slice.map((l, i) => (
        <Text key={scrollTop + i}>
          {String(scrollTop + i + 1).padStart(4, ' ')}  {l}
        </Text>
      ))}
    </Box>
  );
}
