import * as fs from 'fs';

export const FRESHNESS_MS = 60_000;

export interface SelectionPayload {
  version: 1;
  updated_at: string;
  project_dir: string;
  device: string;
  selection: {
    kind: string;
    name: string;
    path: string;
    abs_path: string;
  };
  viewer_line: number;
}

export type ReadResult =
  | { status: 'ok'; payload: SelectionPayload }
  | { status: 'missing' }
  | { status: 'stale' }
  | { status: 'invalid'; reason: string };

export async function readSelection(filePath: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return { status: 'missing' };
  }
  let parsed: SelectionPayload;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'invalid', reason: (err as Error).message };
  }
  if (parsed.version !== 1) {
    return { status: 'invalid', reason: `unsupported version ${parsed.version}` };
  }
  const ageMs = Date.now() - new Date(parsed.updated_at).getTime();
  if (Number.isNaN(ageMs) || ageMs > FRESHNESS_MS) {
    return { status: 'stale' };
  }
  return { status: 'ok', payload: parsed };
}
