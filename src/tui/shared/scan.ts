import * as fs from 'fs/promises';
import * as path from 'path';
import { POU, POUKind, Device, Project } from './types.js';

const MIRROR_DIR = 'mcp-mirror';

export async function walk(rootDir: string): Promise<Project> {
  const mirrorDir = path.join(rootDir, MIRROR_DIR);
  let mirrorStat;
  try {
    mirrorStat = await fs.stat(mirrorDir);
  } catch {
    throw new Error(
      `No mcp-mirror/ found at ${rootDir}. Run mirror_export in CODESYS first.`
    );
  }

  const deviceNames = (await fs.readdir(mirrorDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const devices: Device[] = [];
  for (const name of deviceNames) {
    const pous = await collectPous(path.join(mirrorDir, name));
    devices.push({ name, pous });
  }

  return {
    rootDir,
    mirrorMtimeMs: mirrorStat.mtimeMs,
    devices,
  };
}

async function collectPous(deviceRoot: string): Promise<POU[]> {
  const stFiles = await listStFilesRecursive(deviceRoot);
  const stPathSet = new Set(stFiles.map((f) => f.toLowerCase()));
  const out: POU[] = [];

  for (const abs of stFiles) {
    const rel = path
      .relative(deviceRoot, abs)
      .split(path.sep)
      .join('/');
    const stat = await fs.stat(abs);
    const text = await fs.readFile(abs, 'utf8');
    const loc = text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    const name = path.basename(abs, '.st');
    const kind = classify(abs, name, stPathSet);

    out.push({
      name,
      kind,
      relPath: rel,
      absPath: abs,
      loc,
      mtimeMs: stat.mtimeMs,
    });
  }
  return out;
}

async function listStFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listStFilesRecursive(full)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.st')) {
      out.push(full);
    }
  }
  return out;
}

function classify(absPath: string, name: string, stPathSet: Set<string>): POUKind {
  if (name === 'PLC_PRG') return 'PRG';
  if (name === '_MCP_PROJECT_VERSION') return 'META';
  if (name === 'Get') return parentHasSiblingSt(absPath, stPathSet) ? 'PROPERTY_GETTER' : 'OTHER';
  if (name === 'Set') return parentHasSiblingSt(absPath, stPathSet) ? 'PROPERTY_SETTER' : 'OTHER';
  // Property declarator: same-named child dir contains Get.st/Set.st
  // (e.g. FB_Sweep/PropX.st alongside FB_Sweep/PropX/Get.st).
  if (hasGetOrSetChild(absPath, name, stPathSet)) return 'OTHER';
  if (/^FB_/.test(name)) return 'FB';
  if (/^GVL_/.test(name)) return 'GVL';
  if (/^ST_/.test(name)) return 'STRUCT';
  if (/^e[A-Z]/.test(name)) return 'ENUM';
  if (parentHasSiblingSt(absPath, stPathSet)) return 'METHOD';
  return 'OTHER';
}

function hasGetOrSetChild(absPath: string, name: string, stPathSet: Set<string>): boolean {
  const parentDir = path.dirname(absPath);
  const childDir = path.join(parentDir, name);
  const get = path.join(childDir, 'Get.st').toLowerCase();
  const set = path.join(childDir, 'Set.st').toLowerCase();
  return stPathSet.has(get) || stPathSet.has(set);
}

function parentHasSiblingSt(absPath: string, stPathSet: Set<string>): boolean {
  const parentDir = path.dirname(absPath);
  const grandparentDir = path.dirname(parentDir);
  const parentName = path.basename(parentDir);
  const sibling = path.join(grandparentDir, `${parentName}.st`).toLowerCase();
  return stPathSet.has(sibling);
}
