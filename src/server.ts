/**
 * MCP Server — registers tools and resources for CODESYS automation.
 * Supports persistent (watcher-based) and headless (spawn-per-command) modes.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { URL } from 'url';
import { spawn } from 'child_process';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ServerConfig, IpcResult, ScriptExecutor, ExecutionMode } from './types';
import { CodesysLauncher } from './launcher';
import { HeadlessExecutor } from './headless';
import { ScriptManager } from './script-manager';
import { serverLog, setLogLevel } from './logger';

/** Default install path for the standalone CODESYS Installer (APInstaller). */
const DEFAULT_APINSTALLER_CLI = 'C:\\Program Files (x86)\\CODESYS\\APInstaller\\APInstaller.CLI.exe';

/** Locate APInstaller.CLI.exe -- env var override wins, otherwise the default path. */
function locateAPInstallerCli(): string | null {
  const fromEnv = process.env.CODESYS_APINSTALLER_CLI;
  const candidate = fromEnv && fromEnv.trim().length > 0 ? fromEnv : DEFAULT_APINSTALLER_CLI;
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Run a process to completion, capturing stdout+stderr. Resolves with
 * { code, stdout, stderr }. Rejects only on spawn error (e.g. exe missing).
 */
function runProcess(exe: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Download a URL to a temp file. Returns the local file path.
 * Follows redirects, fails on non-2xx, throws on network errors.
 * Caller is responsible for removing the file when done.
 */
async function downloadToTempFile(url: string, suggestedExt = '.library'): Promise<string> {
  const u = new URL(url);
  const tmpDir = path.join(os.tmpdir(), 'codesys-mcp-downloads');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const baseName = path.basename(u.pathname) || `download-${crypto.randomBytes(6).toString('hex')}`;
  const ext = path.extname(baseName) ? '' : suggestedExt;
  const tmpPath = path.join(tmpDir, `${Date.now()}-${baseName}${ext}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(tmpPath, buf);
  return tmpPath;
}

// Zod enums for POU tools
const PouTypeEnum = z.enum(['Program', 'FunctionBlock', 'Function']);
const ImplementationLanguageEnum = z.enum([
  'ST', 'LD', 'FBD', 'SFC', 'IL', 'CFC',
  'StructuredText', 'LadderDiagram', 'FunctionBlockDiagram',
  'SequentialFunctionChart', 'InstructionList', 'ContinuousFunctionChart',
]);

/** Resolve a file path to an absolute normalized path */
function resolvePath(filePath: string, workspaceDir: string): string {
  return path.normalize(
    path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath)
  );
}

/** Sanitize a POU path (forward slashes, no leading/trailing slashes) */
function sanitizePouPath(pouPath: string): string {
  return pouPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** Format an IpcResult into an MCP tool response */
function formatToolResponse(
  result: IpcResult,
  successMessage: string
): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  const success = result.success && result.output.includes('SCRIPT_SUCCESS');
  return {
    content: [
      {
        type: 'text' as const,
        text: success
          ? successMessage
          : `Operation failed. Output:\n${result.output}${result.error ? '\nError: ' + result.error : ''}`,
      },
    ],
    isError: !success,
  };
}

/** Check if a file exists (async) */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    fs.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function startMcpServer(config: ServerConfig): Promise<void> {
  // Set log level
  if (config.debug) setLogLevel('debug');
  else if (config.verbose) setLogLevel('info');

  serverLog.info(`Starting CODESYS Persistent MCP Server v0.1.0`);
  serverLog.info(`Mode: ${config.mode}`);
  serverLog.info(`CODESYS Path: ${config.codesysPath}`);
  serverLog.info(`Profile: ${config.profileName}`);
  serverLog.info(`Workspace: ${config.workspaceDir}`);

  // Validate CODESYS path
  if (!fs.existsSync(config.codesysPath)) {
    throw new Error(`CODESYS executable not found: ${config.codesysPath}`);
  }

  // Initialize executor based on mode
  let executor: ScriptExecutor;
  let launcher: CodesysLauncher | null = null;
  let executionMode: ExecutionMode = config.mode;

  if (config.mode === 'persistent') {
    launcher = new CodesysLauncher(config);

    if (config.autoLaunch) {
      try {
        await launcher.launch();
        executor = launcher;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        serverLog.error(`Persistent launch failed: ${errMsg}`);
        if (config.fallbackHeadless) {
          serverLog.warn('Falling back to headless mode');
          executor = new HeadlessExecutor(config);
          executionMode = 'headless';
        } else {
          throw err;
        }
      }
    } else {
      // Launcher exists but not yet launched — will use headless until manually launched
      executor = new HeadlessExecutor(config);
      executionMode = 'headless';
    }
  } else {
    executor = new HeadlessExecutor(config);
  }

  const scriptManager = new ScriptManager();
  const workspaceDir = config.workspaceDir;

  // Create MCP server
  const server = new McpServer(
    {
      name: 'CODESYS Persistent MCP Server',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: { listChanged: true },
        tools: { listChanged: true },
      },
    }
  );

  // Note: using 'as any' cast on server for tool() calls to work around
  // TS2589 deep type instantiation with MCP SDK generics + Zod.
  const s = server as any;

  // ─── Management Tools ────────────────────────────────────────────────

  s.tool(
    'launch_codesys',
    'Manually launch CODESYS with UI. Use when --no-auto-launch was set.',
    async () => {
      if (!launcher) {
        return {
          content: [{ type: 'text' as const, text: 'Persistent mode not configured. Use --mode persistent.' }],
          isError: true,
        };
      }
      try {
        await launcher.launch();
        executor = launcher;
        executionMode = 'persistent';
        return {
          content: [{ type: 'text' as const, text: 'CODESYS launched successfully in persistent mode.' }],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Launch failed: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  s.tool(
    'shutdown_codesys',
    'Shut down the persistent CODESYS instance.',
    async () => {
      if (!launcher) {
        return {
          content: [{ type: 'text' as const, text: 'No persistent CODESYS instance to shut down.' }],
          isError: true,
        };
      }
      try {
        await launcher.shutdown();
        executor = new HeadlessExecutor(config);
        executionMode = 'headless';
        return {
          content: [{ type: 'text' as const, text: 'CODESYS shut down successfully.' }],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Shutdown failed: ${msg}` }],
          isError: true,
        };
      }
    }
  );

  s.tool(
    'get_codesys_status',
    'Get the current status of the CODESYS instance (state, PID, mode).',
    async () => {
      const status = launcher ? launcher.getStatus() : {
        state: 'stopped',
        pid: null,
        sessionId: null,
        ipcDir: null,
        startedAt: null,
        lastError: null,
      };
      const text = [
        `State: ${status.state}`,
        `Mode: ${executionMode}`,
        `PID: ${status.pid ?? 'N/A'}`,
        `Session: ${status.sessionId ?? 'N/A'}`,
        `Started: ${status.startedAt ? new Date(status.startedAt).toISOString() : 'N/A'}`,
        status.lastError ? `Last Error: ${status.lastError}` : null,
      ].filter(Boolean).join('\n');
      return {
        content: [{ type: 'text' as const, text }],
        isError: false,
      };
    }
  );

  // ─── Project Tools ───────────────────────────────────────────────────

  s.tool(
    'open_project',
    'Opens an existing CODESYS project file.',
    {
      filePath: z.string().describe("Path to the project file (e.g., 'C:/Projects/MyPLC.project')."),
    },
    async (args: { filePath: string }) => {
      const escaped = resolvePath(args.filePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'open_project', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Project opened: ${args.filePath}`);
    }
  );

  s.tool(
    'create_project',
    'Creates a new CODESYS project from the standard template.',
    {
      filePath: z.string().describe("Path where the new project file should be created."),
    },
    async (args: { filePath: string }) => {
      const absPath = path.normalize(
        path.isAbsolute(args.filePath) ? args.filePath : path.join(workspaceDir, args.filePath)
      );

      // Find template project
      let templatePath = '';
      try {
        const baseDir = path.dirname(path.dirname(config.codesysPath));
        templatePath = path.normalize(path.join(baseDir, 'Templates', 'Standard.project'));
        if (!(await fileExists(templatePath))) {
          const programData = process.env.ALLUSERSPROFILE || process.env.ProgramData || 'C:\\ProgramData';
          const pd1 = path.normalize(path.join(programData, 'CODESYS', 'CODESYS', config.profileName, 'Templates', 'Standard.project'));
          if (await fileExists(pd1)) {
            templatePath = pd1;
          } else {
            const pd2 = path.normalize(path.join(programData, 'CODESYS', 'Templates', 'Standard.project'));
            if (await fileExists(pd2)) {
              templatePath = pd2;
            } else {
              throw new Error('Standard template project file not found.');
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text' as const, text: `Template Error: ${msg}` }],
          isError: true,
        };
      }

      const script = scriptManager.prepareScript('create_project', {
        PROJECT_FILE_PATH: absPath,
        TEMPLATE_PROJECT_PATH: templatePath,
      });
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Project created from template: ${absPath}`);
    }
  );

  s.tool(
    'save_project',
    'Saves the currently open CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file to ensure is open before saving."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'save_project', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Project saved: ${args.projectFilePath}`);
    }
  );

  // ─── POU Tools ───────────────────────────────────────────────────────

  s.tool(
    'create_pou',
    'Creates a new Program, Function Block, or Function POU within the specified CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      name: z.string().describe("Name for the new POU (must be a valid IEC identifier)."),
      type: z.string().describe("Type of POU: Program, FunctionBlock, or Function."),
      language: z.string().describe("Implementation language: ST, LD, FBD, SFC, IL, or CFC."),
      parentPath: z.string().describe("Relative path under project root or application (e.g., 'Application')."),
    },
    async (args: { projectFilePath: string; name: string; type: string; language: string; parentPath: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_pou',
        {
          PROJECT_FILE_PATH: escProjPath,
          POU_NAME: args.name.trim(),
          POU_TYPE_STR: args.type,
          IMPL_LANGUAGE_STR: args.language,
          PARENT_PATH: sanParentPath,
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `POU '${args.name}' created in '${sanParentPath}' of ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'set_pou_code',
    'Sets the declaration and/or implementation code for a specific POU, Method, or Property.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      pouPath: z.string().describe("Full relative path to the target object (e.g., 'Application/MyPOU')."),
      declarationCode: z.string().optional().describe("Code for the declaration part (VAR...END_VAR). If omitted, not changed."),
      implementationCode: z.string().optional().describe("Code for the implementation logic. If omitted, not changed."),
    },
    async (args: { projectFilePath: string; pouPath: string; declarationCode?: string; implementationCode?: string }) => {
      if (args.declarationCode === undefined && args.implementationCode === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'Error: At least one of declarationCode or implementationCode must be provided.' }],
          isError: true,
        };
      }
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanPouPath = sanitizePouPath(args.pouPath);
      // Escape for triple-quoted Python strings
      const sanDecl = (args.declarationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const sanImpl = (args.implementationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const script = scriptManager.prepareScriptWithHelpers(
        'set_pou_code',
        {
          PROJECT_FILE_PATH: escProjPath,
          POU_FULL_PATH: sanPouPath,
          DECLARATION_CONTENT: sanDecl,
          IMPLEMENTATION_CONTENT: sanImpl,
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Code set for '${sanPouPath}' in ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'create_property',
    'Creates a new Property within a specific Function Block POU.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      parentPouPath: z.string().describe("Relative path to the parent Function Block POU (e.g., 'Application/MyFB')."),
      propertyName: z.string().describe("Name for the new property (must be a valid IEC identifier)."),
      propertyType: z.string().describe("Data type of the property (e.g., 'BOOL', 'INT', 'MyDUT')."),
    },
    async (args: { projectFilePath: string; parentPouPath: string; propertyName: string; propertyType: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPouPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_property',
        {
          PROJECT_FILE_PATH: escProjPath,
          PARENT_POU_FULL_PATH: sanParentPath,
          PROPERTY_NAME: args.propertyName.trim(),
          PROPERTY_TYPE: args.propertyType.trim(),
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Property '${args.propertyName}' created under '${sanParentPath}' in ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'create_method',
    'Creates a new Method within a specific Function Block POU.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      parentPouPath: z.string().describe("Relative path to the parent Function Block POU (e.g., 'Application/MyFB')."),
      methodName: z.string().describe("Name of the new method (must be a valid IEC identifier)."),
      returnType: z.string().optional().describe("Return type (e.g., 'BOOL', 'INT'). Leave empty or omit for no return value."),
    },
    async (args: { projectFilePath: string; parentPouPath: string; methodName: string; returnType?: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPouPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_method',
        {
          PROJECT_FILE_PATH: escProjPath,
          PARENT_POU_FULL_PATH: sanParentPath,
          METHOD_NAME: args.methodName.trim(),
          RETURN_TYPE: (args.returnType ?? '').trim(),
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Method '${args.methodName}' created under '${sanParentPath}' in ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'compile_project',
    'Compiles (Builds) the primary application within a CODESYS project. Returns structured compiler messages (errors, warnings) when available.',
    {
      projectFilePath: z.string().describe("Path to the project file containing the application to compile."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'compile_project', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000); // 120s timeout for compile

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');

      // Parse structured compile messages if present
      let compileMessages: Array<{ severity: string; text: string; object?: string; line?: number }> = [];
      const msgStartMarker = '### COMPILE_MESSAGES_START ###';
      const msgEndMarker = '### COMPILE_MESSAGES_END ###';
      const msgStartIdx = result.output.indexOf(msgStartMarker);
      const msgEndIdx = result.output.indexOf(msgEndMarker);
      if (msgStartIdx !== -1 && msgEndIdx !== -1 && msgStartIdx < msgEndIdx) {
        try {
          const jsonStr = result.output.substring(msgStartIdx + msgStartMarker.length, msgEndIdx).trim();
          compileMessages = JSON.parse(jsonStr);
        } catch {
          // JSON parse failed, ignore
        }
      }

      // Build response message
      let message: string;
      let isError = !success;

      if (!success) {
        message = `Failed initiating compilation for ${args.projectFilePath}. Output:\n${result.output}`;
      } else if (compileMessages.length > 0) {
        const errors = compileMessages.filter((m) => m.severity === 'error');
        const warnings = compileMessages.filter((m) => m.severity === 'warning');
        const formatMsg = (m: { severity: string; text: string; object?: string; line?: number }) => {
          const loc = m.object ? (m.line != null ? ` [${m.object}:${m.line}]` : ` [${m.object}]`) : '';
          return `${m.severity.toUpperCase()}: ${m.text}${loc}`;
        };

        message = `Compilation complete for ${args.projectFilePath}.\n`;
        message += `${errors.length} error(s), ${warnings.length} warning(s).\n`;
        if (errors.length > 0) {
          message += '\nErrors:\n' + errors.map(formatMsg).join('\n');
          isError = true;
        }
        if (warnings.length > 0) {
          message += '\nWarnings:\n' + warnings.map(formatMsg).join('\n');
        }
      } else {
        // No structured messages available — fall back to old behavior
        message = `Compilation initiated for ${args.projectFilePath}.`;
        const hasCompileErrors =
          result.output.includes('Compile complete --') &&
          !/ 0 error\(s\),/.test(result.output);
        if (hasCompileErrors) {
          message += ' WARNING: Build command reported errors. Use get_compile_messages for details.';
          isError = true;
        }
      }

      return { content: [{ type: 'text' as const, text: message }], isError };
    }
  );

  s.tool(
    'get_compile_messages',
    'Retrieves the last compiler messages (errors, warnings) without triggering a new build. Useful after editing code to check remaining errors.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_compile_messages', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script);

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      // Parse structured messages
      let compileMessages: Array<{ severity: string; text: string; object?: string; line?: number }> = [];
      const msgStartMarker = '### COMPILE_MESSAGES_START ###';
      const msgEndMarker = '### COMPILE_MESSAGES_END ###';
      const msgStartIdx = result.output.indexOf(msgStartMarker);
      const msgEndIdx = result.output.indexOf(msgEndMarker);
      if (msgStartIdx !== -1 && msgEndIdx !== -1 && msgStartIdx < msgEndIdx) {
        try {
          const jsonStr = result.output.substring(msgStartIdx + msgStartMarker.length, msgEndIdx).trim();
          compileMessages = JSON.parse(jsonStr);
        } catch {
          // JSON parse failed
        }
      }

      if (compileMessages.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No compile messages found. The message API may not be available in this CODESYS version.' }],
          isError: false,
        };
      }

      const errors = compileMessages.filter((m) => m.severity === 'error');
      const warnings = compileMessages.filter((m) => m.severity === 'warning');
      const formatMsg = (m: { severity: string; text: string; object?: string; line?: number }) => {
        const loc = m.object ? (m.line != null ? ` [${m.object}:${m.line}]` : ` [${m.object}]`) : '';
        return `${m.severity.toUpperCase()}: ${m.text}${loc}`;
      };

      let message = `${errors.length} error(s), ${warnings.length} warning(s), ${compileMessages.length} total message(s).\n`;
      if (errors.length > 0) {
        message += '\nErrors:\n' + errors.map(formatMsg).join('\n');
      }
      if (warnings.length > 0) {
        message += '\nWarnings:\n' + warnings.map(formatMsg).join('\n');
      }
      const others = compileMessages.filter((m) => m.severity !== 'error' && m.severity !== 'warning');
      if (others.length > 0) {
        message += '\nOther:\n' + others.map(formatMsg).join('\n');
      }

      return {
        content: [{ type: 'text' as const, text: message }],
        isError: errors.length > 0,
      };
    }
  );

  // ─── Project Structure Tools ──────────────────────────────────────────

  s.tool(
    'create_dut',
    'Creates a new Data Unit Type (DUT) — structure, enumeration, union, or alias — within the specified CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      name: z.string().describe("Name for the new DUT (must be a valid IEC identifier)."),
      dutType: z.string().describe("Type of DUT: Structure, Enumeration, Union, or Alias."),
      parentPath: z.string().describe("Relative path under project root or application (e.g., 'Application')."),
    },
    async (args: { projectFilePath: string; name: string; dutType: string; parentPath: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_dut',
        {
          PROJECT_FILE_PATH: escProjPath,
          DUT_NAME: args.name.trim(),
          DUT_TYPE_STR: args.dutType,
          PARENT_PATH: sanParentPath,
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `DUT '${args.name}' (${args.dutType}) created in '${sanParentPath}' of ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'create_gvl',
    'Creates a new Global Variable List (GVL) within the specified CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      name: z.string().describe("Name for the new GVL (must be a valid IEC identifier)."),
      parentPath: z.string().describe("Relative path under project root or application (e.g., 'Application')."),
      declarationCode: z.string().optional().describe("Optional initial declaration code for the GVL (VAR_GLOBAL...END_VAR)."),
    },
    async (args: { projectFilePath: string; name: string; parentPath: string; declarationCode?: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPath);
      const sanDecl = (args.declarationCode ?? '').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const script = scriptManager.prepareScriptWithHelpers(
        'create_gvl',
        {
          PROJECT_FILE_PATH: escProjPath,
          GVL_NAME: args.name.trim(),
          PARENT_PATH: sanParentPath,
          DECLARATION_CONTENT: sanDecl,
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `GVL '${args.name}' created in '${sanParentPath}' of ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'create_folder',
    'Creates an organizational folder within the CODESYS project tree.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      folderName: z.string().describe("Name for the new folder."),
      parentPath: z.string().describe("Relative path under project root or application (e.g., 'Application')."),
    },
    async (args: { projectFilePath: string; folderName: string; parentPath: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanParentPath = sanitizePouPath(args.parentPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_folder',
        {
          PROJECT_FILE_PATH: escProjPath,
          FOLDER_NAME: args.folderName.trim(),
          PARENT_PATH: sanParentPath,
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Folder '${args.folderName}' created in '${sanParentPath}' of ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'delete_object',
    'Deletes a project object (POU, DUT, GVL, folder, etc.) from the CODESYS project. WARNING: This is destructive and cannot be undone.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      objectPath: z.string().describe("Full relative path to the object to delete (e.g., 'Application/MyPOU')."),
    },
    async (args: { projectFilePath: string; objectPath: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanObjPath = sanitizePouPath(args.objectPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'delete_object',
        {
          PROJECT_FILE_PATH: escProjPath,
          OBJECT_PATH: sanObjPath,
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Object '${sanObjPath}' deleted from ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'rename_object',
    'Renames a project object (POU, DUT, GVL, folder, etc.) in the CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      objectPath: z.string().describe("Full relative path to the object to rename (e.g., 'Application/MyPOU')."),
      newName: z.string().describe("New name for the object (must be a valid IEC identifier)."),
    },
    async (args: { projectFilePath: string; objectPath: string; newName: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanObjPath = sanitizePouPath(args.objectPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'rename_object',
        {
          PROJECT_FILE_PATH: escProjPath,
          OBJECT_PATH: sanObjPath,
          NEW_NAME: args.newName.trim(),
        },
        ['ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Object '${sanObjPath}' renamed to '${args.newName}' in ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'get_all_pou_code',
    'Reads the declaration and implementation code of every POU/DUT/GVL in the project. Returns all code in a single response for bulk review.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_all_pou_code', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000); // 120s for large projects

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      // Parse the JSON output
      const codeStartMarker = '### ALL_POU_CODE_START ###';
      const codeEndMarker = '### ALL_POU_CODE_END ###';
      const startIdx = result.output.indexOf(codeStartMarker);
      const endIdx = result.output.indexOf(codeEndMarker);

      if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
        return {
          content: [{ type: 'text' as const, text: 'Could not parse POU code output.' }],
          isError: true,
        };
      }

      try {
        const jsonStr = result.output.substring(startIdx + codeStartMarker.length, endIdx).trim();
        const allCode: Array<{ path: string; type: string; declaration?: string; implementation?: string }> = JSON.parse(jsonStr);

        if (allCode.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No POUs with code found in the project.' }],
            isError: false,
          };
        }

        // Format output
        const sections = allCode.map((item) => {
          let section = `\n=== ${item.path} (${item.type}) ===`;
          if (item.declaration) {
            section += `\n// ----- Declaration -----\n${item.declaration}`;
          }
          if (item.implementation) {
            section += `\n// ----- Implementation -----\n${item.implementation}`;
          }
          return section;
        });

        return {
          content: [{ type: 'text' as const, text: `${allCode.length} object(s) with code:\n${sections.join('\n')}` }],
          isError: false,
        };
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Failed to parse POU code JSON.' }],
          isError: true,
        };
      }
    }
  );

  // ─── Online/Runtime Tools ─────────────────────────────────────────────

  s.tool(
    'connect_to_device',
    'Connects (logs in) to the PLC runtime for the active application. Requires a configured device/gateway in the project.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'connect_to_device', { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script, 60_000);
      return formatToolResponse(result, `Connected to device for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'disconnect_from_device',
    'Disconnects (logs out) from the PLC runtime.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'disconnect_from_device', { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Disconnected from device for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'get_application_state',
    'Gets the current state of the PLC application (running, stopped, exception, etc.).',
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_application_state', { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      // Parse state from output
      const stateMatch = result.output.match(/State:\s*(.+)/);
      const loggedInMatch = result.output.match(/Logged In:\s*(.+)/);
      const appMatch = result.output.match(/Application:\s*(.+)/);

      const text = [
        `Application: ${appMatch ? appMatch[1].trim() : 'Unknown'}`,
        `State: ${stateMatch ? stateMatch[1].trim() : 'Unknown'}`,
        `Logged In: ${loggedInMatch ? loggedInMatch[1].trim() : 'Unknown'}`,
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text }],
        isError: false,
      };
    }
  );

  s.tool(
    'read_variable',
    'Reads the current value of a variable from the running PLC application. Must be connected first.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      variablePath: z.string().describe("Variable path (e.g., 'PLC_PRG.bMotorRunning', 'GVL.nCounter')."),
    },
    async (args: { projectFilePath: string; variablePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'read_variable',
        {
          PROJECT_FILE_PATH: escaped,
          VARIABLE_PATH: args.variablePath.trim(),
        },
        ['ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      const valueMatch = result.output.match(/Value:\s*(.+)/);
      const typeMatch = result.output.match(/Type:\s*(.+)/);
      const text = `${args.variablePath} = ${valueMatch ? valueMatch[1].trim() : 'N/A'} (${typeMatch ? typeMatch[1].trim() : 'unknown'})`;

      return {
        content: [{ type: 'text' as const, text }],
        isError: false,
      };
    }
  );

  s.tool(
    'write_variable',
    'Writes a value to a variable in the running PLC application. Must be connected first.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      variablePath: z.string().describe("Variable path (e.g., 'PLC_PRG.bMotorRunning')."),
      value: z.string().describe("Value to write (e.g., 'TRUE', '42', '3.14')."),
    },
    async (args: { projectFilePath: string; variablePath: string; value: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'write_variable',
        {
          PROJECT_FILE_PATH: escaped,
          VARIABLE_PATH: args.variablePath.trim(),
          VARIABLE_VALUE: args.value,
        },
        ['ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Variable '${args.variablePath}' set to '${args.value}'.`
      );
    }
  );

  s.tool(
    'download_to_device',
    'Downloads the compiled application to the PLC device. Attempts online change first, falls back to full download.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'download_to_device', { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script, 120_000);
      return formatToolResponse(result, `Application downloaded to device for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'start_stop_application',
    'Starts or stops the PLC application on the connected device.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      action: z.string().describe("Action to perform: 'start' or 'stop'."),
    },
    async (args: { projectFilePath: string; action: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'start_stop_application',
        {
          PROJECT_FILE_PATH: escaped,
          APP_ACTION: args.action.trim(),
        },
        ['ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Application ${args.action} executed for ${args.projectFilePath}.`
      );
    }
  );

  // ─── Library Management Tools ─────────────────────────────────────────

  s.tool(
    'list_project_libraries',
    'Lists all libraries currently referenced in the CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'list_project_libraries', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
      );
      const result = await executor.executeScript(script);

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      // Parse libraries JSON
      const libStartMarker = '### LIBRARIES_START ###';
      const libEndMarker = '### LIBRARIES_END ###';
      const startIdx = result.output.indexOf(libStartMarker);
      const endIdx = result.output.indexOf(libEndMarker);

      if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
        return {
          content: [{ type: 'text' as const, text: 'Could not parse libraries output.' }],
          isError: true,
        };
      }

      try {
        const jsonStr = result.output.substring(startIdx + libStartMarker.length, endIdx).trim();
        const libraries: Array<{ name: string; version?: string; company?: string }> = JSON.parse(jsonStr);

        if (libraries.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No libraries found in the project (or Library Manager not found).' }],
            isError: false,
          };
        }

        const lines = libraries.map((lib) => {
          let line = `- ${lib.name}`;
          if (lib.version) line += ` (v${lib.version})`;
          if (lib.company) line += ` [${lib.company}]`;
          return line;
        });

        return {
          content: [{ type: 'text' as const, text: `${libraries.length} library/libraries:\n${lines.join('\n')}` }],
          isError: false,
        };
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Failed to parse libraries JSON.' }],
          isError: true,
        };
      }
    }
  );

  s.tool(
    'add_library',
    'Adds a library reference to the CODESYS project. The library must be installed in the CODESYS library repository.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      libraryName: z.string().describe("Name of the library to add (e.g., 'Standard', 'Util', 'CAA Memory')."),
    },
    async (args: { projectFilePath: string; libraryName: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'add_library',
        {
          PROJECT_FILE_PATH: escaped,
          LIBRARY_NAME: args.libraryName.trim(),
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Library '${args.libraryName}' added to ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'install_library_file',
    "Installs a .library file into the CODESYS Library Repository (system-wide). Useful for automating library bring-up on a fresh machine when the CODESYS Store auto-download is broken (e.g. WAGO libraries). Does not need a project to be open.",
    {
      libraryFilePath: z.string().describe("Full path to the .library file on disk to install."),
    },
    async (args: { libraryFilePath: string }) => {
      const escaped = resolvePath(args.libraryFilePath, workspaceDir);
      const script = scriptManager.prepareScript(
        'install_library_file',
        { LIBRARY_FILE_PATH: escaped }
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Library file installed: ${args.libraryFilePath}`
      );
    }
  );

  s.tool(
    'install_addon_from_file',
    "Installs a CODESYS .package add-on (e.g. WAGO PFC libraries bundle, vendor packages) into a CODESYS installation by shelling out to APInstaller.CLI.exe --installAddOnFromFile. Use this for .package bundles; use install_library_file for plain .library files. Does not need CODESYS UI to be running. NOTE: writes under C:\\Program Files\\CODESYS\\... so requires admin rights -- the MCP server itself must have been launched elevated, otherwise APInstaller exits with 'This command needs elevated rights to run.'",
    {
      packageFilePath: z.string().describe("Full path to the .package file to install."),
      installation: z.string().optional().describe("CODESYS install root (e.g. 'C:\\\\Program Files\\\\CODESYS 3.5.21.50\\\\CODESYS' -- the directory containing Common\\\\CODESYS.exe). Defaults to the install root derived from this MCP's configured CODESYS path."),
    },
    async (args: { packageFilePath: string; installation?: string }) => {
      const cli = locateAPInstallerCli();
      if (!cli) {
        return {
          content: [{
            type: 'text' as const,
            text: `APInstaller.CLI.exe not found. Set CODESYS_APINSTALLER_CLI env var, or install the standalone CODESYS Installer (default path: ${DEFAULT_APINSTALLER_CLI}).`,
          }],
          isError: true,
        };
      }
      const pkg = resolvePath(args.packageFilePath, workspaceDir);
      if (!fs.existsSync(pkg)) {
        return {
          content: [{ type: 'text' as const, text: `Package file not found: ${pkg}` }],
          isError: true,
        };
      }
      // Default installation location = the CODESYS install root, i.e.
      // C:\Program Files\CODESYS 3.5.XX.YY\CODESYS. config.codesysPath
      // points at ...\CODESYS\Common\CODESYS.exe, so two dirnames up.
      // (APInstaller --location wants this exact directory; the parent
      // 'C:\Program Files\CODESYS 3.5.XX.YY' is rejected with
      // "No installation was found in the directory ...".)
      const defaultLocation = path.dirname(path.dirname(config.codesysPath));
      const location = args.installation && args.installation.trim().length > 0
        ? path.normalize(args.installation)
        : defaultLocation;

      const cliArgs = ['--installAddOnFromFile', '--location', location, '--sourcefile', pkg];
      let res;
      try {
        res = await runProcess(cli, cliArgs);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text' as const, text: `Failed to spawn ${cli}: ${msg}` }],
          isError: true,
        };
      }
      const success = res.code === 0;
      const summary = success
        ? `Add-on installed: ${pkg} -> ${location}`
        : `APInstaller exited with code ${res.code}.`;
      const detail = [
        summary,
        '',
        `Command: "${cli}" ${cliArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
        '',
        '--- stdout ---',
        res.stdout || '(empty)',
        '--- stderr ---',
        res.stderr || '(empty)',
      ].join('\n');
      return {
        content: [{ type: 'text' as const, text: detail }],
        isError: !success,
      };
    }
  );

  s.tool(
    'set_library_version',
    "Sets the version of a single library reference in the project's Library Manager. Use for surgical fixes (e.g. unpin StringUtils 3.5.18.0 -> 3.5.20.0) without touching other refs. Use update_all_libraries for bulk changes.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      libraryName: z.string().describe("Library name. Bare name matches case-insensitively (e.g. 'StringUtils'). Use 'Namespace.Name' (e.g. 'System.StringUtils') if the bare name is ambiguous."),
      targetVersion: z.string().describe("Version to set ('*' for always-newest, otherwise an exact version like '3.5.20.0')."),
    },
    async (args: { projectFilePath: string; libraryName: string; targetVersion: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_library_version',
        {
          PROJECT_FILE_PATH: escaped,
          LIBRARY_NAME: args.libraryName.trim(),
          TARGET_VERSION: args.targetVersion.trim(),
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Library '${args.libraryName}' set to version '${args.targetVersion}' in ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'update_all_libraries',
    "Updates every library reference in a project's Library Manager to a target version (default '*' = always-newest installed). By default skips system-pinned references; set includeSystem=true to also rewrite those (risky for device-tied projects). Saves the project on success.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      targetVersion: z.string().optional().describe("Version to set for each library reference. '*' (default) means always-newest installed; otherwise an exact version string like '3.5.20.0'."),
      includeSystem: z.boolean().optional().describe("If true, also update libraries flagged as system. Default: false. Be careful -- changing system library versions can break device-tied projects."),
    },
    async (args: { projectFilePath: string; targetVersion?: string; includeSystem?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const target = (args.targetVersion ?? '*').trim();
      const include = args.includeSystem === true;
      const script = scriptManager.prepareScriptWithHelpers(
        'update_all_libraries',
        {
          PROJECT_FILE_PATH: escaped,
          TARGET_VERSION: target,
          INCLUDE_SYSTEM: include ? 'True' : 'False',
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(
        result,
        `Library references updated to '${target}' in ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'install_library_from_url',
    "Downloads a .library file from a URL (HTTPS supported, follows redirects) and installs it into the CODESYS Library Repository. Companion to install_library_file for fully-automated bring-up from internal shares, vendor download URLs, or GitHub release assets. Does not need a project to be open.",
    {
      url: z.string().describe("Direct URL to the .library file. Must return 2xx; redirects are followed."),
      keepDownload: z.boolean().optional().describe("If true, the downloaded file is kept on disk (path reported in the response). Default: false (temp file deleted after install)."),
    },
    async (args: { url: string; keepDownload?: boolean }) => {
      let tmpPath: string | null = null;
      try {
        tmpPath = await downloadToTempFile(args.url, '.library');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text' as const, text: `Download failed for ${args.url}: ${msg}` }],
          isError: true,
        };
      }
      try {
        const script = scriptManager.prepareScript(
          'install_library_file',
          { LIBRARY_FILE_PATH: tmpPath }
        );
        const result = await executor.executeScript(script);
        const successMsg = args.keepDownload
          ? `Library installed from ${args.url} (download kept at ${tmpPath}).`
          : `Library installed from ${args.url}.`;
        const response = formatToolResponse(result, successMsg);
        return response;
      } finally {
        if (!args.keepDownload && tmpPath) {
          try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
        }
      }
    }
  );

  // ─── Resources ───────────────────────────────────────────────────────

  server.resource(
    'project-status',
    'codesys://project/status',
    async (uri) => {
      try {
        const script = scriptManager.loadTemplate('check_status');
        const result = await executor.executeScript(script);

        const outputLines = result.output.split(/[\r\n]+/).filter((l) => l.trim());
        const statusData: Record<string, string> = {};
        outputLines.forEach((line) => {
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (match) statusData[match[1].trim()] = match[2].trim();
        });

        const statusText = [
          'CODESYS Status:',
          ` - Scripting OK: ${statusData['Scripting OK'] ?? 'Unknown'}`,
          ` - Project Open: ${statusData['Project Open'] ?? 'Unknown'}`,
          ` - Project Name: ${statusData['Project Name'] ?? 'Unknown'}`,
          ` - Project Path: ${statusData['Project Path'] ?? 'N/A'}`,
        ].join('\n');

        const isError =
          !result.success ||
          statusData['Scripting OK']?.toLowerCase() !== 'true';

        return {
          contents: [{ uri: uri.href, text: statusText, contentType: 'text/plain' }],
          isError,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          contents: [{ uri: uri.href, text: `Failed status check: ${msg}`, contentType: 'text/plain' }],
          isError: true,
        };
      }
    }
  );

  const projectStructureTemplate = new ResourceTemplate(
    'codesys://project/{+project_path}/structure',
    { list: undefined }
  );

  server.resource(
    'project-structure',
    projectStructureTemplate,
    async (uri, params) => {
      const projectPath = params.project_path as string;
      if (!projectPath) {
        return {
          contents: [{ uri: uri.href, text: 'Error: Project path missing.', contentType: 'text/plain' }],
          isError: true,
        };
      }
      try {
        const escaped = resolvePath(projectPath, workspaceDir);
        const script = scriptManager.prepareScriptWithHelpers(
          'get_project_structure', { PROJECT_FILE_PATH: escaped }, ['ensure_project_open']
        );
        const result = await executor.executeScript(script);

        let structureText = `Error retrieving structure.\n\n${result.output}`;
        let isError = !result.success;

        if (result.success && result.output.includes('SCRIPT_SUCCESS')) {
          const startMarker = '--- PROJECT STRUCTURE START ---';
          const endMarker = '--- PROJECT STRUCTURE END ---';
          const startIdx = result.output.indexOf(startMarker);
          const endIdx = result.output.indexOf(endMarker);
          if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
            structureText = result.output
              .substring(startIdx + startMarker.length, endIdx)
              .replace(/\\n/g, '\n')
              .trim();
          } else {
            structureText = `Could not parse structure markers.\n\nOutput:\n${result.output}`;
            isError = true;
          }
        }

        return {
          contents: [{ uri: uri.href, text: structureText, contentType: 'text/plain' }],
          isError,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          contents: [{ uri: uri.href, text: `Failed: ${msg}`, contentType: 'text/plain' }],
          isError: true,
        };
      }
    }
  );

  const pouCodeTemplate = new ResourceTemplate(
    'codesys://project/{+project_path}/pou/{+pou_path}/code',
    { list: undefined }
  );

  server.resource(
    'pou-code',
    pouCodeTemplate,
    async (uri, params) => {
      const projectPath = params.project_path as string;
      const pouPath = params.pou_path as string;
      if (!projectPath || !pouPath) {
        return {
          contents: [{ uri: uri.href, text: 'Error: Project or POU path missing.', contentType: 'text/plain' }],
          isError: true,
        };
      }
      try {
        const escProjPath = resolvePath(projectPath, workspaceDir);
        const sanPouPath = sanitizePouPath(pouPath);
        const script = scriptManager.prepareScriptWithHelpers(
          'get_pou_code',
          { PROJECT_FILE_PATH: escProjPath, POU_FULL_PATH: sanPouPath },
          ['ensure_project_open', 'find_object_by_path']
        );
        const result = await executor.executeScript(script);

        let codeText = `Error retrieving code.\n\n${result.output}`;
        let isError = !result.success;

        if (result.success && result.output.includes('SCRIPT_SUCCESS')) {
          const declStart = '### POU DECLARATION START ###';
          const declEnd = '### POU DECLARATION END ###';
          const implStart = '### POU IMPLEMENTATION START ###';
          const implEnd = '### POU IMPLEMENTATION END ###';

          let declaration = '/* Declaration not found */';
          let implementation = '/* Implementation not found */';

          const ds = result.output.indexOf(declStart);
          const de = result.output.indexOf(declEnd);
          if (ds !== -1 && de !== -1 && ds < de) {
            declaration = result.output.substring(ds + declStart.length, de).replace(/\\n/g, '\n').trim();
          }

          const is_ = result.output.indexOf(implStart);
          const ie = result.output.indexOf(implEnd);
          if (is_ !== -1 && ie !== -1 && is_ < ie) {
            implementation = result.output.substring(is_ + implStart.length, ie).replace(/\\n/g, '\n').trim();
          }

          codeText = `// ----- Declaration -----\n${declaration}\n\n// ----- Implementation -----\n${implementation}`;
        }

        return {
          contents: [{ uri: uri.href, text: codeText, contentType: 'text/plain' }],
          isError,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          contents: [{ uri: uri.href, text: `Failed: ${msg}`, contentType: 'text/plain' }],
          isError: true,
        };
      }
    }
  );

  // ─── Connect ─────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  serverLog.info('Connecting MCP server via stdio...');
  server.connect(transport);
  serverLog.info('MCP Server connected and listening.');

  // ─── Graceful Shutdown ───────────────────────────────────────────────

  const shutdown = async () => {
    serverLog.info('Shutdown signal received');
    if (launcher) {
      try {
        await launcher.shutdown();
      } catch {
        serverLog.warn('Launcher shutdown failed during signal handler');
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    serverLog.error(`Unhandled rejection: ${reason}`);
  });
}
