import { diffLines } from 'diff';
import { Hunk } from './types.js';

export function computeHunks(oldText: string, newText: string): Hunk[] {
  // jsdiff treats trailing-newline presence as a token boundary, so a missing
  // EOF newline shows up as a spurious del+add pair on the last line. Normalize.
  const a = oldText.endsWith('\n') ? oldText : oldText + '\n';
  const b = newText.endsWith('\n') ? newText : newText + '\n';
  const parts = diffLines(a, b);
  const out: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const part of parts) {
    const lines = part.value.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (part.added) {
      for (const text of lines) {
        out.push({ kind: 'add', lineNo: newLine, text });
        newLine++;
      }
    } else if (part.removed) {
      for (const text of lines) {
        out.push({ kind: 'del', lineNo: oldLine, text });
        oldLine++;
      }
    } else {
      for (const text of lines) {
        out.push({ kind: 'ctx', lineNo: newLine, text });
        oldLine++;
        newLine++;
      }
    }
  }

  return out;
}
