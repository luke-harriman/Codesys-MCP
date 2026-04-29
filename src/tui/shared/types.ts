export type POUKind =
  | 'PRG'
  | 'FB'
  | 'GVL'
  | 'STRUCT'
  | 'ENUM'
  | 'METHOD'
  | 'PROPERTY_GETTER'
  | 'PROPERTY_SETTER'
  | 'META'
  | 'OTHER';

export interface POU {
  /** Display name without .st extension */
  name: string;
  kind: POUKind;
  /** Path relative to the device root, with forward slashes. */
  relPath: string;
  absPath: string;
  /** Non-blank line count */
  loc: number;
  mtimeMs: number;
}

export interface Device {
  /** Top-level subdir under mcp-mirror/, e.g. "CodesysRpi" */
  name: string;
  pous: POU[];
}

export interface Project {
  /** The project's parent directory (the dir that contains mcp-mirror/) */
  rootDir: string;
  /** Mirror dir mtime — used for the "stale" indicator */
  mirrorMtimeMs: number;
  devices: Device[];
}

export interface Selection {
  device: string;
  pou: POU;
  viewerLine: number;
}

export type HunkKind = 'add' | 'del' | 'ctx';

export interface Hunk {
  kind: HunkKind;
  /** 1-based line number in the side this hunk belongs to (new-side for add/ctx, old-side for del). */
  lineNo: number;
  text: string;
}
