import React from 'react';
import { Text } from 'ink';

export const STALE_THRESHOLD_MS = 10_000;
export const MIN_COLUMNS = 80;
export const MIN_ROWS = 20;

export function formatStaleness(mirrorMtimeMs: number): string | null {
  const ageMs = Date.now() - mirrorMtimeMs;
  if (ageMs < STALE_THRESHOLD_MS) return null;

  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remSec = seconds % 60;
    return `${minutes}m ${remSec}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

export interface ResizeWarningProps {
  columns: number;
  rows: number;
}

export function ResizeWarning({ columns, rows }: ResizeWarningProps): React.ReactElement | null {
  if (columns < MIN_COLUMNS) {
    return <Text color="yellow">Terminal too narrow ({columns} cols, need {MIN_COLUMNS}+)</Text>;
  }
  if (rows < MIN_ROWS) {
    return <Text color="yellow">Terminal too short ({rows} rows, need {MIN_ROWS}+)</Text>;
  }
  return null;
}
