/**
 * Reading a model-issued shell command well enough to stop punishing it for Windows.
 *
 * These are regressions for a measured problem, not hygiene. Across the 50 most recent
 * recorded sessions, 79 of 1,175 tool calls were stored as errors — and only 16 of those
 * were a build or test that genuinely failed. Nine were ripgrep reporting "no matches" or
 * being cut short by `Select-Object -First`, both of which exit 1 by design; five were
 * PowerShell handing ripgrep an unexpanded `*`; seven were git run in a folder with no
 * `.git`. The error count had stopped meaning "something went wrong".
 *
 * The dangerous failure mode for this file is the opposite of the one it fixes: a rule that
 * is too eager launders real failures into successes, or rewrites a command into one that
 * silently searches the wrong place. Every test below that asserts a *negative* is guarding
 * that edge, and matters more than the positives.
 */

import { describe, expect, it } from 'vitest';
import {
  execRecoveryHints,
  nonZeroExitIsBenign,
  normalizeShellCommand,
  statusDeterminingProgram,
  withExecNotes
} from '../src/main/exec-hints.js';

describe('which program decided the exit code', () => {
  it('reads through a pipeline of cmdlets to the program that generated the output', () => {
    // Cmdlets never touch $LASTEXITCODE, so ripgrep's own code is still the one reported.
    expect(statusDeterminingProgram('rg -n "foo" src | Select-Object -First 30')).toBe('rg');
    expect(statusDeterminingProgram('rg -n "foo" src | sort | measure')).toBe('rg');
  });

  it('reads to the last native program in a pipeline, not the first', () => {
    // Verified in PowerShell: `cmd /c exit 1 | cmd /c exit 0` leaves $LASTEXITCODE at 0, and
    // reversing the two leaves it at 1. The last native stage wins.
    expect(statusDeterminingProgram('rg -n foo src | git diff --exit-code')).toBe('git');
    expect(statusDeterminingProgram('cmd /c exit 1 | cmd /c exit 0')).toBe('cmd');
    expect(statusDeterminingProgram('rg -n foo src | C:\\tools\\rg.exe -n bar')).toBe('rg');
  });

  it('treats a stage it cannot classify as a program rather than as a cmdlet', () => {
    // The direction that withholds an exemption. Guessing "cmdlet" here would file whatever
    // that stage did under ripgrep's name.
    expect(statusDeterminingProgram('rg -n foo src | mystery_tool --strict')).toBe('mystery_tool');
  });

  it('takes the last statement of a chain', () => {
    expect(statusDeterminingProgram("$root='C:\\x'; Get-ChildItem $root; rg -n 'foo' $root")).toBe('rg');
  });

  it('ignores separators inside quotes and groups', () => {
    expect(statusDeterminingProgram(`rg -n 'a;b|c' src`)).toBe('rg');
    expect(statusDeterminingProgram('(Get-ChildItem; Get-Item) ; rg -n x')).toBe('rg');
  });

  it('strips a directory and an extension from the program name', () => {
    expect(statusDeterminingProgram('C:\\tools\\rg.exe -n foo src')).toBe('rg');
  });
});

describe('a non-zero exit that is a result rather than a failure', () => {
  it('treats ripgrep exit 1 with no output as "no matches"', () => {
    const output = 'Wall time: 0.0056 seconds\nProcess exited with code 1\nOutput:\n';
    expect(nonZeroExitIsBenign('rg -n "CallToolRequest" src', 1, output)).toBe(true);
  });

  it('treats ripgrep exit 1 after Select-Object truncated the pipe as success', () => {
    // The pipe closing early is why the code is non-zero; the matches did arrive.
    const output = 'Process exited with code 1\nOutput:\nclient.go:36: defaultMaxInFlightRequests = 20\n';
    expect(nonZeroExitIsBenign('rg -n "Max" $root | Select-Object -First 160', 1, output)).toBe(true);
  });

  it('still calls it an error when ripgrep printed an error of its own', () => {
    // The exact live failure: an unexpanded glob. Exit 1, but the call really did fail, and
    // exempting it would hide the very thing the glob rewrite exists to prevent.
    const output =
      'Process exited with code 1\nOutput:\nrg: C:\\Users\\x\\tunnel-client*: IO error for operation on ' +
      'C:\\Users\\x\\tunnel-client*: The filename, directory name, or volume label syntax is incorrect. (os error 123)\n';
    expect(nonZeroExitIsBenign('rg -n "Transport" C:\\Users\\x\\tunnel-client*', 1, output)).toBe(false);
  });

  it('never exempts a program that does not spend exit 1 on "no matches"', () => {
    const output = 'Process exited with code 1\nOutput:\n--- FAIL: TestThing\nFAIL\n';
    expect(nonZeroExitIsBenign('go test ./...', 1, output)).toBe(false);
    expect(nonZeroExitIsBenign('.\\gradlew.bat :app:test', 1, output)).toBe(false);
  });

  it('never answers a bracket class with the file that is literally named that', () => {
    // The matcher escapes `[` and `]`, so this pattern would have matched the one file whose
    // name really does contain the brackets — while the shell being stood in for means a
    // character class and would have matched a1.ts and a2.ts. Expanding it is not a smaller
    // answer, it is a different one, reported as success.
    const list = (): readonly string[] => ['a1.ts', 'a2.ts', 'a[12]-literal.ts'];
    const cmd = 'rg needle a[12]*.ts';
    expect(normalizeShellCommand(cmd, 'powershell', list).cmd).toBe(cmd);
    expect(normalizeShellCommand(cmd, 'powershell', list).notes).toEqual([]);
  });

  it('hides a leading dot from a pattern without one, and only then', () => {
    // The POSIX rule the caller was writing to: `*.ts` skips dotfiles, `.h*.ts` asks for them.
    const list = (): readonly string[] => ['.hidden.ts', 'plain.ts'];
    expect(normalizeShellCommand('rg -n x *.ts', 'powershell', list).cmd).toBe("rg -n x 'plain.ts'");
    expect(normalizeShellCommand('rg -n x .h*.ts', 'powershell', list).cmd).toBe("rg -n x '.hidden.ts'");
  });

  it('never rewrites a command whose option arity it cannot know', () => {
    // The corruption this guard exists for: `--engine` consumes `pcre2`, which makes `foo.*`
    // the *pattern*. Reading `--engine` as a switch instead made `pcre2` the pattern and
    // `foo.*` a path — and expanding that path asked ripgrep a different question than the
    // one that was typed, then reported success. Rewriting nothing is the only safe answer.
    const list = (): readonly string[] => ['foo.js', 'other.ts'];
    expect(normalizeShellCommand('rg --engine pcre2 foo.* src', 'powershell', list).cmd).toBe(
      'rg --engine pcre2 foo.* src'
    );
    // Every flag known, so the same line normalizes as before.
    expect(normalizeShellCommand('rg --engine=pcre2 x *.js', 'powershell', list).cmd).toBe(
      "rg --engine=pcre2 x 'foo.js'"
    );
    // An option ripgrep does not have at all, and `--`, which changes what follows it.
    expect(normalizeShellCommand('rg --not-a-real-flag x *.js', 'powershell', list).cmd).toBe(
      'rg --not-a-real-flag x *.js'
    );
    expect(normalizeShellCommand('rg -- x *.js', 'powershell', list).cmd).toBe('rg -- x *.js');
  });

  it('only reads through pipeline stages that cannot decide the exit status', () => {
    // Being a cmdlet is not enough. `Out-File` to a missing drive throws, exits the host with
    // 1, and prints nothing the output guard recognises; `Write-Error` and a script block
    // that calls `exit` do the same by other routes. Reading ripgrep's code through any of
    // them files a real failure as a search that found nothing.
    expect(statusDeterminingProgram("rg x src | Out-File -LiteralPath 'Z:\\missing\\x.txt'")).toBe('');
    expect(statusDeterminingProgram('rg x src | Set-Content -LiteralPath Z:\\missing\\x.txt')).toBe('');
    expect(statusDeterminingProgram('rg x src | ForEach-Object { exit 1 }')).toBe('');
    expect(statusDeterminingProgram('rg x src | Write-Error boom')).toBe('');
    expect(nonZeroExitIsBenign('rg x src | ForEach-Object { exit 1 }', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign("rg x src | Out-File -LiteralPath 'Z:\\missing\\x.txt'", 1, '')).toBe(false);
    // The shapes the recorded sessions actually use to trim output still read through.
    expect(statusDeterminingProgram('rg x src | Select-Object -First 5')).toBe('rg');
    expect(statusDeterminingProgram('rg x src | Out-Null')).toBe('rg');
    expect(statusDeterminingProgram('rg x src | sort | measure')).toBe('rg');
  });

  it('never exempts a conditional chain, because nothing says which branch ran', () => {
    // PowerShell 7 runs `&&` for real: this one exits 1 from cmd and never reaches ripgrep,
    // yet `rg foo` is still the last statement in the text. The 5.1 parser-error guard does
    // not help here, because on 7 there is no parser error to see — the chain simply ran.
    expect(statusDeterminingProgram('cmd /c exit 1 && rg foo')).toBe('');
    expect(nonZeroExitIsBenign('cmd /c exit 1 && rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('go build ./... || rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('rg foo && go build ./...', 1, '')).toBe(false);
    // A `;` chain is unconditional: every statement ran, so the last one is the answer.
    expect(statusDeterminingProgram('cmd /c exit 1; rg foo')).toBe('rg');
    expect(nonZeroExitIsBenign('cmd /c exit 1; rg foo', 1, '')).toBe(true);
  });

  it('never exempts a command the shell refused to parse', () => {
    // Verified in Windows PowerShell 5.1 on this machine: `&&` is rejected outright, nothing
    // runs, and the exit code is 1. This guard reads the shell's own diagnostic, so it holds
    // even for a chain whose text would otherwise have ended in a search that found nothing.
    const parserError = [
      'At line:1 char:17',
      '+ Write-Output hi && rg foo',
      '+                 ~~',
      "The token '&&' is not a valid statement separator in this version.",
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException'
    ].join('\n');
    expect(nonZeroExitIsBenign('Write-Output hi && rg foo', 1, parserError)).toBe(false);
    expect(nonZeroExitIsBenign('rg foo || Write-Output no', 1, parserError)).toBe(false);
  });

  it('never exempts a search the shell could not even find', () => {
    const notFound = [
      "rg : The term 'rg' is not recognized as the name of a cmdlet, function, script file, " +
        'or operable program.',
      '    + CategoryInfo          : ObjectNotFound: (rg:String) [], CommandNotFoundException'
    ].join('\n');
    expect(nonZeroExitIsBenign('rg -n foo src', 1, notFound)).toBe(false);
  });

  it('never exempts a real failure in a hyphenated program later in the pipeline', () => {
    // `docker-compose` has the shape of a cmdlet and is a native program. Reading it as one of
    // PowerShell's own would skip it, hand the exit code back to ripgrep, and launder its
    // failure into "no matches".
    const output = ['Process exited with code 1', 'Output:', 'error: no configuration file provided'].join(
      '\n'
    );
    expect(statusDeterminingProgram('rg -n foo src | docker-compose up')).toBe('docker-compose');
    expect(nonZeroExitIsBenign('rg -n foo src | docker-compose up', 1, output)).toBe(false);
    expect(statusDeterminingProgram('rg -n foo src | tunnel-client --strict')).toBe('tunnel-client');
  });

  it('never exempts a program whose name is built from an approved PowerShell verb', () => {
    // The near-miss fix for the line above was to require an approved verb before the hyphen,
    // which these three defeat: they are executables spelled exactly like cmdlets. Only an
    // exact cmdlet name can be trusted, so an unrecognised Verb-Noun has to count as native.
    const output = 'Process exited with code 1\nOutput:\n2 suites failed\n';
    expect(statusDeterminingProgram('rg x src | test-runner')).toBe('test-runner');
    expect(nonZeroExitIsBenign('rg x src | test-runner', 1, output)).toBe(false);
    expect(statusDeterminingProgram('rg x src | build-tool --ci')).toBe('build-tool');
    expect(statusDeterminingProgram('rg x src | get-version')).toBe('get-version');
  });

  it('still reads through the cmdlets it does know', () => {
    // The exemption has to survive, or the benign-exit rule stops firing on the real corpus:
    // these are the stage heads that actually follow a search in recorded sessions.
    expect(statusDeterminingProgram('rg x src | Select-Object -First 5')).toBe('rg');
    expect(nonZeroExitIsBenign('rg x src | Sort-Object | Measure-Object', 1, '')).toBe(true);
  });

  it('never exempts an exit code other than 1', () => {
    const clean = 'Process exited with code 2\nOutput:\n';
    // ripgrep reserves 2 for real errors, which is what makes exempting 1 safe at all.
    expect(nonZeroExitIsBenign('rg -n foo src', 2, clean)).toBe(false);
    expect(nonZeroExitIsBenign('rg -n foo src', 0, clean)).toBe(false);
    expect(nonZeroExitIsBenign('rg -n foo src', null, clean)).toBe(false);
  });

  it('does not exempt a search whose exit code came from a later program', () => {
    const output = 'Process exited with code 1\nOutput:\nfatal: not a git repository\n';
    expect(nonZeroExitIsBenign('rg -n foo src; git status', 1, output)).toBe(false);
  });

  it('does not exempt a native program downstream of the search in one pipeline', () => {
    // `git diff --exit-code` exits 1 to mean "there are differences", and it is the last
    // native stage, so that 1 is the one PowerShell reports. Reading the pipeline's
    // generator instead would have filed a real result under ripgrep's exemption.
    const output = 'Process exited with code 1\nOutput:\ndiff --git a/x b/x\n';
    expect(nonZeroExitIsBenign('rg -l foo | git diff --exit-code', 1, output)).toBe(false);
  });
});

describe('globs PowerShell will not expand for a native program', () => {
  /**
   * One directory, holding a file the glob matches, a file it does not, and a sub-directory
   * that itself contains a match. That sub-directory is the whole point: a `-g '*_test.go'`
   * filter is recursive and would have found `sub/nested_test.go` too, which the command as
   * written never asked for.
   */
  const cwd = () => ['other.go', 'sub', 'top_test.go', 'zz_test.go'];

  it('expands a bare filename glob into the entries the shell would have passed', () => {
    const result = normalizeShellCommand("rg -n 'TunnelListener' *_test.go", 'powershell', cwd);
    expect(result.cmd).toBe("rg -n 'TunnelListener' 'top_test.go' 'zz_test.go'");
    expect(result.notes.join(' ')).toMatch(/does not expand globs/i);
  });

  it('never widens the search to sub-directories the glob did not name', () => {
    // The regression that retired the previous rewrite. `-g` is a recursive filter, so
    // `rg pattern -g '*_test.go'` also matches `sub\nested_test.go` — extra results returned
    // confidently, with nothing downstream able to tell they were never asked for.
    const result = normalizeShellCommand("rg -n 'x' *_test.go", 'powershell', cwd);
    expect(result.cmd).not.toContain('-g');
    expect(result.cmd).not.toContain('sub');
    expect(result.cmd).toBe("rg -n 'x' 'top_test.go' 'zz_test.go'");
  });

  it('expands a bash brace group into the paths bash would have produced', () => {
    // Straight from the corpus: the model writes one path with alternatives, PowerShell has no
    // brace expansion, and ripgrep is handed a single directory name that does not exist.
    const result = normalizeShellCommand('rg -n "AppGraph" app/src/{main,test}/java', 'powershell', cwd);
    expect(result.cmd).toBe("rg -n \"AppGraph\" 'app/src/main/java' 'app/src/test/java'");
    expect(result.notes.join(' ')).toMatch(/no brace expansion/i);
  });

  it('expands braces without a directory listing, because the expansion is textual', () => {
    // Unlike a glob, a brace group needs nothing from the disk — and is not checked against it
    // either, so a path that is not there still earns ripgrep's own error rather than silence.
    const result = normalizeShellCommand('rg -n x src/{a,b}', 'powershell', null);
    expect(result.cmd).toBe("rg -n x 'src/a' 'src/b'");
  });

  it('never mistakes a script block for a brace group', () => {
    // The danger the narrow pattern exists for: `{ … }` is PowerShell's own syntax, and
    // rewriting one into a list of paths would destroy the command.
    for (const cmd of [
      'rg -n x . | Where-Object { $_ -match "a,b" }',
      'rg -n x . | ForEach-Object { $_.Trim(),$_.Length }',
      "rg -n 'a{2,3}' src"
    ]) {
      expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
      expect(normalizeShellCommand(cmd, 'powershell', cwd).notes).toEqual([]);
    }
  });

  it('leaves a brace group alone when it is quoted or holds no alternative', () => {
    // A quoted group was protected on purpose, and a comma is what separates a path from a
    // regex quantifier or a block — without one there is nothing to expand.
    for (const cmd of ["rg -n x 'src/{a,b}'", 'rg -n x src/{a}', 'rg -n x src/{$env:X,b}']) {
      expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    }
  });

  it('refuses a brace group whose alternatives would still need a glob stage', () => {
    // bash expands braces and *then* expands the wildcards in what came out. Only the first
    // half happens here, and what it produces is quoted so it reaches the program verbatim —
    // so expanding this one would hand ripgrep two quoted wildcards it cannot open, which is
    // a worse failure than the untouched group. Both alternatives are judged, not just the
    // one carrying the wildcard.
    for (const cmd of [
      'rg -n x {*.ts,*.js}',
      'rg -n x src/{main,test}/*.ts',
      'rg -n x {main,test/*}',
      'rg -n x {a,b?}',
      'rg -n x {[ab].ts,c.ts}'
    ]) {
      const result = normalizeShellCommand(cmd, 'powershell', cwd);
      expect(result.cmd).toBe(cmd);
      expect(result.notes).toEqual([]);
    }
  });

  it('does not read a wrapper script as the program whose exit code it trusts', () => {
    // `rg.cmd`, `rg.bat` and `rg.ps1` are local scripts that happen to be named after
    // ripgrep. Nothing about them promises exit 1 means "no matches", so the exemption that
    // rests on that promise cannot be given to them. Only the program itself earns it.
    for (const wrapper of ['.\\rg.ps1 foo', 'rg.cmd foo', 'rg.bat foo', 'C:\\tools\\rg.cmd foo']) {
      expect(nonZeroExitIsBenign(wrapper, 1, '')).toBe(false);
    }
    // The real program still does, spelled either way.
    expect(nonZeroExitIsBenign('rg foo', 1, '')).toBe(true);
    expect(nonZeroExitIsBenign('C:\\tools\\rg.exe foo', 1, '')).toBe(true);
    expect(statusDeterminingProgram('rg -n foo | rg.cmd bar')).toBe('rg.cmd');
  });

  it('expands braces after the first statement, where a glob would be left alone', () => {
    // The asymmetry is the point: the brace group means the same thing wherever it appears,
    // while the glob one statement later would be answered from the wrong directory.
    const mixed = "$ErrorActionPreference='Stop'; rg -n x app/{main,test}";
    const result = normalizeShellCommand(mixed, 'powershell', cwd);
    expect(result.cmd).toBe("$ErrorActionPreference='Stop'; rg -n x 'app/main' 'app/test'");
    expect(normalizeShellCommand("Set-Location sub; rg -n x *_test.go", 'powershell', cwd).cmd).toBe(
      'Set-Location sub; rg -n x *_test.go'
    );
  });

  it('leaves everything after the first statement alone', () => {
    // Expansion happens here, before anything runs; the shell would have expanded when it
    // reached the statement. Those are the same answer only while nothing ran in between.
    const moved = "Set-Location sub; rg -n 'x' *_test.go";
    expect(normalizeShellCommand(moved, 'powershell', cwd).cmd).toBe(moved);
    // And the files a preceding statement is about to create do not exist yet to be listed.
    const built = "npm run build; rg -n 'x' *_test.go";
    expect(normalizeShellCommand(built, 'powershell', cwd).cmd).toBe(built);
    expect(normalizeShellCommand(built, 'powershell', cwd).notes).toEqual([]);
  });

  it('expands inside the first statement even when it is a pipeline', () => {
    const result = normalizeShellCommand("rg -n 'x' *_test.go | Select-Object -First 5", 'powershell', cwd);
    expect(result.cmd).toBe("rg -n 'x' 'top_test.go' 'zz_test.go' | Select-Object -First 5");
  });

  it('knows the pattern slot is already filled by -e, --file or --files', () => {
    // Each of these used to leave the first bare token counted as the pattern, so the glob
    // after it was never reached at all.
    expect(normalizeShellCommand("rg -e 'foo' *_test.go", 'powershell', cwd).cmd).toBe(
      "rg -e 'foo' 'top_test.go' 'zz_test.go'"
    );
    expect(normalizeShellCommand('rg --regexp=foo *_test.go', 'powershell', cwd).cmd).toBe(
      "rg --regexp=foo 'top_test.go' 'zz_test.go'"
    );
    expect(normalizeShellCommand('rg --files *_test.go', 'powershell', cwd).cmd).toBe(
      "rg --files 'top_test.go' 'zz_test.go'"
    );
  });

  it('passes an unmatched glob through exactly as a shell would', () => {
    // A shell that matches nothing hands the program the pattern. Substituting nothing here
    // would instead turn a scoped search into a search of the entire tree.
    const cmd = "rg -n 'x' *.rs";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand(cmd, 'powershell', cwd).notes).toEqual([]);
  });

  it('gives up rather than build a command line nobody can read', () => {
    const many = () => Array.from({ length: 200 }, (_, i) => `file_${i}_test.go`);
    const cmd = "rg -n 'x' *_test.go";
    expect(normalizeShellCommand(cmd, 'powershell', many).cmd).toBe(cmd);
  });

  it('does nothing at all without a directory to expand against', () => {
    const cmd = "rg -n 'x' *_test.go";
    expect(normalizeShellCommand(cmd, 'powershell').cmd).toBe(cmd);
    const unreadable = () => {
      throw new Error('EPERM');
    };
    expect(normalizeShellCommand(cmd, 'powershell', unreadable).cmd).toBe(cmd);
  });

  it('leaves a glob that names a directory alone', () => {
    // Expanding it means listing a directory other than the one this call was given.
    const cmd = "rg -n 'benchmark' ..\\docs\\*.md";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    const withDrive = 'rg -n "Transport" C:\\Users\\x\\tunnel-client*';
    expect(normalizeShellCommand(withDrive, 'powershell', cwd).cmd).toBe(withDrive);
  });

  it('never mistakes the search pattern for a filename glob', () => {
    // `.*` and `foo?` are regex here. Expanding either would change what is searched for.
    const cmd = 'rg -n "json\\.Marshal|Write\\(.*" src';
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand('rg "colou?r" src', 'powershell', cwd).cmd).toBe('rg "colou?r" src');
  });

  it('leaves a glob that is already a flag value alone', () => {
    const cmd = "rg -n 'x' -g '*.md' src";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    const long = "rg -n 'x' --glob '*.md' src";
    expect(normalizeShellCommand(long, 'powershell', cwd).cmd).toBe(long);
  });

  it('leaves a glob the caller quoted on purpose alone', () => {
    // Quoting it is how a caller asks for the literal to reach ripgrep. Honour that.
    const cmd = "rg -n 'x' '*_test.go'";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
  });

  it('leaves a shell expansion alone', () => {
    const cmd = 'rg -n "x" "$env:USERPROFILE\\go\\pkg\\*"';
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
  });

  it('touches nothing that is not ripgrep', () => {
    const cmd = 'Get-ChildItem *.md | Select-Object Name';
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand('go test ./...', 'powershell', cwd).cmd).toBe('go test ./...');
  });

  it('leaves POSIX shells alone, where the shell already expanded the glob', () => {
    const cmd = "rg -n 'x' *_test.go";
    expect(normalizeShellCommand(cmd, 'bash', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand(cmd, 'zsh', cwd).notes).toEqual([]);
  });
});

describe('saying what to do next', () => {
  it('names the cause when git ran outside a repository', () => {
    const hints = execRecoveryHints('git status --short', 'fatal: not a git repository (or any of the parent directories): .git');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/not a git repository/i);
    expect(hints[0]).toMatch(/rev-parse --show-toplevel/);
  });

  it('explains an unexpanded glob rather than leaving the code to be guessed at', () => {
    const hints = execRecoveryHints('rg -n x C:\\a\\b*', 'rg: C:\\a\\b*: IO error … (os error 123)');
    expect(hints.join(' ')).toMatch(/PowerShell does not expand/);
  });

  it('hands over the guard form when PowerShell 5.1 refused && or ||', () => {
    const refusal = "The token '&&' is not a valid statement separator in this version.";
    const hints = execRecoveryHints('npm test && npm publish', refusal);
    expect(hints).toHaveLength(1);
    // The point of the hint is the conditional, so it has to carry the guard and say why `;`
    // is not the answer — a model told only "use ;" would publish after a failing test run.
    expect(hints[0]).toMatch(/if \(\$\?\) \{ B \}/);
    expect(hints[0]).toMatch(/if \(-not \$\?\) \{ B \}/);
    expect(hints[0]).toMatch(/not the same as `;`/);
    expect(execRecoveryHints('a || b', "The token '||' is not a valid statement separator in this version.")).toHaveLength(1);
  });

  it('stays silent on a shell where the operators work', () => {
    // PowerShell 7 runs `&&` without complaint, so there is no refusal text and no hint. The
    // hint keys off the shell's own error, never off the command containing the operator.
    expect(execRecoveryHints('npm test && npm publish', 'ok')).toHaveLength(0);
  });

  it('stays silent on a healthy result', () => {
    expect(execRecoveryHints('rg -n foo src', 'Process exited with code 0\nOutput:\nsrc/a.ts:1:foo')).toEqual([]);
  });

  it('appends notes without disturbing the parity-formatted body', () => {
    const body = 'Wall time: 0.1 seconds\nProcess exited with code 1\nOutput:\nx';
    expect(withExecNotes(body, [])).toBe(body);
    const noted = withExecNotes(body, ['do the thing']);
    expect(noted.startsWith(body)).toBe(true);
    expect(noted).toContain('Note: do the thing');
  });
});
