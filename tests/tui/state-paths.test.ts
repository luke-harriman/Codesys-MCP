import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { stateFilePath } from '../../src/tui/shared/state-paths.ts';

const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
const ORIG_ENV = { ...process.env };

function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  process.env = { ...ORIG_ENV };
});

afterEach(() => {
  Object.defineProperty(process, 'platform', ORIG_PLATFORM);
  process.env = { ...ORIG_ENV };
});

describe('stateFilePath', () => {
  it('uses %LOCALAPPDATA%/codesys-mcp/tui-state.json on Windows', () => {
    setPlatform('win32');
    process.env.LOCALAPPDATA = 'C:\\\\Users\\\\u\\\\AppData\\\\Local';
    const p = stateFilePath();
    expect(p).toBe(
      path.join('C:\\\\Users\\\\u\\\\AppData\\\\Local', 'codesys-mcp', 'tui-state.json')
    );
  });

  it('uses $XDG_STATE_HOME/codesys-mcp/tui-state.json when set', () => {
    setPlatform('linux');
    process.env.XDG_STATE_HOME = '/tmp/xdg-state';
    const p = stateFilePath();
    expect(p).toBe('/tmp/xdg-state/codesys-mcp/tui-state.json');
  });

  it('falls back to ~/.local/state on Linux without XDG_STATE_HOME', () => {
    setPlatform('linux');
    delete process.env.XDG_STATE_HOME;
    process.env.HOME = '/home/u';
    const p = stateFilePath();
    expect(p).toBe('/home/u/.local/state/codesys-mcp/tui-state.json');
  });

  it('throws on Windows when LOCALAPPDATA is unset', () => {
    setPlatform('win32');
    delete process.env.LOCALAPPDATA;
    expect(() => stateFilePath()).toThrow(/LOCALAPPDATA/);
  });
});
