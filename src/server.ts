/**
 * MCP Server — registers tools and resources for CODESYS automation.
 * Supports persistent (watcher-based) and headless (spawn-per-command) modes.
 */

import * as path from 'path';
import * as fs from 'fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ServerConfig, IpcResult, ScriptExecutor, ExecutionMode } from './types';
import { CodesysLauncher } from './launcher';
import { HeadlessExecutor } from './headless';
import { ScriptManager } from './script-manager';
import { serverLog, setLogLevel } from './logger';

/**
 * IEC 61131-3 identifiers that are reserved for time-literal suffixes or
 * standard-block I/O conventions. Using these as variable names produces
 * red-underlined warnings or compile errors in CODESYS.
 *
 *   s/t/d/m/h/ms/us/ns -> time-literal suffixes (T#5s, T#100ms, etc.)
 *   S/R                -> SR/RS flip-flop input names
 *
 * The set is lowercased separately from the original casing -- we check
 * exact-match (case-sensitive) so we catch both 's' and 'S' separately.
 */
const RESERVED_IEC_IDENTIFIERS = new Set([
  's', 't', 'd', 'm', 'h', 'ms', 'us', 'ns',
  'S', 'R',
]);

/**
 * Scan an IEC declarationCode block for VAR declarations whose variable
 * name collides with a reserved identifier. Returns one warning string
 * per offending name. Empty list if the input is empty/safe.
 *
 * Pattern matches lines of the form `<name> : <type>` and is line-anchored
 * so it ignores struct member access (`fb.s`) and similar non-declarations.
 * Catches the first name in each line; multi-name lists like
 * `s, t : BOOL;` only catch the last comma-separated name (rare but
 * worth a future tightening).
 */
function findReservedIecIdentifiers(declarationCode: string | undefined): string[] {
  if (!declarationCode) return [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const pattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z_]/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(declarationCode)) !== null) {
    const name = match[1];
    if (RESERVED_IEC_IDENTIFIERS.has(name) && !seen.has(name)) {
      seen.add(name);
      warnings.push(
        `Reserved IEC identifier '${name}' used as variable name. ` +
        `Single-letter names like s/t/d/m/h/ms/us/ns are time-literal suffixes (T#5s, T#100ms); ` +
        `S/R conflict with SR/RS flip-flop semantics. ` +
        `Rename to a meaningful identifier (e.g. '${name}Inst', '${name}Sample', or use a Hungarian-style prefix like 'st'/'fb'/'b'/'n').`
      );
    }
  }
  return warnings;
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
      // Block on IEC reserved identifiers in declarationCode BEFORE
      // touching the project. Better to refuse than to half-set then
      // surface a soft warning the caller might miss.
      const reservedWarnings = findReservedIecIdentifiers(args.declarationCode);
      if (reservedWarnings.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Refused: declarationCode contains IEC reserved identifier(s). Project NOT modified. Fix and retry.\n\n  - ${reservedWarnings.join('\n  - ')}`,
          }],
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
      // Block on IEC reserved identifiers in declarationCode BEFORE
      // creating the GVL. Refuse rather than create a broken GVL.
      const reservedWarnings = findReservedIecIdentifiers(args.declarationCode);
      if (reservedWarnings.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Refused: declarationCode contains IEC reserved identifier(s). GVL NOT created. Fix and retry.\n\n  - ${reservedWarnings.join('\n  - ')}`,
          }],
          isError: true,
        };
      }
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
    'Connects (logs in) to the PLC runtime for the active application. Requires a configured device/gateway in the project. The first connect to a password-protected runtime pops a credential dialog in CODESYS that the user must fill in -- the loginWaitSeconds parameter controls how long the script polls for state stabilisation while that dialog is up.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      loginWaitSeconds: z.number().int().min(0).max(600).optional().describe("Seconds to wait for the application state to stabilise after login() returns. Used to give the user time to fill in a credential dialog. Default: 60. Range 0-600."),
    },
    async (args: { projectFilePath: string; loginWaitSeconds?: number }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const waitSec = args.loginWaitSeconds ?? 60;
      const script = scriptManager.prepareScriptWithHelpers(
        'connect_to_device',
        {
          PROJECT_FILE_PATH: escaped,
          LOGIN_WAIT_SECONDS: String(waitSec),
        },
        ['ensure_project_open', 'ensure_online_connection']
      );
      // Tool-side timeout = wait window + 30s headroom for actual login work
      const ipcTimeoutMs = (waitSec + 30) * 1000;
      const result = await executor.executeScript(script, ipcTimeoutMs);
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
    'Downloads the compiled application to the PLC device. Attempts online change first, falls back to full download. Same login-dialog handling as connect_to_device: loginWaitSeconds controls how long the script waits for state stabilisation if a credential dialog pops up.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      loginWaitSeconds: z.number().int().min(0).max(600).optional().describe("Seconds to wait for application state to stabilise after login() returns. Default: 60. Range 0-600."),
    },
    async (args: { projectFilePath: string; loginWaitSeconds?: number }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const waitSec = args.loginWaitSeconds ?? 60;
      const script = scriptManager.prepareScriptWithHelpers(
        'download_to_device',
        {
          PROJECT_FILE_PATH: escaped,
          LOGIN_WAIT_SECONDS: String(waitSec),
        },
        ['ensure_project_open', 'ensure_online_connection']
      );
      // Tool-side timeout = wait window + 120s headroom for the actual download
      const ipcTimeoutMs = (waitSec + 120) * 1000;
      const result = await executor.executeScript(script, ipcTimeoutMs);
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

  // ─── Git Tools (CODESYS Git plug-in via project.git) ──────────────────

  s.tool(
    'git_status',
    "Reports the project's git status: current branch, plus a probe of any status/changes/diff methods exposed on project.git. Read-only. Requires the CODESYS Git plug-in (ships with CODESYS) AND an active CODESYS Professional Developer Edition subscription license -- without the subscription, every project.git.* operation is gated by the runtime 'HasGitLicense' rule and the tool fails fast with a clear PDE-required message. Also requires the project to be bound to a git working tree (use git_init if not). Diagnostic dump of project.git surface is included.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'git_status',
        { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `git_status for ${args.projectFilePath} (see output for branch and probe results).`);
    }
  );

  s.tool(
    'git_init',
    "Initialises a Git working tree for the project via project.git.init(). CODESYS Git uses a dual-storage model: the .project file stays where it is, the git repo lives in a SEPARATE empty directory. If localRepoPath is omitted (or equals the project's own folder), the tool auto-defaults to a '<project_basename>_git' sibling and auto-creates it; if it exists and is non-empty, the tool fails with a clear hint. One-shot setup; use git_status afterwards to confirm. Requires the CODESYS Git plug-in AND an active CODESYS Professional Developer Edition subscription license -- without the subscription, the tool fails fast with a clear PDE-required message (the runtime 'HasGitLicense' rule gates every project.git.* call).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      localRepoPath: z.string().optional().describe("Filesystem path for the git working tree. Must be a separate empty directory, NOT the project's own folder. If omitted, defaults to a '<project_basename>_git' sibling and auto-creates it."),
    },
    async (args: { projectFilePath: string; localRepoPath?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const repoPath = args.localRepoPath ? resolvePath(args.localRepoPath, workspaceDir) : '';
      const script = scriptManager.prepareScriptWithHelpers(
        'git_init',
        {
          PROJECT_FILE_PATH: escaped,
          LOCAL_REPO_PATH: repoPath,
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `git_init complete for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'git_commit',
    "Stages all working-tree changes and commits them via project.git.commit_complete(message, user, mail). Requires the project to already be bound to a git repo (use git_init first if needed) AND an active CODESYS Professional Developer Edition subscription license -- without the subscription, the tool fails fast with a clear PDE-required message (the runtime 'HasGitLicense' rule gates every project.git.* call).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      message: z.string().min(1).describe("Commit message. Multiline OK."),
      authorName: z.string().min(1).describe("Author name (used as the 'user' parameter to commit_complete)."),
      authorEmail: z.string().email().describe("Author email."),
    },
    async (args: { projectFilePath: string; message: string; authorName: string; authorEmail: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      // Escape message for triple-quoted Python string injection
      const safeMessage = args.message.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
      const script = scriptManager.prepareScriptWithHelpers(
        'git_commit',
        {
          PROJECT_FILE_PATH: escaped,
          COMMIT_MESSAGE: safeMessage,
          AUTHOR_NAME: args.authorName,
          AUTHOR_EMAIL: args.authorEmail,
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `git_commit complete for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'git_remote_add',
    "Adds a named git remote to the project's repository via project.git.remote_add(name, url). One-shot. Pair with git_push afterwards. Requires the project to already be bound to a git repo (run git_init first if needed) AND an active CODESYS Professional Developer Edition subscription license -- without the subscription, the tool fails fast with a clear PDE-required message (the runtime 'HasGitLicense' rule gates every project.git.* call).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      remoteName: z.string().min(1).describe("Remote name. Conventionally 'origin' for the primary upstream."),
      remoteUrl: z.string().min(1).describe("Remote URL. HTTPS recommended (e.g. https://gitlab.usv.no/<user>/<repo>.git); SSH also accepted if the CODESYS process has key access."),
    },
    async (args: { projectFilePath: string; remoteName: string; remoteUrl: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'git_remote_add',
        {
          PROJECT_FILE_PATH: escaped,
          REMOTE_NAME: args.remoteName,
          REMOTE_URL: args.remoteUrl,
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `git_remote_add complete for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'git_push',
    "Pushes the local branch to a configured remote via project.git.push(). If username + token are both provided, uses the 3-arg overload push(branch, user, SecureString(token)) and derives the current branch when branchName is omitted; otherwise calls push(branch) or push() and relies on git config / Windows Credential Manager / cached credentials. SECURITY NOTE: when token is supplied, it is templated into the IronPython script that the watcher executes -- briefly resident in the watcher's command file on disk. Prefer cached credentials (omit token) when feasible. Requires an existing git binding on the project, a configured remote (use git_remote_add), and an active CODESYS Professional Developer Edition subscription license -- without the subscription, the tool fails fast with a clear PDE-required message.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      branchName: z.string().optional().describe("Branch to push. Optional; derived from the current branch when token is supplied, or left to push()'s default upstream resolution otherwise."),
      username: z.string().optional().describe("Optional HTTPS username. For GitLab personal access tokens any non-empty username works (commonly 'oauth2' or the GitLab username). Pair with token."),
      token: z.string().optional().describe("Optional HTTPS password / personal access token. Sensitive -- prefer cached credentials when possible. If supplied, converted to System.Security.SecureString before being handed to project.git.push."),
    },
    async (args: { projectFilePath: string; branchName?: string; username?: string; token?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      // The script wraps these values inside double-quoted Python strings,
      // so we need to neutralise backslashes and double-quotes. Newlines
      // would also break the string -- reject them up front rather than
      // attempting to escape, since legitimate auth values never contain them.
      const sanitiseForPyDouble = (s: string | undefined, label: string): string => {
        const v = s || '';
        if (/\r|\n/.test(v)) throw new Error(`${label} must not contain newlines`);
        return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      };
      const script = scriptManager.prepareScriptWithHelpers(
        'git_push',
        {
          PROJECT_FILE_PATH: escaped,
          BRANCH_NAME: sanitiseForPyDouble(args.branchName, 'branchName'),
          USERNAME: sanitiseForPyDouble(args.username, 'username'),
          TOKEN: sanitiseForPyDouble(args.token, 'token'),
        },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `git_push complete for ${args.projectFilePath}.`);
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
