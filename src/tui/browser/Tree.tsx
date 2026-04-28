import React from 'react';
import { Box, Text } from 'ink';
import { Project, POU } from '../shared/types.js';

export interface TreeProps {
  project: Project;
  cursorPath: string;
  expanded: Set<string>;
}

export function devicePath(deviceName: string): string {
  return `device:${deviceName}`;
}
export function pouPath(deviceName: string, relPath: string): string {
  return `pou:${deviceName}:${relPath}`;
}

export function Tree({ project, cursorPath, expanded }: TreeProps): React.ReactElement {
  const rows: React.ReactElement[] = [];
  for (const dev of project.devices) {
    const dPath = devicePath(dev.name);
    const isExpanded = expanded.has(dPath);
    const isCursor = cursorPath === dPath;
    rows.push(
      <Text key={dPath}>
        {isCursor ? '▶ ' : '  '}
        {isExpanded ? '▾ ' : '▸ '}
        {dev.name}  {dev.pous.length} POUs
      </Text>
    );
    if (!isExpanded) continue;
    for (const p of dev.pous) {
      const pPath = pouPath(dev.name, p.relPath);
      const isPCursor = cursorPath === pPath;
      rows.push(
        <Text key={pPath}>
          {isPCursor ? '▶ ' : '    '}
          {p.name.padEnd(18)} {p.kind.padEnd(6)} {String(p.loc).padStart(4)} L
        </Text>
      );
    }
  }
  return <Box flexDirection="column">{rows}</Box>;
}
