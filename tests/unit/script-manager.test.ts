import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { ScriptManager } from '../../src/script-manager';

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'src', 'scripts');

describe('ScriptManager', () => {
  const mgr = new ScriptManager(SCRIPTS_DIR);

  it('loads an existing template', () => {
    const content = mgr.loadTemplate('check_status');
    expect(content).toContain('scriptengine');
    expect(content).toContain('SCRIPT_SUCCESS');
  });

  it('throws for non-existent template', () => {
    expect(() => mgr.loadTemplate('nonexistent_script')).toThrow(/not found/);
  });

  it('interpolates a single param', () => {
    const result = mgr.interpolate('hello {FOO}', { FOO: 'bar' });
    expect(result).toBe('hello bar');
  });

  it('passes backslashes through unchanged (raw string templates)', () => {
    const result = mgr.interpolate('path = r"{PATH}"', {
      PATH: 'C:\\Users\\Test',
    });
    expect(result).toBe('path = r"C:\\Users\\Test"');
  });

  it('passes triple quotes through unchanged (callers handle escaping)', () => {
    const result = mgr.interpolate('code = """{CODE}"""', {
      CODE: 'a """ b',
    });
    expect(result).toBe('code = """a """ b"""');
  });

  it('interpolates multiple params', () => {
    const result = mgr.interpolate('{A} and {B}', { A: 'x', B: 'y' });
    expect(result).toBe('x and y');
  });

  it('two loads return identical content (no cache, fresh file read each call)', () => {
    const first = mgr.loadTemplate('check_status');
    const second = mgr.loadTemplate('check_status');
    expect(first).toEqual(second);
  });

  it('combineScripts concatenates with double newlines', () => {
    const result = mgr.combineScripts('script1', 'script2', 'script3');
    expect(result).toBe('script1\n\nscript2\n\nscript3');
  });

  it('prepareScript loads and interpolates', () => {
    // create_project has {PROJECT_FILE_PATH} and {TEMPLATE_PROJECT_PATH} placeholders
    const result = mgr.prepareScript('create_project', {
      PROJECT_FILE_PATH: 'C:\\Projects\\test.project',
      TEMPLATE_PROJECT_PATH: 'C:\\Templates\\Standard.project',
    });
    // Values should appear as-is (no escaping) since templates use r"..." raw strings
    expect(result).toContain('C:\\Projects\\test.project');
    expect(result).toContain('C:\\Templates\\Standard.project');
  });

  it('prepareScriptWithHelpers prepends helpers', () => {
    const result = mgr.prepareScriptWithHelpers(
      'open_project',
      { PROJECT_FILE_PATH: 'C:\\test.project' },
      ['ensure_project_open']
    );
    // ensure_project_open content should appear before open_project content
    const ensureIdx = result.indexOf('def ensure_project_open');
    const openIdx = result.indexOf('Project Opened');
    expect(ensureIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeGreaterThan(-1);
    expect(ensureIdx).toBeLessThan(openIdx);
  });

  it('Windows path with spaces passes through correctly', () => {
    const result = mgr.interpolate('path = r"{PATH}"', {
      PATH: 'C:\\Program Files\\CODESYS',
    });
    expect(result).toBe('path = r"C:\\Program Files\\CODESYS"');
  });
});
