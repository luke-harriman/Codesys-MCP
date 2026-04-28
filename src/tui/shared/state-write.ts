import * as fs from 'fs/promises';
import * as path from 'path';
import { Selection } from './types.js';

export async function writeSelection(
  filePath: string,
  projectDir: string,
  selection: Selection
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    project_dir: projectDir,
    device: selection.device,
    selection: {
      kind: selection.pou.kind,
      name: selection.pou.name,
      path: selection.pou.relPath,
      abs_path: selection.pou.absPath,
    },
    viewer_line: selection.viewerLine,
  };

  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}
