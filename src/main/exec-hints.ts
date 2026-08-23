/**
 * Reading a model-issued shell command well enough to stop punishing it for Windows.
 *
 * Three separate jobs, kept together because all three need the same small amount of
 * understanding of one command line: which program actually determined the exit status.
 *
 *   1. `nonZeroExitIsBenign` — a search that found nothing is a *result*, not a failure.
 *      `rg` documents exit 1 as "no matches"; recording that as an errored tool call made
 *      roughly one in eight recorded exec calls a lie, and a session's error count stopped
 *      meaning anything. This does not soften real failures: a build that exits 1 is still
 *      an error, and so is a search that exits 1 *while printing its own error line*.
 *
 *   2. `normalizeShellCommand` — PowerShell does not expand `*` or `?` for native programs
 *      the way a POSIX shell does, so `rg pattern *_test.go` hands ripgrep the literal
 *      asterisk and it fails with `os error 123`. The missing step is done here instead: the
 *      glob is expanded against the working directory, exactly as the shell the caller was
 *      writing for would have done, rather than costing a round trip to rediscover the
 *      platform difference.
 *
 *      It is expansion and not translation on purpose. `-g '*_test.go'` looks like the same
 *      request and is not: an expanded operand names entries of *this* directory, while `-g`
 *      is a recursive filter that also matches `sub/nested_test.go`. Returning extra matches
 *      nobody asked for is the one outcome worse than the error, because nothing downstream
 *      can tell that it happened.
 *
 *      For the same reason a glob is only ever expanded in the *first* statement of a command
 *      line. It is expanded here, before anything runs, and the shell would have expanded it
 *      at the moment that statement was reached — the same answer only while nothing has run
 *      in between. `cd sub; rg foo *.ts` would be answered from the directory rg is not going
 *      to run in, and `npm run build; rg foo *.js` from before the files existed. A glob after
 *      the first statement is left alone and gets the hint.
 *
 *      The same function also expands bash brace groups, `src/{main,test}/x`, which PowerShell
 *      has no syntax for and hands to the program as one literal name. That rewrite is textual
 *      and asks the filesystem nothing, so it carries none of the debt above and applies to
 *      every statement. It is kept deliberately narrow, because `{ … }` is also PowerShell's
 *      script-block syntax and rewriting one of those would destroy the command.
 *
 *   3. `execRecoveryHints` — for the failures that cannot be rewritten safely, say what to
 *      do next in the same result rather than leaving the model to guess.
 *
 * Everything here is advisory. Nothing rejects a command, nothing changes what runs except
 * the one narrowly-scoped glob expansion in (2), and a command this file does not understand
 * is passed through untouched. When in doubt it must do nothing: a wrong rewrite is far
 * worse than a missed one.
 */

import type { ShellType } from './codex/shell.js';

/**
 * Programs whose exit code 1 means "found nothing", not "went wrong".
 *
 * All of these reserve a *different* code (usually 2) for real errors, which is what makes
 * the distinction safe to act on. Anything not on this list keeps the old behaviour.
 */
const NO_MATCH_MEANS_EXIT_1 = new Set(['rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'findstr']);

/** Search programs whose glob arguments PowerShell will not expand for them. */
const RIPGREP_NAMES = new Set(['rg', 'ripgrep']);

/**
 * ripgrep flags that consume the next argument.
 *
 * Needed so a glob that is already a flag's *value* is never mistaken for a path operand
 * and rewritten a second time — `-g *.md` must survive this file untouched.
 */
/**
 * ripgrep's own option table, derived from `rg --help` of the binary this app ships
 * (15.2.0) rather than from memory.
 *
 * Getting this wrong is not a failed call, it is a changed one. A flag that consumes the
 * next argument and is not listed here makes that argument look like the search pattern,
 * which makes the *pattern* look like a path — and a path is what this file expands. The
 * live example was `rg --engine pcre2 foo.* src`: with `--engine` unknown, `pcre2` was read
 * as the pattern and `foo.*` was expanded against the working directory, so ripgrep was
 * asked a different question than the one that was typed and answered it successfully.
 *
 * So both halves are listed, and anything in neither is unknown arity: the segment is then
 * left exactly as written. Rewriting nothing is always a safe answer; guessing is not.
 */
const RG_VALUE_FLAGS = new Set([
  '--after-context', '--before-context', '--color', '--colors', '--context',
  '--context-separator', '--dfa-size-limit', '--encoding', '--engine',
  '--field-context-separator', '--field-match-separator', '--file', '--generate', '--glob',
  '--hostname-bin', '--hyperlink-format', '--iglob', '--ignore-file', '--max-columns',
  '--max-count', '--max-depth', '--max-filesize', '--path-separator', '--pre', '--pre-glob',
  '--regex-size-limit', '--regexp', '--replace', '--sort', '--sortr', '--threads', '--type',
  '--type-add', '--type-clear', '--type-not', '-A', '-B', '-C', '-E', '-M', '-T', '-d', '-e',
  '-f', '-g', '-j', '-m', '-r', '-t'
]);

const RG_BOOLEAN_FLAGS = new Set([
  '--auto-hybrid-regex', '--binary', '--block-buffered', '--byte-offset', '--case-sensitive',
  '--column', '--count', '--count-matches', '--crlf', '--debug', '--files',
  '--files-with-matches', '--files-without-match', '--fixed-strings', '--follow',
  '--glob-case-insensitive', '--heading', '--help', '--hidden', '--ignore-case',
  '--ignore-file-case-insensitive', '--include-zero', '--invert-match', '--json',
  '--line-buffered', '--line-number', '--line-regexp', '--max-columns-preview', '--mmap',
  '--multiline', '--multiline-dotall', '--no-config', '--no-filename', '--no-ignore',
  '--no-ignore-dot', '--no-ignore-exclude', '--no-ignore-files', '--no-ignore-global',
  '--no-ignore-messages', '--no-ignore-parent', '--no-ignore-vcs', '--no-line-number',
  '--no-messages', '--no-pcre2-unicode', '--no-require-git', '--no-unicode', '--null',
  '--null-data', '--one-file-system', '--only-matching', '--passthru', '--pcre2',
  '--pcre2-version', '--pretty', '--quiet', '--search-zip', '--smart-case', '--sort-files',
  '--stats', '--stop-on-nonmatch', '--text', '--trace', '--trim', '--type-list',
  '--unrestricted', '--version', '--vimgrep', '--with-filename', '--word-regexp', '-.', '-0',
  '-F', '-H', '-I', '-L', '-N', '-P', '-S', '-U', '-V', '-a', '-b', '-c', '-h', '-i', '-l', '-n',
  '-o', '-p', '-q', '-s', '-u', '-v', '-w', '-x', '-z'
]);

/**
 * Flags that fill the search-pattern slot, so the next bare token is a path and not the
 * pattern.
 *
 * Without them `rg -e foo *.go` reads `*.go` as the pattern it has already been given and
 * leaves the glob to fail; `--files` takes no pattern at all and its first operand met the
 * same fate.
 */
const RG_PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file']);
const RG_NO_PATTERN_FLAGS = new Set(['--files', '--type-list']);

interface Token {
  /** Exactly as written, quotes included, so a command can be rebuilt without damage. */
  raw: string;
  /** Quotes stripped, for comparison. */
  value: string;
  quoted: boolean;
}

/**
 * Splits one command line into tokens, respecting single and double quotes.
 *
 * Not a shell parser and not trying to be. It has to be right about quoting only well
 * enough that a quoted argument containing a space or a semicolon is never split, because
 * a mis-split is what would turn a rewrite into a broken command.
 */
function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let raw = '';
  let value = '';
  let quoted = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (raw === '') return;
    tokens.push({ raw, value, quoted });
    raw = '';
    value = '';
    quoted = false;
  };

  for (const char of segment) {
    if (quote !== null) {
      raw += char;
      if (char === quote) quote = null;
      else value += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      raw += char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    raw += char;
    value += char;
  }
  flush();
  return tokens;
}

/** Index of every top-level occurrence of any separator in `seps`, ignoring quoted text. */
function splitTopLevel(command: string, seps: readonly string[]): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;

  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    // `$( … )`, `@( … )` and plain grouping all hide separators that are not statement
    // boundaries. Depth-tracking keeps `(a; b)` from being read as two statements.
    if (char === '(' || char === '{') depth++;
    else if (char === ')' || char === '}') depth = Math.max(0, depth - 1);

    if (depth === 0) {
      const hit = seps.find((sep) => command.startsWith(sep, i));
      if (hit !== undefined) {
        parts.push(current);
        current = '';
        i += hit.length - 1;
        continue;
      }
    }
    current += char;
  }
  parts.push(current);
  return parts.filter((part) => part.trim() !== '');
}

/**
 * The bare program name of a token, lowercased and stripped of its path and `.exe`.
 *
 * `.exe` and nothing else. Everything this name is used to decide is a claim about a
 * *program's* contract — ripgrep spending exit 1 on "no matches" — and `rg.cmd`, `rg.bat`
 * or `rg.ps1` is a local script that merely happens to be named after it. A wrapper is free
 * to exit 1 for its own reasons, and calling that ripgrep's no-match answer would launder
 * exactly the failure this file exists to stop laundering. So an extension that is not
 * `.exe` stays part of the name, which no set of known programs contains.
 */
function programName(token: Token | undefined): string {
  if (!token) return '';
  const tail = token.value.split(/[\\/]/).pop() ?? '';
  return tail.toLowerCase().replace(/\.exe$/, '');
}

/**
 * PowerShell aliases that are cmdlets despite not being spelled Verb-Noun.
 *
 * Only needed to tell "this stage leaves $LASTEXITCODE alone" from "this stage sets it".
 * Anything not recognised here is assumed to be a program, which is the safe assumption:
 * it can only ever cost an exemption, never grant one.
 */
const CMDLET_ALIASES = new Set([
  'select', 'where', 'foreach', 'sort', 'measure', 'group', 'tee', 'ft', 'fl', 'fw', 'gc',
  'gci', 'gi', 'ls', 'dir', 'cat', 'echo', 'write', 'sls', 'ogv', '%', '?'
]);

/**
 * Cmdlets recognised by name, because nothing about a token's *shape* can prove one.
 *
 * `Verb-Noun` was the obvious test and it is not sound in either half. `docker-compose` and
 * `tunnel-client` have the shape and are programs; narrowing to PowerShell's approved verb
 * list does not save it either, because `test-runner`, `build-tool` and `get-version` are
 * equally plausible executables built from approved verbs. Since the shape cannot decide,
 * only an exact name may, and everything unrecognised is treated as native.
 *
 * That is the safe direction, and the asymmetry is the whole point: a real cmdlet missing
 * from this list costs one benign-exit exemption, while a program mistaken for a cmdlet is
 * skipped, hands the exit code back to the generator, and lets a generator on the no-match
 * list launder that program's genuine failure into "the search found nothing".
 *
 * The list covers the object-processing cmdlets that actually appear as pipeline stages —
 * every hyphenated stage head in the recorded corpus is here — plus the common neighbours.
 */
const KNOWN_CMDLETS = new Set([
  'add-content', 'add-member', 'clear-content', 'compare-object', 'convertfrom-csv',
  'convertfrom-json', 'convertfrom-stringdata', 'convertto-csv', 'convertto-html',
  'convertto-json', 'copy-item', 'export-clixml', 'export-csv', 'format-custom',
  'format-list', 'format-table', 'format-wide', 'get-childitem', 'get-command',
  'get-content', 'get-date', 'get-filehash', 'get-item', 'get-itemproperty',
  'get-location', 'get-member', 'get-process', 'get-random', 'get-unique', 'group-object',
  'import-csv', 'join-path', 'measure-object', 'move-item', 'new-item', 'new-object',
  'out-file', 'out-gridview', 'out-host', 'out-null', 'out-string', 'remove-item',
  'rename-item', 'resolve-path', 'select-object', 'select-string', 'select-xml',
  'set-content', 'set-location', 'sort-object', 'split-path', 'tee-object', 'test-path',
  'where-object', 'write-error', 'write-host', 'write-output', 'write-warning',
  'foreach-object'
]);

/** Whether a pipeline stage is PowerShell's own, and so cannot have set the exit code. */
function looksLikeCmdlet(token: Token | undefined): boolean {
  if (!token) return false;
  // A path or an executable extension names a program, whatever the rest of it looks like.
  if (/[\\/]/.test(token.value)) return false;
  if (/\.(exe|cmd|bat|com|ps1)$/i.test(token.value)) return false;
  const name = token.value.toLowerCase();
  return CMDLET_ALIASES.has(name) || KNOWN_CMDLETS.has(name);
}

/**
 * Downstream pipeline stages that cannot decide what the shell exits with.
 *
 * Being a cmdlet is not enough, which is what this replaced. `Out-File -LiteralPath
 * 'Z:\missing\x.txt'` is a known cmdlet, carries no script block, throws
 * DriveNotFoundException and exits the host with status 1 — and no diagnostic the output
 * guard knows appears. Skipping it and reading the exit code off ripgrep upstream would file
 * that as a search that found nothing. `Write-Error` and `ForEach-Object { exit 1 }` do the
 * same thing by other routes.
 *
 * So nothing is skipped on the strength of its name. These are the exact shapes the recorded
 * sessions actually use to trim ripgrep's output, each argument-free or fixed enough to have
 * nothing left to fail at. Anything else — a cmdlet with arguments, an expression, a block —
 * is status-ambiguous, and an ambiguous stage means no exemption for the line.
 */
const PASSIVE_STAGES = [
  /^(?:select-object|select)\s+-(?:first|last)\s+\d+$/i,
  /^(?:sort-object|sort)$/i,
  /^(?:measure-object|measure)$/i,
  /^out-null$/i
];

function stageIsPassive(segment: string): boolean {
  return PASSIVE_STAGES.some((shape) => shape.test(segment));
}

/**
 * The program whose exit status the shell will report.
 *
 * PowerShell sets `$LASTEXITCODE` from the last *native* program it ran — the last one in
 * the pipeline, not the first. `cmd /c exit 1 | cmd /c exit 0` leaves 0 behind; reversed, it
 * leaves 1. Cmdlets do not touch it at all, which is why `rg … | Select-Object -First 80`
 * still reports ripgrep's own code even though ripgrep is not the last stage.
 *
 * So: last statement, then the rightmost stage that is a program rather than a cmdlet, and
 * the generator only when every stage after it was PowerShell's own. Reading the generator
 * unconditionally is what would let `rg foo | git diff --exit-code` be filed as an `rg`
 * result — and `rg` is on the list of programs allowed to exit 1 harmlessly, so git failing
 * would have been recorded as a search that found nothing.
 *
 * A stage this cannot classify counts as a program. That direction only ever withholds an
 * exemption, and a real failure recorded as a failure is the outcome to fail towards.
 */
export function statusDeterminingProgram(command: string): string {
  // A conditional chain decides at run time which of its branches ran, and nothing in the
  // text of it says which one did. `cmd /c exit 1 && rg foo` never reaches ripgrep at all —
  // PowerShell 7 runs the operator, sees the failure and stops — and yet the last statement
  // is still `rg foo`. Reading it would file that exit 1 as a search that found nothing.
  //
  // There is no program this can name honestly, so it names none, and the exemption that
  // depends on the name is withheld. Windows PowerShell 5.1 refuses such a line outright and
  // the output guard catches that; this is the shell where the operators actually work.
  if (splitTopLevel(command, ['&&', '||']).length > 1) return '';
  const statements = splitTopLevel(command, [';', '\n']);
  const last = statements[statements.length - 1];
  if (last === undefined) return '';
  const segments = splitTopLevel(last, ['|']);
  for (let i = segments.length - 1; i > 0; i--) {
    const segment = (segments[i] as string).trim();
    if (stageIsPassive(segment)) continue;
    const first = tokenize(segment)[0];
    // A program here set $LASTEXITCODE and is the answer; a cmdlet here could have decided
    // the status without touching it, and cannot be proven not to have.
    return looksLikeCmdlet(first) ? '' : programName(first);
  }
  const generator = segments[0];
  if (generator === undefined) return '';
  return programName(tokenize(generator)[0]);
}

/**
 * Diagnostics that mean the shell itself refused the command line.
 *
 * None of these can coexist with "the search ran and found nothing", so any of them is
 * enough to withhold the benign-exit exemption. Matching one of these on output that was
 * genuinely a search result would only cost an exemption, which is the direction this file
 * is allowed to be wrong in.
 */
const SHELL_REFUSED = new RegExp(
  [
    String.raw`^\s*At line:\d+ char:\d+`,
    String.raw`The token '[^']*' is not a valid statement separator`,
    String.raw`ParserError`,
    String.raw`CommandNotFoundException`,
    String.raw`ParameterBindingException`,
    String.raw`is not recognized as (?:the name of )?a (?:cmdlet|command)`,
    String.raw`is not recognized as an internal or external command`,
    String.raw`The string (?:is missing the terminator|starting:)`,
    String.raw`Missing (?:argument|expression|closing|\))`
  ].join('|'),
  'im'
);

/**
 * Whether a non-zero exit is a reported result rather than a failure.
 *
 * Both conditions matter. The program must be one that spends exit 1 on "no matches", and
 * it must not have printed an error of its own — ripgrep given an unexpandable glob prints
 * `rg: …: IO error …` and still exits 1, and that call really did fail. Checking the output
 * is what keeps this from laundering the very failures fix (2) exists to surface.
 */
export function nonZeroExitIsBenign(command: string, exitCode: number | null, outputText: string): boolean {
  if (exitCode !== 1) return false;
  // A shell that refused the command never reached the search at all, so reading the exit
  // code as the search's answer is a fabrication. `Write-Output hi && rg foo` is the case
  // that matters: Windows PowerShell 5.1 rejects `&&` outright, exits 1 without running a
  // thing, and this function would otherwise call it ripgrep finding no matches.
  if (SHELL_REFUSED.test(outputText)) return false;
  const program = statusDeterminingProgram(command);
  if (!NO_MATCH_MEANS_EXIT_1.has(program)) return false;
  return !/^\s*(rg|ripgrep|grep|egrep|fgrep|findstr):/im.test(outputText);
}

export interface NormalizedCommand {
  cmd: string;
  /** Human-readable description of every rewrite, for the model and the log. */
  notes: string[];
}

/**
 * Whether a token is a glob this file is willing to expand.
 *
 * A path separator disqualifies it: expanding `..\docs\*.md` means listing a directory other
 * than the one this call was given, and guessing at which is not worth the round trip it
 * saves. Those keep failing loudly and get a hint instead. A quoted glob was deliberately
 * protected from the shell and is left exactly as protected.
 */
function isExpandableGlob(token: Token): boolean {
  if (token.quoted) return false;
  if (!/[*?]/.test(token.value)) return false;
  if (/[\/]/.test(token.value)) return false;
  if (token.value.startsWith('-')) return false;
  // A bracket class is pathname expansion this does not implement — the matcher below escapes
  // `[` and `]` into literals, so `a[12]*.ts` would match a file actually *named* with those
  // brackets while the shell would have matched `a1.ts` and `a2.ts`. Answering a different
  // question and reporting success is worse than not answering, so it is not answered.
  if (/[[\]]/.test(token.value)) return false;
  // `$env:X` and other expansions are the shell's business, not ours.
  return !token.value.includes('$');
}

/** Re-quotes an expanded name for the shell, so it reaches the program verbatim. */
function quoteArgument(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * One brace group of plain alternatives, e.g. `src/{main,test}/x`.
 *
 * Deliberately one group and nothing clever inside it. A brace group is also PowerShell's
 * script-block syntax, so the pattern has to be narrow enough that `Where-Object { $_ -eq 1 }`
 * can never match it: no whitespace (the tokenizer already split on that), no `$`, no nested
 * braces, no quotes, and a comma is required — a lone `{...}` is far more likely to be a
 * block than a path. Anything outside that shape is left exactly as written.
 */
const BRACE_ALTERNATIVES = /^([^{}$'"`|;]*)\{([^{}$'"`|;,]*(?:,[^{}$'"`|;,]*)+)\}([^{}$'"`|;]*)$/;

/**
 * The paths a bash-style brace group stands for, in the order bash would produce them.
 *
 * Purely textual, exactly as the shell it stands in for: the names are not checked against
 * the disk, because bash does not check either and a caller who typed a path that is not
 * there is owed ripgrep's own "no such file" rather than a silently shortened list.
 *
 * Which is also why a group holding a wildcard is refused outright. bash expands braces and
 * *then* expands the wildcards in what came out; this does only the first half, and quotes
 * what it produces so it reaches the program verbatim. Half of a two-stage expansion is not
 * a smaller fix, it is a worse failure: `{*.ts,*.js}` would become two quoted wildcards that
 * ripgrep cannot open, where the untouched group at least fails as the shell's own.
 */
function expandBraces(token: Token): string[] | null {
  if (token.quoted) return null;
  if (token.value.startsWith('-')) return null;
  const match = BRACE_ALTERNATIVES.exec(token.value);
  if (!match) return null;
  const [, prefix = '', body = '', suffix = ''] = match;
  const parts = body.split(',');
  if (parts.length < 2 || parts.length > MAX_EXPANDED_NAMES) return null;
  const names = parts.map((part) => `${prefix}${part}${suffix}`);
  // The second stage is not ours to run, so a group that would still need it is not ours to
  // touch. Both halves of the group are judged, not just the one that happens to carry the
  // wildcard: expanding `{main,test/*}` partly would be the same trap. A bracket class is
  // pathname expansion too — `{[ab].ts,c.ts}` needs the same second stage as a `*` does.
  if (names.some((name) => /[*?[]/.test(name))) return null;
  return names;
}

/**
 * The most names one glob may turn into.
 *
 * A command line has a length limit and a wall of filenames is unreadable in a log. Past
 * this, failing with the hint beats a line nobody can check.
 */
const MAX_EXPANDED_NAMES = 48;

/** Lists the working directory's entry names, so a glob can be expanded against them. */
export type DirectoryLister = () => readonly string[];

/**
 * The entries of the working directory this glob names, in the order a shell would give them.
 *
 * Only the current directory, because that is the only scope a separator-free glob can mean —
 * and the whole reason this is expansion rather than a `-g` filter. Leading dots are excluded
 * unless the pattern itself begins with one, which is the POSIX rule the caller was writing to.
 *
 * An empty result is not an expansion. A shell that matches nothing passes the pattern
 * through untouched, and so does this: the command then fails exactly as it would have, and
 * the hint explains it. Substituting nothing would instead silently search the whole tree.
 */
function expandGlob(pattern: string, list: DirectoryLister): string[] | null {
  let entries: readonly string[];
  try {
    entries = list();
  } catch {
    return null;
  }
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^\\\\/]*')
    .replace(/\?/g, '[^\\\\/]');
  // Case-insensitively, which is how Windows matches filenames and therefore how the shell
  // being stood in for would have matched them.
  const matcher = new RegExp(`^${source}$`, 'i');
  // POSIX hides a leading dot from a pattern that does not have one, and only then. A
  // pattern written with the dot is asking for those files by name.
  const hidden = pattern.startsWith('.');
  const hits = entries
    .filter((entry) => (hidden || !entry.startsWith('.')) && matcher.test(entry))
    .sort();
  if (hits.length === 0 || hits.length > MAX_EXPANDED_NAMES) return null;
  return hits;
}

/**
 * `allowGlob` is false for every statement after the first. A glob has to be expanded against
 * the directory the shell would have used, and one statement later that is a guess about what
 * the statements before it did. Brace expansion carries no such debt — it is pure text, cwd
 * and filesystem play no part — so it stays on for the whole command line.
 */
function normalizeRipgrepSegment(
  segment: string,
  list: DirectoryLister,
  allowGlob: boolean
): { segment: string; notes: string[] } {
  const tokens = tokenize(segment);
  if (!RIPGREP_NAMES.has(programName(tokens[0]))) return { segment, notes: [] };

  const notes: string[] = [];
  const out: string[] = [tokens[0]?.raw ?? ''];
  let seenPattern = false;
  let skipValue = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (skipValue) {
      skipValue = false;
      out.push(token.raw);
      continue;
    }
    if (token.value.startsWith('-')) {
      const flag = token.value.split('=')[0] as string;
      // An option this table does not know may or may not swallow the next argument, and
      // the two readings disagree about which token is the pattern and which is a path.
      // Neither reading is safe to act on, so nothing in this segment is rewritten. `--`
      // and a bare `-` land here too, and mean their own things; the same answer serves.
      if (!RG_VALUE_FLAGS.has(flag) && !RG_BOOLEAN_FLAGS.has(flag)) return { segment, notes: [] };
      // `--glob=*.md` carries its value inline and consumes nothing after it.
      if (RG_VALUE_FLAGS.has(token.value) && !token.value.includes('=')) skipValue = true;
      if (RG_PATTERN_FLAGS.has(flag) || RG_NO_PATTERN_FLAGS.has(flag)) seenPattern = true;
      out.push(token.raw);
      continue;
    }
    if (!seenPattern) {
      // The search pattern itself. `*` is a regex quantifier here, never a filename glob.
      seenPattern = true;
      out.push(token.raw);
      continue;
    }
    const braced = expandBraces(token);
    if (braced) {
      out.push(...braced.map(quoteArgument));
      notes.push(
        `PowerShell has no brace expansion, so \`${token.value}\` reached ripgrep as one literal name. ` +
          `It was expanded here to the ${braced.length} paths bash would have produced: ${braced.join(', ')}.`
      );
      continue;
    }
    const expanded = allowGlob && isExpandableGlob(token) ? expandGlob(token.value, list) : null;
    if (expanded) {
      out.push(...expanded.map(quoteArgument));
      notes.push(
        `PowerShell does not expand globs for native programs, so \`${token.value}\` was expanded here to ` +
          `${expanded.length === 1 ? 'the one entry' : `the ${expanded.length} entries`} of the working ` +
          `directory matching it: ${expanded.join(', ')}. Sub-directories were not searched, exactly as ` +
          `the glob asked; use \`-g '${token.value}'\` if a recursive match was what you meant.`
      );
      continue;
    }
    out.push(token.raw);
  }

  return { segment: out.join(' '), notes };
}

/**
 * Rewrites what can be rewritten losslessly, and leaves everything else exactly as written.
 *
 * Scoped to PowerShell because that is where the gap is: a POSIX shell already expanded the
 * glob before the program ever saw it, so touching a bash command here could only do harm.
 */
export function normalizeShellCommand(
  cmd: string,
  shellType: ShellType,
  list: DirectoryLister | null = null
): NormalizedCommand {
  if (shellType !== 'powershell') return { cmd, notes: [] };
  if (!/[*?{]/.test(cmd)) return { cmd, notes: [] };
  // Without a directory there is nothing to expand a glob against, and guessing is not
  // available here: the point of the exercise is that the answer must be the shell's own.
  // Brace expansion needs no directory — it is textual — so it still runs, against a listing
  // that reports the one honest thing it can, which is that it knows of no entries.
  const entries: DirectoryLister = list ?? ((): readonly string[] => []);

  const notes: string[] = [];
  let changed = false;
  let statementIndex = 0;

  // Statements and pipeline segments are rebuilt with their own separators intact, so only
  // the segments this file actually rewrote differ from the original text.
  const rebuilt = rebuild(cmd, [';', '&&', '||', '\n'], (statement) => {
    // Globs are expanded in the first statement only. Nothing has run yet at that point, so
    // the directory listed here is the directory the shell would have expanded against; one
    // statement later it is a guess about what the statements before it did to the cwd and to
    // the files in it. Brace groups are not asking the filesystem anything and run throughout.
    const first = statementIndex++ === 0;
    return rebuild(statement, ['|'], (segment) => {
      const result = normalizeRipgrepSegment(segment.trim(), entries, first);
      if (result.notes.length === 0) return segment;
      changed = true;
      notes.push(...result.notes);
      // Keep the caller's surrounding whitespace so the rebuilt line still reads naturally.
      const [, lead = '', , trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment) ?? [];
      return `${lead}${result.segment}${trail}`;
    });
  });

  return changed ? { cmd: rebuilt, notes: [...new Set(notes)] } : { cmd, notes: [] };
}

/** Splits on `seps`, maps each part, and joins it back with the separators it was cut on. */
function rebuild(text: string, seps: readonly string[], map: (part: string) => string): string {
  const pieces: string[] = [];
  const separators: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '{') depth++;
    else if (char === ')' || char === '}') depth = Math.max(0, depth - 1);

    if (depth === 0) {
      const hit = seps.find((sep) => text.startsWith(sep, i));
      if (hit !== undefined) {
        pieces.push(current);
        separators.push(hit);
        current = '';
        i += hit.length - 1;
        continue;
      }
    }
    current += char;
  }
  pieces.push(current);

  return pieces.map(map).reduce((acc, part, index) => acc + (index === 0 ? '' : separators[index - 1]) + part, '');
}

/**
 * What to try next, for failures whose cause is unambiguous in the output.
 *
 * Only patterns that name one specific, actionable cause belong here. A hint that fires on
 * a guess is worse than silence: it sends the model somewhere confidently wrong.
 */
export function execRecoveryHints(command: string, outputText: string): string[] {
  const hints: string[] = [];

  if (/fatal: not a git repository/i.test(outputText)) {
    hints.push(
      'That folder is not a git repository, so no git command that needs one will work there. ' +
        'Check with `git rev-parse --show-toplevel`, or set workdir to the folder that actually contains .git. ' +
        'The server instructions list which approved roots are repositories.'
    );
  }

  if (/os error 123/i.test(outputText) || /IO error for operation on .*[*?]/i.test(outputText)) {
    hints.push(
      'PowerShell does not expand `*` or `?` for native programs, so the pattern reached the program literally. ' +
        'For ripgrep pass the filename pattern as `-g \'<glob>\'`; otherwise expand it first, e.g. ' +
        '`Get-ChildItem -Path \'<glob>\' | ForEach-Object FullName`.'
    );
  }

  // Deliberately a hint and not a rewrite. `A && B` runs B only if A succeeded, and the
  // nearest thing PowerShell 5.1 has is a guard, not `;` — turning one into the other would
  // run the gated half of `gradlew test && gradlew publish` after the tests had failed. The
  // faithful translation is mechanical enough to hand over, and cheap enough to let the model
  // make. This fires on the shell's own refusal, so it can never misfire on PowerShell 7,
  // where the operators work and no such error exists.
  if (/The token '(&&|\|\|)' is not a valid statement separator/i.test(outputText)) {
    hints.push(
      'Windows PowerShell 5.1 has no `&&` or `||`, so it refused the whole line and ran nothing. ' +
        'These are not the same as `;`, which would run the second command even when the first failed: ' +
        'write `A; if ($?) { B }` for `A && B`, and `A; if (-not $?) { B }` for `A || B`. ' +
        'Chain longer runs by nesting inside the block rather than repeating the guard.'
    );
  }

  if (/JAVA_HOME is not set/i.test(outputText)) {
    hints.push(
      'No Java could be found automatically. Point JAVA_HOME at a JDK for this command, e.g. ' +
        "`$env:JAVA_HOME='C:\\Program Files\\Android\\Android Studio\\jbr'; $env:Path=\"$env:JAVA_HOME\\bin;$env:Path\"`."
    );
  }

  if (/cannot find GOROOT/i.test(outputText)) {
    hints.push(
      'The go binary was found but GOROOT was not set and could not be inferred. Set GOROOT to the ' +
        'toolchain directory that contains that go.exe before invoking it.'
    );
  }

  return hints;
}

/** Appends advisory notes to an exec result without disturbing the parity-formatted body. */
export function withExecNotes(responseText: string, notes: readonly string[]): string {
  if (notes.length === 0) return responseText;
  return `${responseText}\n\n${notes.map((note) => `Note: ${note}`).join('\n')}`;
}
