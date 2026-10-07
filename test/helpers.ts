import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
