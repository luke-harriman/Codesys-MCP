/**
 * Shared TypeScript types for codesys-mcp-sp21-plus (Codesys-MCP-SP21+)
 */

export type RequestId = string;
export type SessionId = string;

/** Command file written by Node.js to commands/ directory */
export interface IpcCommand {
  requestId: RequestId;
  scriptPath: string;
  timestamp: number;
}

/** Result file written by watcher to results/ directory */
export interface IpcResult {
  requestId: RequestId;
  success: boolean;
  output: string;
  error: string;
  timestamp: number;
}

/** CODESYS process lifecycle state */
export type CodesysState = 'stopped' | 'launching' | 'ready' | 'stopping' | 'error';

/** Configuration for launching CODESYS */
export interface LauncherConfig {
  codesysPath: string;
  profileName: string;
  workspaceDir: string;
}

/** Runtime status of the CODESYS launcher */
export interface LauncherStatus {
  state: CodesysState;
  pid: number | null;
  sessionId: SessionId | null;
  ipcDir: string | null;
  startedAt: number | null;
  lastError: string | null;
}

/** IPC transport configuration */
export interface IpcConfig {
  baseDir: string;
  commandTimeoutMs: number;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  deleteResultAfterRead: boolean;
}

/** Full server configuration */
export interface ServerConfig extends LauncherConfig {
  autoLaunch: boolean;
  keepAlive: boolean;
  timeoutMs: number;
  fallbackHeadless: boolean;
  verbose: boolean;
  debug: boolean;
  mode: ExecutionMode;
  /**
   * If true, automatically run mirror_export after every modifying tool
   * (set_pou_code, create_*, delete_object, rename_object, add_library, etc.)
   * so an external editor watching <projectDir>/mcp-mirror/ sees the change
   * immediately. Failures are surfaced as a hint in the tool response, not
   * as a hard error -- the underlying edit already succeeded.
   */
  autoMirror: boolean;
  /**
   * If true, modifying tools (set_pou_code et al.) will shell out to
   * phobiCS-tui in approve mode and only proceed on exit 0. Off by default
   * so existing scripted flows are not regressed.
   */
  approveEdits?: boolean;
}

/** Script template parameters */
export type ScriptParams = Record<string, string>;

/** Execution mode */
export type ExecutionMode = 'persistent' | 'headless';

/** Interface for script executors (both persistent and headless) */
export interface ScriptExecutor {
  executeScript(content: string, timeoutMs?: number): Promise<IpcResult>;
}
