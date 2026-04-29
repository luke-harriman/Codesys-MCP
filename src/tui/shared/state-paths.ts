import * as os from 'os';
import * as path from 'path';

const APP_DIR = 'codesys-mcp';
const FILE_NAME = 'tui-state.json';

export function stateFilePath(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error('LOCALAPPDATA is not set; cannot resolve TUI state file path');
    }
    return path.win32.join(localAppData, APP_DIR, FILE_NAME);
  }
  const xdg = process.env.XDG_STATE_HOME;
  const home = process.env.HOME ?? os.homedir();
  const base = xdg ?? path.posix.join(home, '.local', 'state');
  return path.posix.join(base, APP_DIR, FILE_NAME);
}
