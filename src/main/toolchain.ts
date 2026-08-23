/**
 * Finding the JDK and Go toolchain a Windows box has but never put on the path.
 *
 * `JAVA_HOME is not set and no 'java' command could be found in your PATH` was the single
 * most repeated recoverable failure in the recorded sessions, and it is not an inheritance
 * bug: the variable genuinely does not exist on a machine where Android Studio is the only
 * JDK, because Studio sets it for its own shells and nowhere else. The model recovered
 * every time by prefixing `$env:JAVA_HOME=…` — which means the information was available
 * all along and the round trip bought nothing.
 *
 * The rules that keep this safe:
 *
 *   - **Fill, never override.** An environment that already names JAVA_HOME or GOROOT is
 *     the user's decision and is left exactly as found.
 *   - **Only when the tool is otherwise unreachable.** If `java` already resolves on PATH,
 *     nothing here fires, so a project relying on a path-selected JDK cannot be redirected.
 *   - **Only what is verified on disk.** A candidate counts only when the actual executable
 *     is present, so this can never point a build at a directory that is not a toolchain.
 *
 * Discovery is memoised for the life of the process: these directories do not appear or
 * move while the app is running, and this runs on every single exec_command.
 */

import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { envValue, pathEntries, prependPath, setEnvValue, type MutableEnvironment } from './env.js';

/** Filesystem questions this module asks, injectable so the tests need no real JDK. */
export interface ToolchainProbe {
  isFile(target: string): boolean;
  /** Immediate subdirectories of `target`, or `[]` when it does not exist. */
  directories(target: string): string[];
}

export const realProbe: ToolchainProbe = {
  isFile(target) {
    try {
      return existsSync(target) && statSync(target).isFile();
    } catch {
      return false;
    }
  },
  directories(target) {
    try {
      return readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(target, entry.name));
    } catch {
      return [];
    }
  }
};

/** Where a JDK lives on Windows when nobody exported JAVA_HOME. */
function javaCandidates(env: MutableEnvironment): string[] {
  const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files';
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
  const localAppData = envValue(env, 'LOCALAPPDATA') ?? '';

  // Exact directories first, in the order a developer would expect to win. Android Studio's
  // bundled runtime leads because on an Android machine it is the JDK every Gradle build is
  // already using; choosing anything else here would change what builds compile against.
  const exact = [
    path.join(programFiles, 'Android', 'Android Studio', 'jbr'),
    path.join(programFiles, 'Android', 'Android Studio', 'jre'),
    localAppData ? path.join(localAppData, 'Programs', 'Android Studio', 'jbr') : '',
    path.join(programFilesX86, 'Android', 'Android Studio', 'jbr')
  ].filter(Boolean);

  // Then the versioned install roots, whose child directories carry the version number.
  const scanned = [
    path.join(programFiles, 'Eclipse Adoptium'),
    path.join(programFiles, 'Java'),
    path.join(programFiles, 'Microsoft'),
    path.join(programFiles, 'Amazon Corretto'),
    path.join(programFiles, 'Zulu'),
    path.join(programFiles, 'JetBrains', 'Toolbox', 'apps')
  ];

  return [...exact, ...scanned];
}

/** Where the Go toolchain lives when nobody exported GOROOT. */
function goCandidates(env: MutableEnvironment): string[] {
  const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files';
  const localAppData = envValue(env, 'LOCALAPPDATA') ?? '';
  return [
    path.join(programFiles, 'Go'),
    localAppData ? path.join(localAppData, 'Programs', 'Go') : '',
    'C:\\Go'
  ].filter(Boolean);
}

/**
 * The first candidate that really holds `bin/<executable>`.
 *
 * A scanned root is descended one level, highest version first.
 */
function firstToolchain(candidates: readonly string[], executable: string, probe: ToolchainProbe): string | null {
  for (const candidate of candidates) {
    if (probe.isFile(path.join(candidate, 'bin', executable))) return candidate;
    for (const child of probe.directories(candidate).sort(byVersionDescending)) {
      if (probe.isFile(path.join(child, 'bin', executable))) return child;
    }
  }
  return null;
}

/**
 * Orders `jdk-21` above `jdk-9`, which a lexical sort does not.
 *
 * Version numbers are not text: compared as text, `9` beats `21` on the first character and
 * an installation holding both would have been handed Java 9 — a JDK old enough that current
 * Gradle refuses to run on it at all, silently, in place of the one that works. So the digit
 * runs in a name are compared as numbers and everything between them as text, which also
 * settles `jdk-21.0.5` against `jdk-21.0.12` correctly.
 *
 * Ties fall back to plain text so the order is total and the choice is reproducible. This
 * still only ever *ranks* directories that were going to be tried anyway; a name carrying no
 * version at all — `jbr`, `current` — sorts by text alone and remains reachable.
 */
function byVersionDescending(left: string, right: string): number {
  const chunks = (name: string): string[] => path.basename(name).toLowerCase().match(/\d+|\D+/g) ?? [];
  const a = chunks(left);
  const b = chunks(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const numeric = /^\d/.test(x) && /^\d/.test(y);
    const order = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return -order;
  }
  return left < right ? 1 : left > right ? -1 : 0;
}

/** Whether the environment can already run `executable` without any help from us. */
function onPath(env: MutableEnvironment, executable: string, probe: ToolchainProbe): boolean {
  return pathEntries(env).some((entry) => probe.isFile(path.join(entry, executable)));
}

interface Discovery {
  javaHome: string | null;
  goRoot: string | null;
}

let cached: Discovery | null = null;

/** Forgets memoised discovery. Tests only; the real filesystem does not change under us. */
export function resetToolchainCache(): void {
  cached = null;
}

function discover(env: MutableEnvironment, probe: ToolchainProbe): Discovery {
  if (cached !== null) return cached;
  cached = {
    javaHome: firstToolchain(javaCandidates(env), 'java.exe', probe),
    goRoot: firstToolchain(goCandidates(env), 'go.exe', probe)
  };
  return cached;
}

/**
 * Adds JAVA_HOME / GOROOT to a child environment when — and only when — the tool would
 * otherwise be unreachable. Returns what it added, for the log.
 */
export function ensureDevToolchain(env: MutableEnvironment, probe: ToolchainProbe = realProbe): string[] {
  if (process.platform !== 'win32') return [];
  const added: string[] = [];

  const needsJava = envValue(env, 'JAVA_HOME') === undefined && !onPath(env, 'java.exe', probe);
  const needsGo = envValue(env, 'GOROOT') === undefined && !onPath(env, 'go.exe', probe);
  if (!needsJava && !needsGo) return added;

  const found = discover(env, probe);

  if (needsJava && found.javaHome !== null) {
    setEnvValue(env, 'JAVA_HOME', found.javaHome);
    prependPath(env, path.join(found.javaHome, 'bin'));
    added.push(`JAVA_HOME=${found.javaHome}`);
  }
  if (needsGo && found.goRoot !== null) {
    setEnvValue(env, 'GOROOT', found.goRoot);
    prependPath(env, path.join(found.goRoot, 'bin'));
    added.push(`GOROOT=${found.goRoot}`);
  }

  return added;
}

/**
 * Whether `dir` is inside a git work tree.
 *
 * Used to tell the model which approved roots are repositories *before* it spends a call
 * finding out — `fatal: not a git repository` was one of the most repeated recoverable
 * failures, and it is pure prevention: the answer is one `stat` the model cannot make.
 *
 * Synchronous because its only caller builds the server instructions string, which is
 * assembled once per connection over a handful of roots.
 */
export function isGitRepository(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    // A worktree or submodule carries `.git` as a file rather than a directory, so the
    // question is only whether the entry exists at all.
    if (existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
