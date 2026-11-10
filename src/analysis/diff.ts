// Unified-diff parsing: converts `patch` strings (GitHub PR file API) into
// structured DiffFile objects with PR-side line numbers for inline comments.
import type { DiffFile, DiffHunk, DiffLine, ChangeType } from './types.js';
import { languageOf } from './types.js';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse one unified diff patch (the `patch` field of a PR file entry).
 * Returns null when the patch is missing (binary or too large).
 */
export function parsePatch(patch: string | null | undefined): DiffHunk[] {
  if (!patch) return [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split('\n')) {
    const m = raw.match(HUNK_RE);
    if (m) {
      current = {
        header: raw,
        oldStart: parseInt(m[1], 10),
        newStart: parseInt(m[3], 10),
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current) continue; // preamble (diff --git / index / --- +++ lines)
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') {
      current.lines.push({ type: 'add', newLine, text });
      newLine++;
    } else if (marker === '-') {
      current.lines.push({ type: 'del', oldLine, text });
      oldLine++;
    } else if (marker === ' ' || raw === '') {
      current.lines.push({ type: 'ctx', oldLine, newLine, text });
      oldLine++;
      newLine++;
    } else if (marker === '\\') {
      // "\ No newline at end of file" — ignore
    }
  }
  return hunks;
}

export interface RawFileEntry {
  filename: string;
  previous_filename?: string;
  status: string; // added | modified | removed | renamed | changed...
  additions: number;
  deletions: number;
  patch?: string | null;
}

export function toChangeType(status: string): ChangeType {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

export function buildDiffFile(entry: RawFileEntry): DiffFile {
  const hunks = parsePatch(entry.patch);
  const addedLines: { line: number; text: string }[] = [];
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') addedLines.push({ line: l.newLine!, text: l.text });
    }
  }
  return {
    path: entry.filename,
    previousPath: entry.previous_filename,
    changeType: toChangeType(entry.status),
    additions: entry.additions ?? 0,
    deletions: entry.deletions ?? 0,
    isBinary: !entry.patch && (entry.additions ?? 0) === 0 && (entry.deletions ?? 0) === 0,
    language: languageOf(entry.filename),
    hunks,
    addedLines,
  };
}

export function buildDiffFiles(entries: RawFileEntry[]): DiffFile[] {
  return entries.map(buildDiffFile);
}

/** Full new-file content reconstruction from hunks (ctx + add lines), used for context. */
export function reconstructNewContent(file: DiffFile): string {
  const out: string[] = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type !== 'del') out.push(l.text);
    }
  }
  return out.join('\n');
}

/** Snapshot of the old file content (ctx + del lines). */
export function reconstructOldContent(file: DiffFile): string {
  const out: string[] = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type !== 'add') out.push(l.text);
    }
  }
  return out.join('\n');
}
