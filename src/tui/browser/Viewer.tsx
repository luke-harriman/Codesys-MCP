import React from 'react';
import { Box, Text } from 'ink';
import { POU } from '../shared/types.js';
import { Token, tokenizeLines, TokenKind } from './highlight.js';

const COLORS: Record<TokenKind, string | undefined> = {
  keyword: 'cyan',
  type: 'magenta',
  comment: 'gray',
  string: 'yellow',
  text: undefined,
};

function HighlightedTokens({ tokens }: { tokens: Token[] }): React.ReactElement {
  return (
    <Text>
      {tokens.map((t, i) => (
        <Text key={i} color={COLORS[t.kind]}>
          {t.text}
        </Text>
      ))}
    </Text>
  );
}

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
  // Tokenize from line 0 so multi-line (* ... *) state is correct, then
  // slice the visible window. Cheap; line count is bounded by file size.
  const allTokens = React.useMemo(() => tokenizeLines(lines), [text]);
  const sliceTokens = allTokens.slice(scrollTop, scrollTop + visibleRows);
  return (
    <Box flexDirection="column">
      <Text bold>
        {pou.name}.st  ({pou.kind}, {pou.loc} L)
      </Text>
      {sliceTokens.map((tokens, i) => (
        <Text key={scrollTop + i}>
          <Text dimColor>{String(scrollTop + i + 1).padStart(4, ' ')}  </Text>
          <HighlightedTokens tokens={tokens} />
        </Text>
      ))}
    </Box>
  );
}
