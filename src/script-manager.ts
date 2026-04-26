/**
 * Python script template loading and interpolation.
 * Loads .py templates from src/scripts/ (or dist/scripts/) and performs
 * {PARAM} replacement. No caching: a tool call is ~1.5 s of CODESYS time,
 * so the few-ms cost of re-reading a small .py file each call is invisible
 * AND it means edits to dist/scripts/ are picked up live without an MCP
 * restart. This makes iterating on script-side fixes much faster
 * (relevant for the SP21+ scripting-engine drift bugs we hit on this fork).
 */

import * as fs from 'fs';
import * as path from 'path';
import { ScriptParams } from './types';

export class ScriptManager {
  private scriptsDir: string;

  constructor(scriptsDir?: string) {
    this.scriptsDir = scriptsDir ?? path.join(__dirname, 'scripts');
  }

  /** Synchronously read a template file. Re-reads on every call -- no cache. */
  loadTemplate(name: string): string {
    const fileName = name.endsWith('.py') ? name : `${name}.py`;
    const filePath = path.join(this.scriptsDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Script template not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * Replace {KEY} placeholders with values.
   * No automatic escaping — callers are responsible for escaping values
   * appropriate to their Python context (raw strings, triple-quoted strings, etc.).
   */
  interpolate(template: string, params: ScriptParams): string {
    let result = template;
    for (const [key, value] of Object.entries(params)) {
      const pattern = new RegExp(`\\{${key}\\}`, 'g');
      result = result.replace(pattern, String(value));
    }
    return result;
  }

  /** Concatenate multiple script fragments with double newlines */
  combineScripts(...scripts: string[]): string {
    return scripts.join('\n\n');
  }

  /** Load a template and interpolate parameters */
  prepareScript(name: string, params: ScriptParams): string {
    const template = this.loadTemplate(name);
    return this.interpolate(template, params);
  }

  /** Prepend helper scripts before the main script, then interpolate all */
  prepareScriptWithHelpers(
    name: string,
    params: ScriptParams,
    helpers: string[]
  ): string {
    const helperContents = helpers.map((h) => this.loadTemplate(h));
    const mainTemplate = this.loadTemplate(name);
    const combined = this.combineScripts(...helperContents, mainTemplate);
    return this.interpolate(combined, params);
  }
}
