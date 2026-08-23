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
