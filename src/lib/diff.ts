/**
 * Tiny line-based diff: returns an array of {kind, text} where kind is
 * "equal" | "add" | "remove". Used for the AI edit diff preview.
 */
export type DiffOp =
  | { kind: "equal"; value: string }
  | { kind: "add"; value: string }
  | { kind: "remove"; value: string };

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // LCS dp
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  // Walk the LCS to produce the diff
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  const pushRun = (kind: DiffOp["kind"], value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.value += "\n" + value;
    else if (kind === "equal") out.push({ kind, value });
    else out.push({ kind, value });
  };
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      pushRun("equal", oldLines[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      pushRun("remove", oldLines[i]);
      i++;
    } else {
      pushRun("add", newLines[j]);
      j++;
    }
  }
  while (i < m) {
    pushRun("remove", oldLines[i]);
    i++;
  }
  while (j < n) {
    pushRun("add", newLines[j]);
    j++;
  }
  return out;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    const lines = op.value.split("\n").length;
    if (op.kind === "add") added += lines;
    else if (op.kind === "remove") removed += lines;
  }
  return { added, removed };
}
