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
        ALLOW_UNRESOLVED: '0',
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

  it('remove_library script renders without leftover placeholders and contains required markers', () => {
    const script = mgr.prepareScriptWithHelpers(
      'remove_library',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        LIBRARY_NAME: 'Standard',
        LIBRARY_FQN_OR_NAME: 'Standard, 3.5.17.0 (System)',
      },
      ['ensure_project_open']
    );
    // Placeholders must all be substituted
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
    // Substituted values must appear
    expect(script).toContain('LIBRARY_NAME = "Standard"');
    expect(script).toContain('LIBRARY_FQN_OR_NAME = "Standard, 3.5.17.0 (System)"');
    // Core SP22 API call
    expect(script).toContain('lm.remove_library' || 'remove_library');
    expect(script).toContain('remove_library');
    // references walk must be present (pre-check)
    expect(script).toContain('references');
    // Idempotent no-op marker
    expect(script).toContain('Library Not Present');
    // Success and error markers
    expect(script).toContain('SCRIPT_SUCCESS');
    expect(script).toContain('SCRIPT_ERROR');
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

  // ─── Symbol Configuration tools ──────────────────────────────────────
  // Each new tool: assert the rendered script substitutes every {PLACEHOLDER},
  // pulls in find_symbol_config_object helper, and emits SCRIPT_SUCCESS.

  const SYMCONF_HELPERS = ['ensure_project_open', 'find_symbol_config_object'];

  it('find_symbol_config script renders cleanly with helpers', () => {
    const script = mgr.prepareScriptWithHelpers(
      'find_symbol_config',
      { PROJECT_FILE_PATH: 'C:\\test.project' },
      SYMCONF_HELPERS
    );
    expect(script).toContain('def find_all_symbol_config_objects');
    expect(script).toContain('def symbol_config_path');
    expect(script).toContain('SYMBOL_CONFIG_FIND_START');
    expect(script).toContain('SCRIPT_SUCCESS');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('list_all_signatures honours COMPILE_FLAG=1 to force a build', () => {
    const script = mgr.prepareScriptWithHelpers(
      'list_all_signatures',
      { PROJECT_FILE_PATH: 'C:\\test.project', COMPILE_FLAG: '1' },
      SYMCONF_HELPERS
    );
    expect(script).toContain('COMPILE_FLAG = "1"');
    expect(script).toContain('get_all_signatures');
    expect(script).toContain('def ensure_symbol_config');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('list_all_datatypes honours COMPILE_FLAG=0 (cached)', () => {
    const script = mgr.prepareScriptWithHelpers(
      'list_all_datatypes',
      { PROJECT_FILE_PATH: 'C:\\test.project', COMPILE_FLAG: '0' },
      SYMCONF_HELPERS
    );
    expect(script).toContain('COMPILE_FLAG = "0"');
    expect(script).toContain('get_all_datatypes');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('list_configured_symbols renders both signature + datatype paths', () => {
    const script = mgr.prepareScriptWithHelpers(
      'list_configured_symbols',
      { PROJECT_FILE_PATH: 'C:\\test.project' },
      SYMCONF_HELPERS
    );
    expect(script).toContain('get_only_configured_signatures');
    expect(script).toContain('get_only_configured_datatypes');
    expect(script).toContain('configured_access');
    expect(script).toContain('maximal_access');
    expect(script).toContain('effective_access');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('get_symbol_config_settings reads every documented knob', () => {
    const script = mgr.prepareScriptWithHelpers(
      'get_symbol_config_settings',
      { PROJECT_FILE_PATH: 'C:\\test.project' },
      SYMCONF_HELPERS
    );
    expect(script).toContain('content_feature_flags');
    expect(script).toContain('symbol_attribute_filter_type');
    expect(script).toContain('symbol_comment_filter_type');
    expect(script).toContain('enable_direct_io_access');
    expect(script).toContain('client_side_layout_calculator');
    expect(script).toContain('check_effective_direct_io_access');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('create_symbol_config emits the application.create_symbol_config call + idempotency check', () => {
    const script = mgr.prepareScriptWithHelpers(
      'create_symbol_config',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        APPLICATION_PATH: 'Application',
        EXPORT_COMMENTS_TO_XML: '1',
        SUPPORT_OPC_UA: '1',
        LAYOUT_CALCULATOR: 'compatibility',
      },
      [...SYMCONF_HELPERS, 'find_object_by_path']
    );
    expect(script).toContain('application.create_symbol_config');
    expect(script).toContain('Symbol Configuration already exists');
    expect(script).toContain('def find_object_by_path_robust');
    expect(script).toContain('LAYOUT_CALCULATOR = "compatibility"');
    expect(script).toContain('APPLICATION_PATH = "Application"');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('set_symbol_config_settings only applies fields whose APPLY_* flag is 1', () => {
    const script = mgr.prepareScriptWithHelpers(
      'set_symbol_config_settings',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        APPLY_CONTENT_FLAGS: '1',
        CONTENT_FLAGS_INT: '7',
        APPLY_ATTR_FILTER_TYPE: '0',
        ATTR_FILTER_TYPE: 'None',
        APPLY_ATTR_FILTER_DATA: '0',
        ATTR_FILTER_DATA: '',
        APPLY_COMMENT_FILTER_TYPE: '0',
        COMMENT_FILTER_TYPE: 'None',
        APPLY_DIRECT_IO: '0',
        DIRECT_IO: '0',
        APPLY_LAYOUT: '0',
        LAYOUT_CALCULATOR: 'compatibility',
      },
      SYMCONF_HELPERS
    );
    expect(script).toContain('APPLY_CONTENT_FLAGS = "1" == \'1\'');
    expect(script).toContain('CONTENT_FLAGS_INT = "7"');
    expect(script).toContain('APPLY_ATTR_FILTER_TYPE = "0" == \'1\'');
    expect(script).toContain('Refusing to enable direct I/O access');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('set_symbol_access emits the configured_access setter and access enum probe', () => {
    const script = mgr.prepareScriptWithHelpers(
      'set_symbol_access',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        SIGNATURE_FQN: 'Application.PLC_PRG',
        VARIABLE_NAME: 'nCounter',
        ACCESS: 'ReadWrite',
        LIBRARY_ID: '',
        ENSURE_CONFIGURED: '1',
      },
      SYMCONF_HELPERS
    );
    expect(script).toContain('SIGNATURE_FQN = r"Application.PLC_PRG"');
    expect(script).toContain('VARIABLE_NAME = r"nCounter"');
    expect(script).toContain('ACCESS = "ReadWrite"');
    expect(script).toContain('configured_access = requested_access');
    expect(script).toContain('SymbolAccess');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('set_signature_access_bulk walks every variable in the signature', () => {
    const script = mgr.prepareScriptWithHelpers(
      'set_signature_access_bulk',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        SIGNATURE_FQN: 'Application.PLC_PRG',
        ACCESS: 'ReadOnly',
        LIBRARY_ID: '',
      },
      SYMCONF_HELPERS
    );
    expect(script).toContain('for v in sig.variables');
    expect(script).toContain('changed.append');
    expect(script).toContain('skipped.append');
    expect(script).toContain('ACCESS = "ReadOnly"');
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('export_symbol_xsd writes bytes and refuses on missing parent dir', () => {
    const script = mgr.prepareScriptWithHelpers(
      'export_symbol_xsd',
      {
        PROJECT_FILE_PATH: 'C:\\test.project',
        OUTPUT_FILE_PATH: 'C:\\out.xsd',
      },
      SYMCONF_HELPERS
    );
    expect(script).toContain('get_symbol_configuration_xsd');
    expect(script).toContain('Parent directory does not exist');
    expect(script).toContain('OUTPUT_FILE_PATH = r"C:\\out.xsd"');
    expect(script).toContain("open(OUTPUT_FILE_PATH, 'wb')");
    expect(script).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('every symbol config script template loads without error', () => {
    const scriptNames = [
      'find_symbol_config', 'list_all_signatures', 'list_all_datatypes',
      'list_configured_symbols', 'get_symbol_config_settings',
      'create_symbol_config', 'set_symbol_config_settings',
      'set_symbol_access', 'set_signature_access_bulk', 'export_symbol_xsd',
      'find_symbol_config_object',
    ];
    for (const name of scriptNames) {
      expect(() => mgr.loadTemplate(name)).not.toThrow();
      const content = mgr.loadTemplate(name);
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
