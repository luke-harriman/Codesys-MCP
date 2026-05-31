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
import { ExecutorProxy } from './executor-proxy';
import { parseResultJson } from './result-parser';
import { serverLog, setLogLevel } from './logger';

let SERVER_VERSION = '0.0.0';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SERVER_VERSION = require('../package.json').version;
} catch {
  // package.json not found at runtime; fall through with the placeholder.
}

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

  serverLog.info(`Starting CODESYS Persistent MCP Server v${SERVER_VERSION}`);
  serverLog.info(`Mode: ${config.mode}`);
  serverLog.info(`CODESYS Path: ${config.codesysPath}`);
  serverLog.info(`Profile: ${config.profileName}`);
  serverLog.info(`Workspace: ${config.workspaceDir}`);

  // Validate CODESYS path
  if (!fs.existsSync(config.codesysPath)) {
    throw new Error(`CODESYS executable not found: ${config.codesysPath}`);
  }

  // Initialize executor based on mode.
  //
  // IMPORTANT: We do NOT await launcher.launch() here. CODESYS persistent startup
  // takes ~30s, but the MCP `initialize` handshake from Claude Code times out long
  // before that — making the server look "Failed to connect" while a zombie CODESYS
  // process stays running. Instead we register tools, connect the stdio transport
  // immediately (so the handshake answers in milliseconds), then kick the launch
  // off in the background and swap the executor reference once it's ready.
  // Tool handlers below capture `executor` as a `let` binding, so reassignment
  // propagates without further changes.
  // Stable proxy reference. Tool handlers capture `executor` once (it's a
  // const) and never see the inner swap directly - the proxy gates every
  // executeScript on a readiness promise that's atomically updated whenever
  // the inner executor changes (see executor-proxy.ts for the contract).
  let launcher: CodesysLauncher | null = null;
  let executionMode: ExecutionMode = config.mode;
  const initialExecutor: ScriptExecutor = new HeadlessExecutor(config);
  const executor = new ExecutorProxy(initialExecutor);

  if (config.mode === 'persistent') {
    launcher = new CodesysLauncher(config);
    // Start in headless mode; we'll swap to the persistent launcher once it's
    // ready (see "Background auto-launch" block below).
    executionMode = 'headless';
  }

  const scriptManager = new ScriptManager();
  const workspaceDir = config.workspaceDir;

  // Create MCP server
  const server = new McpServer(
    {
      name: 'CODESYS Persistent MCP Server',
      version: SERVER_VERSION,
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
        executor.swapNow(launcher);
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
      // Swap the executor BEFORE awaiting shutdown - if shutdown throws
      // mid-flight, we don't want the proxy still pointing at a dead launcher.
      executor.swapNow(new HeadlessExecutor(config));
      executionMode = 'headless';
      try {
        await launcher.shutdown();
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
    'eval_python',
    "[DEV] Execute arbitrary IronPython 2.7 inside the live CODESYS scriptengine. The supplied code is forwarded to the watcher verbatim — anything `print`ed lands in the response, and the call returns success if SCRIPT_SUCCESS is printed before exit. Intended for ScriptEngine API audits, NOT routine use; do NOT invoke the IDE's 'Login' command (it hangs the IDE primary thread). Common imports already available: scriptengine, sys, os.",
    {
      code: z.string().describe("IronPython 2.7 source. Has access to module `scriptengine`. Must print `SCRIPT_SUCCESS` (literal) before sys.exit(0) for the tool to report success."),
      timeoutMs: z.number().int().positive().optional().describe("Timeout in ms (default 30000)."),
    },
    async (args: { code: string; timeoutMs?: number }) => {
      const result = await executor.executeScript(args.code, args.timeoutMs ?? 30_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      return {
        content: [{
          type: 'text' as const,
          text: success
            ? result.output
            : `eval_python failed.\n--- output ---\n${result.output}${result.error ? '\n--- error ---\n' + result.error : ''}`,
        }],
        isError: !success,
      };
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
        'open_project', { PROJECT_FILE_PATH: escaped }, ['_text_utils', 'ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Project opened: ${args.filePath}`);
    }
  );

  s.tool(
    'create_project',
    "Create a new CODESYS project from a template. By default copies the bundled Standard.project. Pass templatePath to copy a different .project file (Option A), or templateName to instantiate a template registered with CODESYS's Template Manager — e.g. an ifm AE3100 template from an installed device package (Option B). Use list_project_templates to discover valid templateName / templatePath values.",
    {
      filePath: z.string().describe("Path where the new project file should be created."),
      templatePath: z.string().optional().describe("Optional path to a .project file to copy as the template. Use when you have a known-good reference project on disk."),
      templateName: z.string().optional().describe("Optional name of a template registered with CODESYS (as seen in File > New Project > Standard Project from Template). Resolved via ScriptEngine; use list_project_templates to discover names."),
    },
    async (args: { filePath: string; templatePath?: string; templateName?: string }) => {
      const absPath = path.normalize(
        path.isAbsolute(args.filePath) ? args.filePath : path.join(workspaceDir, args.filePath)
      );

      // templateName takes precedence over templatePath (more specific intent).
      // If neither is provided, fall back to the bundled Standard.project copy.
      let mode: 'name' | 'path';
      let templatePath = '';
      let templateName = '';

      if (args.templateName && args.templateName.trim().length > 0) {
        mode = 'name';
        templateName = args.templateName.trim();
      } else if (args.templatePath && args.templatePath.trim().length > 0) {
        mode = 'path';
        templatePath = path.normalize(
          path.isAbsolute(args.templatePath) ? args.templatePath : path.join(workspaceDir, args.templatePath)
        );
        if (!(await fileExists(templatePath))) {
          return {
            content: [{ type: 'text' as const, text: `Template Error: templatePath does not exist: ${templatePath}` }],
            isError: true,
          };
        }
      } else {
        // Default: bundled Standard.project, same lookup chain as before.
        mode = 'path';
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
                throw new Error('Standard template project file not found. Pass templatePath or templateName explicitly.');
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
      }

      const script = scriptManager.prepareScript('create_project', {
        TEMPLATE_MODE: mode,
        PROJECT_FILE_PATH: absPath,
        TEMPLATE_PROJECT_PATH: templatePath,
        TEMPLATE_NAME: templateName,
      });
      const result = await executor.executeScript(script);
      const sourceDesc = mode === 'name' ? `template '${templateName}'` : `template file ${templatePath}`;
      return formatToolResponse(result, `Project created from ${sourceDesc}: ${absPath}`);
    }
  );

  s.tool(
    'list_project_templates',
    "List project templates known to this CODESYS install. Combines (1) templates registered via CODESYS's Template Manager — what File > New Project > Standard Project from Template shows — and (2) a filesystem scan of well-known template locations under %ProgramData%/CODESYS. Returns {name, path, source} per template; pass `name` to create_project(templateName=...) or `path` to create_project(templatePath=...).",
    {
      extraTemplateDir: z.string().optional().describe("Optional additional directory to scan for .project / .projecttemplate files."),
    },
    async (args: { extraTemplateDir?: string }) => {
      const script = scriptManager.prepareScriptWithHelpers(
        'list_project_templates',
        { EXTRA_TEMPLATE_DIR: args.extraTemplateDir ?? '' },
        ['_text_utils']
      );
      const result = await executor.executeScript(script, 60_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      const parsed = parseResultJson<{
        templates: Array<{ name: string | null; path: string | null; source: string }>;
        count: number;
        api_attempts: string[];
        filesystem_hits: number;
      }>(result.output);
      if (!parsed.ok) return formatToolResponse(result, '');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(parsed.data, null, 2) }],
        isError: false,
      };
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
        'save_project', { PROJECT_FILE_PATH: escaped }, ['_text_utils', 'ensure_project_open']
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
      name: z.string().min(1).describe("Name for the new POU (must be a valid IEC identifier)."),
      type: z.enum(['Program', 'FunctionBlock', 'Function']).describe("Type of POU."),
      language: z.enum(['ST', 'LD', 'FBD', 'SFC', 'IL', 'CFC']).describe("Implementation language."),
      parentPath: z.string().min(1).describe("Relative path under project root or application (e.g., 'Application')."),
    },
    async (args: { projectFilePath: string; name: string; type: 'Program' | 'FunctionBlock' | 'Function'; language: 'ST' | 'LD' | 'FBD' | 'SFC' | 'IL' | 'CFC'; parentPath: string }) => {
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
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
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
    'Sets the declaration and/or implementation code for a specific POU, Method, or Property. Omit (or pass empty string for) a section to leave it unchanged.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      pouPath: z.string().min(1).describe("Full relative path to the target object (e.g., 'Application/MyPOU')."),
      declarationCode: z.string().optional().describe("Code for the declaration part (VAR...END_VAR). If omitted or empty, not changed."),
      implementationCode: z.string().optional().describe("Code for the implementation logic. If omitted or empty, not changed."),
    },
    async (args: { projectFilePath: string; pouPath: string; declarationCode?: string; implementationCode?: string }) => {
      // Treat empty string the same as omitted - the previous code silently
      // overwrote the section with an empty string, which was surprising and
      // caused data loss. To explicitly clear a section, pass a single-line
      // placeholder like a comment.
      const declProvided = args.declarationCode !== undefined && args.declarationCode !== '';
      const implProvided = args.implementationCode !== undefined && args.implementationCode !== '';
      if (!declProvided && !implProvided) {
        return {
          content: [{ type: 'text' as const, text: 'Error: At least one of declarationCode or implementationCode must be provided (and non-empty).' }],
          isError: true,
        };
      }
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanPouPath = sanitizePouPath(args.pouPath);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_pou_code',
        {
          PROJECT_FILE_PATH: escProjPath,
          POU_FULL_PATH: sanPouPath,
          DECLARATION_CONTENT: args.declarationCode ?? '',
          IMPLEMENTATION_CONTENT: args.implementationCode ?? '',
          UPDATE_DECL: declProvided ? '1' : '0',
          UPDATE_IMPL: implProvided ? '1' : '0',
        },
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
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
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
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
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
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
        'compile_project', { PROJECT_FILE_PATH: escaped }, ['_text_utils', 'ensure_project_open']
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
    "Retrieves the last compiler messages (errors, warnings) without triggering a new build. Note: returns the cached results from the last compile_project run; if you've edited code since, run compile_project to refresh.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'get_compile_messages', { PROJECT_FILE_PATH: escaped }, ['_text_utils', 'ensure_project_open']
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
          content: [{ type: 'text' as const, text: `No compile messages found. The message API may not be available in this CODESYS version.` }],
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
    'Creates a new Data Unit Type (DUT) - structure, enumeration, union, or alias - within the specified CODESYS project.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      name: z.string().min(1).describe("Name for the new DUT (must be a valid IEC identifier)."),
      dutType: z.enum(['Structure', 'Enumeration', 'Union', 'Alias']).describe("Type of DUT."),
      parentPath: z.string().min(1).describe("Relative path under project root or application (e.g., 'Application')."),
    },
    async (args: { projectFilePath: string; name: string; dutType: 'Structure' | 'Enumeration' | 'Union' | 'Alias'; parentPath: string }) => {
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
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
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
      const script = scriptManager.prepareScriptWithHelpers(
        'create_gvl',
        {
          PROJECT_FILE_PATH: escProjPath,
          GVL_NAME: args.name.trim(),
          PARENT_PATH: sanParentPath,
          DECLARATION_CONTENT: args.declarationCode ?? '',
        },
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
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
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
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
    'Deletes a project object (POU, DUT, GVL, folder, etc.) from the CODESYS project. WARNING: This is destructive and cannot be undone. System nodes (Application, Device, Plc Logic, Library Manager, Project Settings, Task Configuration, etc.) are refused.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      objectPath: z.string().describe("Full relative path to the object to delete (e.g., 'Application/MyPOU')."),
    },
    async (args: { projectFilePath: string; objectPath: string }) => {
      const escProjPath = resolvePath(args.projectFilePath, workspaceDir);
      const sanObjPath = sanitizePouPath(args.objectPath);
      // Refuse to delete system nodes by EXACT PATH MATCH - the previous
      // last-segment-only check produced false positives (a user folder
      // named `MainTask` under `Application/SomeFolder/MainTask` was wrongly
      // refused). Match the exact canonical paths instead, plus reject any
      // top-level path (no `/`).
      const SYSTEM_PATHS = new Set([
        'Application',
        'Device',
        'Project Settings',
        '__VisualizationStyle',
        'Device/Plc Logic',
        'Device/Plc Logic/Application',
        'Application/Library Manager',
        'Device/Plc Logic/Application/Library Manager',
        'Application/Task Configuration',
        'Device/Plc Logic/Application/Task Configuration',
        'Application/Task Configuration/MainTask',
        'Device/Plc Logic/Application/Task Configuration/MainTask',
        'Device/Communication',
        'Device/Communication/Ethernet',
        'Device/SoftMotion General Axis Pool',
      ]);
      if (sanObjPath === '' || !sanObjPath.includes('/') || SYSTEM_PATHS.has(sanObjPath)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Refused: '${sanObjPath || '(empty)'}' is a system node or top-level object. delete_object only operates on user objects nested under a parent (e.g. 'Application/MyPOU').`,
          }],
          isError: true,
        };
      }
      const script = scriptManager.prepareScriptWithHelpers(
        'delete_object',
        {
          PROJECT_FILE_PATH: escProjPath,
          OBJECT_PATH: sanObjPath,
        },
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
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
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
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
        'get_all_pou_code', { PROJECT_FILE_PATH: escaped }, ['_text_utils', 'ensure_project_open']
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

  s.tool(
    'search_code',
    'Regex (or literal substring) search across every POU/Method/Property/DUT/GVL textual body. Returns file:line:col hits. Graphical bodies with no textual_implementation are skipped.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      pattern: z.string().min(1).describe("Pattern to search for. Treated as a regex unless regex=false."),
      regex: z.boolean().optional().describe("If true (default), pattern is a regex. If false, pattern is a literal substring."),
      caseSensitive: z.boolean().optional().describe("If true (default), matching is case-sensitive."),
      includeDeclaration: z.boolean().optional().describe("If true (default), search declaration sections."),
      includeImplementation: z.boolean().optional().describe("If true (default), search implementation sections."),
      maxHits: z.number().int().positive().optional().describe("Cap the number of returned hits (default 1000)."),
    },
    async (args: {
      projectFilePath: string;
      pattern: string;
      regex?: boolean;
      caseSensitive?: boolean;
      includeDeclaration?: boolean;
      includeImplementation?: boolean;
      maxHits?: number;
    }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'search_code',
        {
          PROJECT_FILE_PATH: escaped,
          PATTERN: args.pattern,
          USE_REGEX: (args.regex ?? true) ? '1' : '0',
          CASE_SENSITIVE: (args.caseSensitive ?? true) ? '1' : '0',
          INCLUDE_DECL: (args.includeDeclaration ?? true) ? '1' : '0',
          INCLUDE_IMPL: (args.includeImplementation ?? true) ? '1' : '0',
          MAX_HITS: String(args.maxHits ?? 1000),
        },
        ['_text_utils', 'ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      const parsed = parseResultJson<{
        hits: Array<{ path: string; section: string; line: number; col: number; text: string; match: string }>;
        count: number;
        truncated: boolean;
        pattern: string;
      }>(result.output);
      if (!parsed.ok) return formatToolResponse(result, '');
      const { hits, count, truncated } = parsed.data;
      if (count === 0) {
        return {
          content: [{ type: 'text' as const, text: `No matches for /${args.pattern}/ in project.` }],
          isError: false,
        };
      }
      const lines = hits.map(h =>
        `${h.path}:${h.line}:${h.col} (${h.section}) ${h.text.trim()}`
      );
      const header = `${count} match(es)${truncated ? ' (truncated to maxHits)' : ''}:`;
      return {
        content: [{ type: 'text' as const, text: `${header}\n${lines.join('\n')}` }],
        isError: false,
      };
    }
  );

  // ─── Online/Runtime Tools ─────────────────────────────────────────────

  s.tool(
    'connect_to_device',
    'Connects (logs in) to the PLC runtime for the active application. If ipAddress is provided, set_gateway_and_address is called on the device first; otherwise the device must already have a configured gateway/address (or be in simulation mode via set_simulation_mode).',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      ipAddress: z.string().optional().describe("Optional PLC IP address. Sets the device gateway/address before login. Leave unset to use whatever is configured on the device, or to use simulation mode."),
      gatewayName: z.string().optional().describe("Optional gateway name (defaults to 'Gateway-1', the CODESYS install default). Only used if ipAddress is also provided."),
    },
    async (args: { projectFilePath: string; ipAddress?: string; gatewayName?: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'connect_to_device',
        {
          PROJECT_FILE_PATH: escaped,
          IP_ADDRESS: (args.ipAddress || '').trim(),
          GATEWAY_NAME: (args.gatewayName || '').trim(),
        },
        ['ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script, 60_000);
      return formatToolResponse(result, `Connected to device for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'set_credentials',
    'Set default username/password used for subsequent PLC logins. Use this once per session before connect_to_device when the runtime requires authentication. Both fields must be non-empty: CODESYS rejects empty username strings. If your runtime has no auth, do not call this tool.',
    {
      username: z.string().min(1).describe("Username (must be non-empty; CODESYS rejects empty strings)."),
      password: z.string().describe("Password."),
    },
    async (args: { username: string; password: string }) => {
      const script = scriptManager.prepareScript(
        'set_credentials',
        { USERNAME: args.username, PASSWORD: args.password }
      );
      const result = await executor.executeScript(script, 10_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      return {
        content: [{ type: 'text' as const, text: `Default credentials set (user='${args.username}').` }],
        isError: false,
      };
    }
  );

  s.tool(
    'set_simulation_mode',
    'Toggle PLC simulation mode on/off for the project Device. Run before connect_to_device when no physical PLC is available; CODESYS will then simulate execution without a runtime gateway.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      enable: z.boolean().describe("True to enable simulation mode, false to disable."),
      verbose: z.boolean().optional().describe("If true, return the full script output (device list, verification, etc.). Default false returns a terse summary."),
    },
    async (args: { projectFilePath: string; enable: boolean; verbose?: boolean }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_simulation_mode',
        { PROJECT_FILE_PATH: escaped, ENABLE: args.enable ? 'true' : 'false' },
        ['_text_utils', 'ensure_project_open']
      );
      const result = await executor.executeScript(script, 30_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      if (args.verbose === true) {
        return { content: [{ type: 'text' as const, text: result.output }], isError: false };
      }
      const afterMatch = result.output.match(/Simulation After:\s*(.+)/);
      const after = afterMatch ? afterMatch[1].trim() : 'unknown';
      return {
        content: [{ type: 'text' as const, text: `Simulation mode ${args.enable ? 'enabled' : 'disabled'} on device. Current state: ${after}` }],
        isError: false,
      };
    }
  );

  s.tool(
    'disconnect_from_device',
    'Disconnects (logs out) from the PLC runtime. No-op (success) if not connected.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
    },
    async (args: { projectFilePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'disconnect_from_device', { PROJECT_FILE_PATH: escaped },
        ['ensure_project_open']
      );
      const result = await executor.executeScript(script);
      return formatToolResponse(result, `Disconnected from device for ${args.projectFilePath}.`);
    }
  );

  s.tool(
    'get_application_state',
    'Report the running PLC application state (run / stop / exception) plus login status. Connect first.',
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
    "Read a live variable from the running PLC. Path format: 'GVL_Name.varname' or 'PRG_Name.varname' (no 'Application.' prefix). Struct members: 'GVL.stFrame.aRoi[0].iValueMm'. Connect first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      variablePath: z.string().describe("Variable path. Examples: 'GVL_TestControl.iScenario', 'PLC_PRG.bMotor', 'GVL_Cameras.stCam.aRoi[3].iValueMm'. No 'Application.' prefix."),
    },
    async (args: { projectFilePath: string; variablePath: string }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'read_variable',
        {
          PROJECT_FILE_PATH: escaped,
          VARIABLE_PATH: args.variablePath.trim(),
        },
        ['_text_utils', 'ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script);

      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) {
        return formatToolResponse(result, '');
      }

      // Parse the structured RESULT_JSON block; multi-line struct values
      // survive intact via this channel (the previous regex Value: capture
      // truncated at the first newline).
      const parsed = parseResultJson<{ variable: string; value: string | null; type: string | null; raw: string | null; application: string }>(result.output);
      if (!parsed.ok) {
        return formatToolResponse(result, '');
      }
      const text = `${parsed.data.variable} = ${parsed.data.value ?? 'N/A'} (${parsed.data.type ?? 'unknown'})`;
      return {
        content: [{ type: 'text' as const, text }],
        isError: false,
      };
    }
  );

  s.tool(
    'write_variable',
    "Write a value to a PLC variable via V3's set_prepared_value + force_prepared_values. The variable is FORCED at the new value until unforced (or runtime restart). Use for control flags and test injection, not program outputs. Connect first.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      variablePath: z.string().describe("Variable path (e.g., 'GVL_TestControl.xEnable', 'PLC_PRG.iScenario'). No 'Application.' prefix."),
      value: z.string().describe("Value to write as IEC literal (e.g., 'TRUE', '42', 'INT#-3', '3.14')."),
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
    "Downloads the compiled application to the PLC device. mode controls strategy: 'auto' (default) tries online change then falls back to full; 'online_change' fails if online change is rejected; 'full' always does a full download.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      mode: z.enum(['auto', 'online_change', 'full']).optional().describe("Download strategy. Default 'auto'."),
    },
    async (args: { projectFilePath: string; mode?: 'auto' | 'online_change' | 'full' }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const mode = args.mode || 'auto';
      const script = scriptManager.prepareScriptWithHelpers(
        'download_to_device',
        { PROJECT_FILE_PATH: escaped, MODE: mode },
        ['ensure_project_open', 'ensure_online_connection']
      );
      const result = await executor.executeScript(script, 120_000);
      return formatToolResponse(result, `Application downloaded to device for ${args.projectFilePath} (mode=${mode}).`);
    }
  );

  s.tool(
    'start_stop_application',
    'Starts or stops the PLC application on the connected device.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      action: z.enum(['start', 'stop']).describe("Action to perform."),
    },
    async (args: { projectFilePath: string; action: 'start' | 'stop' }) => {
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'start_stop_application',
        {
          PROJECT_FILE_PATH: escaped,
          APP_ACTION: args.action,
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
        'list_project_libraries', { PROJECT_FILE_PATH: escaped }, ['_text_utils', 'ensure_project_open']
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
    'list_device_repository',
    "Enumerate device descriptors from the local CODESYS Device Repository. Returns {name, vendor, device_type, device_id, version, description, category} per entry. Use to discover canonical ids for add_device.",
    {
      vendor: z.string().optional().describe("Optional case-insensitive vendor substring filter (e.g. '3S', 'ifm', 'Beckhoff')."),
      nameContains: z.string().optional().describe("Optional case-insensitive substring filter on the device name."),
      maxResults: z.number().int().positive().optional().describe("Cap on returned entries (default 500)."),
    },
    async (args: { vendor?: string; nameContains?: string; maxResults?: number }) => {
      // No project context needed - this hits the GLOBAL repository on the
      // CODESYS instance. The script doesn't include ensure_project_open or
      // require_project_open in its helper chain.
      const script = scriptManager.prepareScriptWithHelpers(
        'list_device_repository',
        {
          VENDOR_FILTER: args.vendor ?? '',
          NAME_FILTER: args.nameContains ?? '',
          MAX_RESULTS: String(args.maxResults ?? 500),
        },
        ['_text_utils']
      );
      const result = await executor.executeScript(script, 60_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      const parsed = parseResultJson<{
        devices: Array<{ name: string | null; vendor: string | null; device_type: number | null; device_id: number | null; version: string | null; category: string | null; description: string | null }>;
        count: number;
        truncated: boolean;
        total_in_repo: number;
      }>(result.output);
      if (!parsed.ok) return formatToolResponse(result, '');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(parsed.data, null, 2) }],
        isError: false,
      };
    }
  );

  s.tool(
    'map_io_channel',
    "Bind (or clear) a fieldbus I/O channel to a global variable symbol. Use inspect_device_node first to discover the channel layout.",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      devicePath: z.string().min(1).describe("Path to the device node (e.g. 'Device/Ethernet/EIP_Adapter')."),
      channelPath: z.string().min(1).describe("Channel address relative to the device. Either a name path ('Inputs/Byte 0/Bit 3') or numeric indices ('0/3')."),
      variableName: z.string().optional().describe("Global variable to bind (e.g. 'GVL.bSensor', 'PLC_PRG.xMotor'). Required unless clearBinding is true."),
      clearBinding: z.boolean().optional().describe("If true, remove the existing binding instead of setting one. variableName is ignored."),
    },
    async (args: {
      projectFilePath: string;
      devicePath: string;
      channelPath: string;
      variableName?: string;
      clearBinding?: boolean;
    }) => {
      const escProj = resolvePath(args.projectFilePath, workspaceDir);
      const sanDev = sanitizePouPath(args.devicePath);
      const script = scriptManager.prepareScriptWithHelpers(
        'map_io_channel',
        {
          PROJECT_FILE_PATH: escProj,
          DEVICE_PATH: sanDev,
          CHANNEL_PATH: args.channelPath,
          VARIABLE_NAME: args.variableName ?? '',
          CLEAR_BINDING: args.clearBinding ? '1' : '0',
        },
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 30_000);
      return formatToolResponse(
        result,
        args.clearBinding
          ? `Cleared I/O channel binding at '${sanDev}/${args.channelPath}'. Project saved.`
          : `Bound '${sanDev}/${args.channelPath}' -> ${args.variableName}. Project saved.`
      );
    }
  );

  s.tool(
    'inspect_device_node',
    'Read-only introspection of a device node: descriptor metadata, parameter list with current values, child sub-devices. Pair with set_device_parameter to discover writable IDs.',
    {
      projectFilePath: z.string().describe("Path to the project file (must be the currently-open project)."),
      devicePath: z.string().min(1).describe("Path to the device node, e.g. 'Device' for the PLC root, 'Device/Ethernet/EIP_Adapter' for a fieldbus adapter."),
    },
    async (args: { projectFilePath: string; devicePath: string }) => {
      const escProj = resolvePath(args.projectFilePath, workspaceDir);
      const sanDev = sanitizePouPath(args.devicePath);
      const script = scriptManager.prepareScriptWithHelpers(
        'inspect_device_node',
        { PROJECT_FILE_PATH: escProj, DEVICE_PATH: sanDev },
        ['_text_utils', 'require_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 30_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      const parsed = parseResultJson(result.output);
      if (!parsed.ok) return formatToolResponse(result, '');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(parsed.data, null, 2) }],
        isError: false,
      };
    }
  );

  s.tool(
    'add_device',
    'Add a device under an existing parent device. Use list_device_repository to source canonical deviceType/deviceId/version. Wrong ids produce a wrong-but-syntactically-valid node that fails at compile time.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      parentDevicePath: z.string().min(1).describe("Path to the parent device in the project tree, e.g. 'Device' for the root PLC, 'Device/Ethernet' for a fieldbus master."),
      deviceName: z.string().min(1).describe("Name for the new device node (must be a valid CODESYS object name)."),
      deviceType: z.number().int().describe("CODESYS device type id (numeric, from the device repository)."),
      deviceId: z.number().int().optional().describe("CODESYS device id (numeric). Some add_device signatures don't require this."),
      version: z.string().optional().describe("Version string for the device (e.g. '3.5.16.0')."),
    },
    async (args: {
      projectFilePath: string;
      parentDevicePath: string;
      deviceName: string;
      deviceType: number;
      deviceId?: number;
      version?: string;
    }) => {
      const escProj = resolvePath(args.projectFilePath, workspaceDir);
      const sanParent = sanitizePouPath(args.parentDevicePath);
      const script = scriptManager.prepareScriptWithHelpers(
        'add_device',
        {
          PROJECT_FILE_PATH: escProj,
          PARENT_DEVICE_PATH: sanParent,
          DEVICE_NAME: args.deviceName.trim(),
          DEVICE_TYPE: String(args.deviceType),
          DEVICE_ID: args.deviceId !== undefined ? String(args.deviceId) : '',
          DEVICE_VERSION: args.version ?? '',
        },
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 60_000);
      return formatToolResponse(
        result,
        `Device '${args.deviceName}' added under '${sanParent}' in ${args.projectFilePath}. Project saved.`
      );
    }
  );

  s.tool(
    'set_device_parameter',
    'EXPERIMENTAL. Set a parameter value on a device. Use inspect_device_node first to find writable IDs. Many fieldbus parameters are GUI-only; this tool returns a clear error in that case.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      devicePath: z.string().min(1).describe("Path to the device in the project tree, e.g. 'Device/Ethernet/EIP_Adapter_X'."),
      parameterId: z.union([z.number().int(), z.string().min(1)]).describe("Parameter id (numeric for most CODESYS device descriptors; string accepted as a fallback)."),
      value: z.string().describe("Value to write. Use the type-appropriate textual representation (e.g. '192.168.1.10' for IP, 'TRUE' for BOOL, '42' for INT)."),
    },
    async (args: {
      projectFilePath: string;
      devicePath: string;
      parameterId: number | string;
      value: string;
    }) => {
      const escProj = resolvePath(args.projectFilePath, workspaceDir);
      const sanDev = sanitizePouPath(args.devicePath);
      const script = scriptManager.prepareScriptWithHelpers(
        'set_device_parameter',
        {
          PROJECT_FILE_PATH: escProj,
          DEVICE_PATH: sanDev,
          PARAMETER_ID: String(args.parameterId),
          VALUE: args.value,
        },
        ['_text_utils', 'ensure_project_open', 'find_object_by_path']
      );
      const result = await executor.executeScript(script, 30_000);
      return formatToolResponse(
        result,
        `Parameter ${args.parameterId} on '${sanDev}' set to '${args.value}'. Project saved.`
      );
    }
  );

  s.tool(
    'find_references',
    'Find every word-boundary reference to a symbol (\\bsymbol\\b) across textual POU/Method/Property/DUT/GVL bodies. Wraps search_code. Comments and string literals are not excluded.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      symbol: z.string().min(1).describe("Identifier to find references to (e.g. 'GVL_Cameras', 'fbParser1')."),
      caseSensitive: z.boolean().optional().describe("If true (default), match case-sensitively per IEC 61131-3 conventions."),
      maxHits: z.number().int().positive().optional().describe("Cap on returned hits (default 1000)."),
    },
    async (args: {
      projectFilePath: string;
      symbol: string;
      caseSensitive?: boolean;
      maxHits?: number;
    }) => {
      // Word-boundary regex - escape any regex metacharacters that might
      // appear in the symbol (defensive: IEC identifiers can't contain them,
      // but a malformed input shouldn't blow up the search).
      const escaped = args.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = `\\b${escaped}\\b`;
      const escProj = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'search_code',
        {
          PROJECT_FILE_PATH: escProj,
          PATTERN: pattern,
          USE_REGEX: '1',
          CASE_SENSITIVE: (args.caseSensitive ?? true) ? '1' : '0',
          INCLUDE_DECL: '1',
          INCLUDE_IMPL: '1',
          MAX_HITS: String(args.maxHits ?? 1000),
        },
        ['_text_utils', 'ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      const parsed = parseResultJson<{
        hits: Array<{ path: string; section: string; line: number; col: number; text: string }>;
        count: number;
        truncated: boolean;
      }>(result.output);
      if (!parsed.ok) return formatToolResponse(result, '');
      const { hits, count, truncated } = parsed.data;
      if (count === 0) {
        return {
          content: [{ type: 'text' as const, text: `No references to '${args.symbol}' found.` }],
          isError: false,
        };
      }
      const lines = hits.map(h => `${h.path}:${h.line}:${h.col} (${h.section}) ${h.text.trim()}`);
      const header = `${count} reference(s) to '${args.symbol}'${truncated ? ' (truncated)' : ''}:`;
      return {
        content: [{ type: 'text' as const, text: `${header}\n${lines.join('\n')}` }],
        isError: false,
      };
    }
  );

  s.tool(
    'rename_symbol',
    'Best-effort word-boundary textual rename across textual POU/Method/Property/DUT/GVL bodies. Defaults to dryRun=true. Does not rename the project object node (use rename_object) or graphical bodies.',
    {
      projectFilePath: z.string().describe("Path to the project file."),
      oldName: z.string().min(1).describe("Existing symbol name."),
      newName: z.string().min(1).describe("Replacement name."),
      dryRun: z.boolean().optional().describe("If true (default), report matches without writing. Set false to apply."),
      includeDeclaration: z.boolean().optional().describe("If true (default), rewrite declaration sections."),
      includeImplementation: z.boolean().optional().describe("If true (default), rewrite implementation sections."),
    },
    async (args: {
      projectFilePath: string;
      oldName: string;
      newName: string;
      dryRun?: boolean;
      includeDeclaration?: boolean;
      includeImplementation?: boolean;
    }) => {
      const escProj = resolvePath(args.projectFilePath, workspaceDir);
      const dry = args.dryRun ?? true;
      const script = scriptManager.prepareScriptWithHelpers(
        'rename_symbol',
        {
          PROJECT_FILE_PATH: escProj,
          OLD_NAME: args.oldName,
          NEW_NAME: args.newName,
          DRY_RUN: dry ? '1' : '0',
          INCLUDE_DECL: (args.includeDeclaration ?? true) ? '1' : '0',
          INCLUDE_IMPL: (args.includeImplementation ?? true) ? '1' : '0',
        },
        ['_text_utils', 'ensure_project_open']
      );
      const result = await executor.executeScript(script, 120_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      const parsed = parseResultJson<{
        old_name: string;
        new_name: string;
        dry_run: boolean;
        changes: Array<{ path: string; section: string; match_count: number; applied: boolean }>;
        total_matches: number;
        applied_count: number;
      }>(result.output);
      if (!parsed.ok) return formatToolResponse(result, '');
      const { dry_run, total_matches, applied_count, changes } = parsed.data;
      if (total_matches === 0) {
        return {
          content: [{ type: 'text' as const, text: `No matches for '${args.oldName}'; nothing renamed.` }],
          isError: false,
        };
      }
      const summary = changes.map(c =>
        `${c.path} [${c.section}]: ${c.match_count} match(es)${dry_run ? '' : c.applied ? ' (applied)' : ' (NOT applied)'}`
      );
      const header = dry_run
        ? `DRY RUN: ${total_matches} match(es) of '${args.oldName}' -> '${args.newName}' across ${changes.length} section(s). Re-run with dryRun=false to apply.`
        : `Applied ${total_matches} replacement(s) of '${args.oldName}' -> '${args.newName}' across ${applied_count} section(s). Project saved.`;
      return {
        content: [{ type: 'text' as const, text: `${header}\n${summary.join('\n')}` }],
        isError: false,
      };
    }
  );

  s.tool(
    'monitor_variables',
    "Sample one or more PLC variables at a fixed interval over a bounded duration; returns the timeseries. Blocks the CODESYS UI thread (capped at 60s).",
    {
      projectFilePath: z.string().describe("Path to the project file."),
      variablePaths: z.array(z.string().min(1)).min(1).describe("List of variable paths to sample (e.g. ['PLC_PRG.x', 'GVL.nCounter'])."),
      durationMs: z.number().int().positive().describe("Total sampling duration in ms. Capped at 60000."),
      intervalMs: z.number().int().positive().describe("Sample interval in ms. Floor 10ms."),
    },
    async (args: {
      projectFilePath: string;
      variablePaths: string[];
      durationMs: number;
      intervalMs: number;
    }) => {
      // Clamp here so TS-side timeouts and the script-side cap stay consistent
      // (the script also clamps to 60000 defensively, but a caller asking for
      // 120000 deserves a fast fail-and-warn rather than silent truncation).
      const clampedDuration = Math.min(args.durationMs, 60_000);
      const clampedInterval = Math.max(args.intervalMs, 10);
      const escaped = resolvePath(args.projectFilePath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'monitor_variables',
        {
          PROJECT_FILE_PATH: escaped,
          VARIABLES_JSON: JSON.stringify(args.variablePaths),
          DURATION_MS: String(clampedDuration),
          INTERVAL_MS: String(clampedInterval),
        },
        ['_text_utils', 'ensure_project_open', 'ensure_online_connection']
      );
      // Per-call timeout = clamped duration + 30s headroom for connect/return.
      const callTimeoutMs = clampedDuration + 30_000;
      const result = await executor.executeScript(script, callTimeoutMs);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      const parsed = parseResultJson<{
        variables: string[];
        sample_count: number;
        duration_ms_requested: number;
        duration_ms_actual: number;
        interval_ms: number;
        application: string;
        samples: Array<{ t_ms: number; values: Record<string, string | null> }>;
      }>(result.output);
      if (!parsed.ok) return formatToolResponse(result, '');
      // Caller wants the full timeseries - return it as JSON in the message
      // body (not summarised) so plotting tools downstream can parse it.
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(parsed.data, null, 2),
        }],
        isError: false,
      };
    }
  );

  s.tool(
    'create_project_archive',
    'Saves the currently-open project as a .projectarchive. Read-only with respect to the project itself - the project must already be open (this tool will not switch projects). Output path may be absolute or relative to the workspace.',
    {
      projectFilePath: z.string().describe("Path to the project file (must be the currently-open project)."),
      outputPath: z.string().min(1).describe("Output .projectarchive path (absolute or workspace-relative)."),
      comment: z.string().optional().describe("Optional comment embedded in the archive metadata."),
      includeLibraries: z.boolean().optional().describe("If true (default), include referenced library sources in the archive."),
      includeCompiledLibraries: z.boolean().optional().describe("If true (default), include compiled library binaries. Set false to keep archives small for plain-text version control."),
    },
    async (args: {
      projectFilePath: string;
      outputPath: string;
      comment?: string;
      includeLibraries?: boolean;
      includeCompiledLibraries?: boolean;
    }) => {
      const escProj = resolvePath(args.projectFilePath, workspaceDir);
      const escOut = resolvePath(args.outputPath, workspaceDir);
      const script = scriptManager.prepareScriptWithHelpers(
        'create_project_archive',
        {
          PROJECT_FILE_PATH: escProj,
          ARCHIVE_PATH: escOut,
          COMMENT: args.comment ?? '',
          INCLUDE_LIBRARIES: (args.includeLibraries ?? true) ? '1' : '0',
          INCLUDE_COMPILED: (args.includeCompiledLibraries ?? true) ? '1' : '0',
        },
        ['_text_utils', 'require_project_open']
      );
      const result = await executor.executeScript(script, 120_000);
      const success = result.success && result.output.includes('SCRIPT_SUCCESS');
      if (!success) return formatToolResponse(result, '');
      const parsed = parseResultJson<{ archive_path: string; size_bytes: number; comment: string | null }>(result.output);
      const sizeKb = parsed.ok ? Math.round(parsed.data.size_bytes / 1024) : 0;
      return {
        content: [{
          type: 'text' as const,
          text: parsed.ok
            ? `Archive saved to ${parsed.data.archive_path} (${sizeKb} KB).${parsed.data.comment ? ` Comment: "${parsed.data.comment}".` : ''}`
            : `Archive saved (output details unavailable).`,
        }],
        isError: false,
      };
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
        ['_text_utils', 'ensure_project_open']
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
        // Resource handler - require_project_open refuses to switch projects.
        const script = scriptManager.prepareScriptWithHelpers(
          'get_project_structure', { PROJECT_FILE_PATH: escaped }, ['_text_utils', 'require_project_open']
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
        // Resource handler - require_project_open refuses to switch projects.
        const script = scriptManager.prepareScriptWithHelpers(
          'get_pou_code',
          { PROJECT_FILE_PATH: escProjPath, POU_FULL_PATH: sanPouPath },
          ['_text_utils', 'require_project_open', 'find_object_by_path']
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
  // Connect transport BEFORE auto-launching CODESYS so the MCP `initialize`
  // handshake answers immediately (Claude Code's probe times out fast).

  const transport = new StdioServerTransport();
  serverLog.info('Connecting MCP server via stdio...');
  await server.connect(transport);
  serverLog.info('MCP Server connected and listening.');

  // ─── Background auto-launch (do not await) ───────────────────────────

  if (launcher && config.autoLaunch) {
    const persistentLauncher = launcher;
    serverLog.info('Auto-launching CODESYS in the background...');
    // Hand the proxy a readiness promise so tool calls during the launch
    // window block on it before delegating - no race between swap and
    // mid-flight executeScript calls.
    const launchReady = persistentLauncher.launch().then(
      () => {
        executionMode = 'persistent';
        serverLog.info('CODESYS persistent instance ready; executor switched.');
      },
      (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        serverLog.error(`Persistent launch failed: ${errMsg}`);
        if (config.fallbackHeadless) {
          serverLog.warn('Continuing in headless mode (fallback).');
        } else {
          serverLog.error(
            'No fallback configured; tool calls will keep using headless executor.'
          );
        }
        // Re-throw so the proxy keeps the headless executor.
        throw err;
      }
    );
    executor.swap(persistentLauncher, launchReady);
  }

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
