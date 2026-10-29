// Reads what a source file imports, for the tests that hold the import
// boundaries between the kit, the rules and the rest of the game.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface ImportStatement {
  /** What is imported from, as written: './clock', 'pixi.js'. */
  specifier: string;
  /** True for `import type ...` and `export type ...`, which leave no trace in the build. */
  typeOnly: boolean;
}

const STATIC_IMPORT = /^\s*(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every import and re-export in a piece of TypeScript source. */
export function listImports(source: string): ImportStatement[] {
  const found: ImportStatement[] = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    found.push({ specifier: match[3], typeOnly: match[2] !== undefined });
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    found.push({ specifier: match[1], typeOnly: false });
  }
  return found;
}

export function isTestFile(path: string): boolean {
  return path.endsWith('.test.ts');
}

/** Every TypeScript file under a directory, as absolute paths. */
export function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files.sort();
}

export interface FileImport extends ImportStatement {
  /** The importing file, as an absolute path. */
  file: string;
  /** Where a relative specifier points, as an absolute path; null for a package. */
  resolved: string | null;
}

/** Every import of every TypeScript file under a directory. */
export function importsUnder(directory: string): FileImport[] {
  return listSourceFiles(directory).flatMap((file) =>
    listImports(readFileSync(file, 'utf8')).map((statement) => ({
      ...statement,
      file,
      resolved: statement.specifier.startsWith('.') ? resolve(dirname(file), statement.specifier) : null,
    })),
  );
}

/**
 * Is `path` the directory itself or something inside it? Both are absolute paths from this
 * platform's `resolve`, so the separator is the platform's: a backslash on Windows, where a
 * hard-coded slash would call every file an outsider.
 */
export function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}
