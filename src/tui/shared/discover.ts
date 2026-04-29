import * as fs from 'fs/promises';
import * as path from 'path';

export async function findProjectRoot(startDir: string): Promise<string | null> {
  let cur = path.resolve(startDir);
  while (true) {
    try {
      const stat = await fs.stat(path.join(cur, 'mcp-mirror'));
      if (stat.isDirectory()) return cur;
    } catch {
      // not here, walk up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
