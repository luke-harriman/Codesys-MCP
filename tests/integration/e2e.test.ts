import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { ScriptManager } from '../../src/script-manager';

/**
 * Integration tests that verify the full script preparation pipeline.
 * These don't require CODESYS but verify the template system works end-to-end.
 */
describe('E2E Script Preparation', () => {
  const scriptsDir = path.join(__dirname, '..', '..', 'src', 'scripts');
  const mgr = new ScriptManager(scriptsDir);

  it('open_project script prepares correctly with helpers', () => {
    const script = mgr.prepareScriptWithHelpers(
      'open_project',
      { PROJECT_FILE_PATH: 'C:\\Projects\\Test.project' },
      ['ensure_project_open']
    );
    // Should contain ensure_project_open function
    expect(script).toContain('def ensure_project_open');
    // Should contain the actual open logic
    expect(script).toContain('Project Opened');
    // Path should appear as-is (no escaping) since templates use r"..." raw strings
    expect(script).toContain('C:\\Projects\\Test.project');
    // Should contain success marker
    expect(script).toContain('SCRIPT_SUCCESS');
  });

  it('create_pou script prepares with both helpers', () => {
    const script = mgr.prepareScriptWithHelpers(
      'create_pou',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        POU_NAME: 'MyProgram',
        POU_TYPE_STR: 'Program',
        IMPL_LANGUAGE_STR: 'ST',
        PARENT_PATH: 'Application',
      },
      ['ensure_project_open', 'find_object_by_path']
    );
    expect(script).toContain('def ensure_project_open');
    expect(script).toContain('def find_object_by_path_robust');
    expect(script).toContain('MyProgram');
    expect(script).toContain('POU_TYPE_STR = "Program"');
  });

  it('set_pou_code script handles pre-escaped code content', () => {
    // Simulate what server.ts does: manually escape code for triple-quoted strings
    const declCode = 'VAR\\n  x : INT;\\nEND_VAR';
    const implCode = 'x := 42;';
    const sanDecl = declCode.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
    const sanImpl = implCode.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');

    const script = mgr.prepareScriptWithHelpers(
      'set_pou_code',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        POU_FULL_PATH: 'Application/MyPOU',
        DECLARATION_CONTENT: sanDecl,
        IMPLEMENTATION_CONTENT: sanImpl,
        SET_DECLARATION: 'True',
        SET_IMPLEMENTATION: 'True',
      },
      ['ensure_project_open', 'find_object_by_path']
    );
    expect(script).toContain('Application/MyPOU');
    expect(script).toContain('x := 42;');
    expect(script).toContain('SET_DECLARATION = True');
    expect(script).toContain('SET_IMPLEMENTATION = True');
  });

  it('set_pou_code with omitted declarationCode gates the replace() call', () => {
    // Regression: when caller omits declarationCode, the script must NOT
    // call decl_obj.replace('') -- doing so wipes the POU's
    // PROGRAM/VAR...END_VAR block (binary becomes UNKNOWN POU).
    // server.ts passes SET_DECLARATION='False' in that case.
    const script = mgr.prepareScriptWithHelpers(
      'set_pou_code',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        POU_FULL_PATH: 'Application/PLC_PRG',
        DECLARATION_CONTENT: '',
        IMPLEMENTATION_CONTENT: 'x := 1;',
        SET_DECLARATION: 'False',
        SET_IMPLEMENTATION: 'True',
      },
      ['ensure_project_open', 'find_object_by_path']
    );
    expect(script).toContain('SET_DECLARATION = False');
    expect(script).toContain('SET_IMPLEMENTATION = True');
    // The skip branch must be reachable
    expect(script).toContain('SET_DECLARATION=False');
    // No leftover {PLACEHOLDER} unsubstituted
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('add_library script gates save() on resolution and backs out unresolved placeholders', () => {
    // Regression: add_library used to call lm.add_library(name) (the
    // placeholder overload) and then immediately project.save(), even when
    // the placeholder could not be resolved. The next open then threw
    // "The placeholder library 'X' could not be resolved." and bricked the
    // project. The fixed script must:
    //   - pre-resolve via the IDE-level library_manager.find_library(name)
    //     and prefer the ManagedLib overload of lm.add_library
    //   - after add, walk lm.references to locate the new entry and check
    //     that it resolved (managed -> always; placeholder -> non-empty
    //     effective_resolution)
    //   - if not resolved, call lm.remove_library(name) and refuse to save
    const script = mgr.prepareScriptWithHelpers(
      'add_library',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        LIBRARY_NAME: 'Util',
        USE_DIRECT: '0',
        FORCE_DUP: '0',
      },
      ['ensure_project_open']
    );
    expect(script).toContain('LIBRARY_NAME = "Util"');
    // Pre-resolve via the IDE-level library_manager
    expect(script).toContain('library_manager');
    expect(script).toContain('find_library');
    // Managed-overload preference (when USE_DIRECT=1 or add_placeholder unavailable)
    expect(script).toContain('add_library(resolved_lib)');
    // Default-to-placeholder branch added per Bug 4
    expect(script).toContain('add_placeholder');
    // Dedup pre-check added per Bug 4
    expect(script).toContain('FORCE_DUP');
    expect(script).toContain('Library Already Present');
    // Post-add resolution gate
    expect(script).toContain('effective_resolution');
    expect(script).toContain('is_placeholder');
    expect(script).toContain('_is_resolved');
    // Back-out path on failure
    expect(script).toContain('remove_library');
    // The actionable error string the user will see
    expect(script).toContain('not installed in the CODESYS library repository');
    // save() in the body of add_library proper must come AFTER the
    // resolution gate. (The ensure_project_open helper, prepended above,
    // also calls primary_project.save() once -- so use lastIndexOf to
    // pick up the add_library save call.)
    const saveIdx = script.lastIndexOf('primary_project.save()');
    const gateIdx = script.indexOf('_is_resolved(new_ref)');
    expect(gateIdx).toBeGreaterThan(0);
    expect(saveIdx).toBeGreaterThan(gateIdx);
    // No unsubstituted placeholders
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('check_status script has no placeholders after load', () => {
    const script = mgr.loadTemplate('check_status');
    // check_status has no {PLACEHOLDER} params
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
    expect(script).toContain('SCRIPT_SUCCESS');
  });

  it('compile_project script prepares with ensure_project_open', () => {
    const script = mgr.prepareScriptWithHelpers(
      'compile_project',
      { PROJECT_FILE_PATH: 'C:\\test.project' },
      ['ensure_project_open']
    );
    expect(script).toContain('def ensure_project_open');
    expect(script).toContain('build()');
  });

  it('rename_object script renders the references-update branch with UPDATE_REFERENCES=1', () => {
    // Bug 5: rename_object historically only updated the target's own
    // decl, not callers in other POUs. The fixed script must:
    //   - default to project-wide identifier rewrite via word-boundary regex
    //   - opt-out via UPDATE_REFERENCES=0
    //   - import re and walk text-bearing nodes
    const script = mgr.prepareScriptWithHelpers(
      'rename_object',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        OBJECT_PATH: 'Application/ST_Sample',
        NEW_NAME: 'ST_SampleRenamed',
        UPDATE_REFERENCES: '1',
      },
      ['ensure_project_open', 'find_object_by_path']
    );
    expect(script).toContain('def find_object_by_path_robust');
    expect(script).toContain('OBJECT_PATH = "Application/ST_Sample"');
    expect(script).toContain('NEW_NAME = "ST_SampleRenamed"');
    expect(script).toContain('UPDATE_REFERENCES = "1" == "1"');
    expect(script).toContain('import sys, scriptengine as script_engine, os, traceback, re');
    expect(script).toContain('re.escape(old_identifier)');
    expect(script).toContain('textual_declaration');
    expect(script).toContain('textual_implementation');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('rename_object script honours UPDATE_REFERENCES=0 opt-out', () => {
    const script = mgr.prepareScriptWithHelpers(
      'rename_object',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        OBJECT_PATH: 'Application/Foo',
        NEW_NAME: 'Bar',
        UPDATE_REFERENCES: '0',
      },
      ['ensure_project_open', 'find_object_by_path']
    );
    expect(script).toContain('UPDATE_REFERENCES = "0" == "1"');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('all scripts are loadable', () => {
    const scriptNames = [
      'check_status', 'compile_project', 'create_method', 'create_pou',
      'create_project', 'create_property', 'ensure_project_open',
      'find_object_by_path', 'get_pou_code', 'get_project_structure',
      'open_project', 'save_project', 'set_pou_code', 'watcher',
    ];
    for (const name of scriptNames) {
      expect(() => mgr.loadTemplate(name)).not.toThrow();
      const content = mgr.loadTemplate(name);
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
