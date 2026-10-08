import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CrashEvent } from '../src/event.ts';
import { gradle, type Runner } from '../src/runner.ts';

export function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fixcrash-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A git repository on `master` with one commit holding `files`. */
export function initRepo(dir: string, files: Record<string, string>): string {
  sh(dir, 'git', 'init', '--quiet', '--initial-branch=master');
  sh(dir, 'git', 'config', 'user.email', 'test@example.com');
  sh(dir, 'git', 'config', 'user.name', 'Test');
  sh(dir, 'git', 'config', 'commit.gpgsign', 'false');
  return commit(dir, files, 'initial');
}

/** Writes `files`, commits everything, returns the new sha. */
export function commit(dir: string, files: Record<string, string>, message: string): string {
  writeFiles(dir, files);
  sh(dir, 'git', 'add', '-A');
  sh(dir, 'git', 'commit', '--quiet', '-m', message);
  return sh(dir, 'git', 'rev-parse', 'HEAD');
}

// A fake project for verify and reproduce: Gradle's file layout and reports,
// with fixtures/fake-runner.mjs in place of ./gradlew.
export const fakeRunner: Runner = {
  ...gradle,
  name: 'fake',
  targetCommand: (testId) => [process.execPath, 'fake-runner.mjs', 'target', testId],
  suiteCommand: () => [process.execPath, 'fake-runner.mjs', 'suite'],
  environment: () => undefined,
};

export const PARSER = 'app/src/main/java/com/example/Parser.kt';
export const TESTS = 'app/src/test/java/com/example';
export const TEST_ID = 'com.example.ParserTest.parsesWithoutAvatar';
export const EXPECTED = { exception: 'java.lang.NullPointerException', frame: 'com.example.Parser.parse' };

/** A project at the crashing version, on branch `fix`: Parser has the bug, an existing test passes. */
export function crashingProject(t: Parameters<typeof tempDir>[0]): { dir: string; base: string } {
  const dir = tempDir(t);
  copyFileSync(new URL('./fixtures/fake-runner.mjs', import.meta.url), join(dir, 'fake-runner.mjs'));
  const base = initRepo(dir, {
    '.gitignore': 'build/\nlocal.properties\n',
    [PARSER]: 'behaviour: bug\n',
    [`${TESTS}/ExistingTest.kt`]: 'test parsesFullProfile pass\n',
  });
  writeFileSync(join(dir, 'local.properties'), 'sdk.dir=/nowhere\n');
  sh(dir, 'git', 'switch', '--quiet', '-c', 'fix');
  return { dir, base };
}

/** A synthetic Crashlytics event for the fake project's crash. */
export function parserEvent(issueId = 'issue-1', overrides: Partial<CrashEvent> = {}): CrashEvent {
  return {
    name: `projects/1/apps/1:1:android:1/events/${issueId}_1`,
    issueId,
    issueTitle: 'com.example.Parser.parse',
    errorType: 'FATAL',
    version: { display: '1.0', build: '1' },
    blameFrame: { symbol: 'com.example.Parser.parse', file: 'Parser.kt', line: 3 },
    exceptions: [{ type: 'java.lang.NullPointerException', message: 'x', frames: [{ symbol: 'com.example.Parser.parse', file: 'Parser.kt', line: 3 }] }],
    ...overrides,
  };
}
