import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export class GitError extends Error {}

function run(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new GitError(`git ${args[0]}: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Runs git and returns trimmed stdout; throws on a non-zero exit. */
export function git(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (r.status !== 0) throw new GitError(`git ${args.join(' ')}: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout.trim();
}

/** Runs git and returns trimmed stdout, or undefined on a non-zero exit. */
export function tryGit(cwd: string, args: string[]): string | undefined {
  const r = run(cwd, args);
  return r.status === 0 ? r.stdout.trim() : undefined;
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

/** The current directory relative to the repository root, '' at the root. */
export function prefix(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-prefix']).replace(/\/$/, '');
}

/** The repository's shared git directory, the same for every worktree. */
export function commonDir(cwd: string): string {
  const dir = git(cwd, ['rev-parse', '--git-common-dir']);
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
}

/** Full sha of a commit, or a GitError naming the ref. */
export function resolveCommit(cwd: string, ref: string): string {
  const sha = tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!sha) throw new GitError(`not a commit in this repository: ${ref}`);
  return sha;
}

export function isAncestor(cwd: string, ancestor: string, commit: string): boolean {
  return run(cwd, ['merge-base', '--is-ancestor', ancestor, commit]).status === 0;
}

/** Tracked files with uncommitted changes, staged or not. */
export function dirtyFiles(cwd: string): string[] {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no'])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3));
}

export interface Change {
  status: string;
  path: string;
}

/** Files changed between two commits, renames split into delete and add. */
export function changedFiles(cwd: string, from: string, to: string): Change[] {
  const out = git(cwd, ['diff', '--name-status', '--no-renames', '-z', from, to]);
  const parts = out.split('\0').filter(Boolean);
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i]!, path: parts[i + 1]! });
  return changes;
}

/** Tracked files at the worktree's HEAD, relative to the repository root. */
export function trackedFiles(cwd: string): string[] {
  return git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean);
}

/** A file's content at a commit. */
export function showFile(cwd: string, commit: string, path: string): Buffer {
  const r = spawnSync('git', ['cat-file', 'blob', `${commit}:${path}`], { cwd, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new GitError(`git cat-file ${commit}:${path}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

/** The default branch: the remote's HEAD, else a local `main` or `master`. */
export function defaultBranch(cwd: string): string | undefined {
  const remote = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remote) {
    const local = remote.replace(/^origin\//, '');
    return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`]) ? local : remote;
  }
  for (const b of ['main', 'master']) {
    if (tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  }
  return undefined;
}

export function mergeBase(cwd: string, a: string, b: string): string {
  return git(cwd, ['merge-base', a, b]);
}

/**
 * Puts a detached worktree at `path` on `commit`, reusing it when it exists.
 * Untracked files are removed; ignored files (build outputs, copied local
 * config) are kept, so builds stay incremental.
 */
export function prepareWorktree(repo: string, path: string, commit: string): void {
  if (existsSync(join(path, '.git'))) {
    const ok =
      tryGit(path, ['checkout', '--quiet', '--force', '--detach', commit]) !== undefined &&
      tryGit(path, ['clean', '--quiet', '--force', '-d']) !== undefined;
    if (ok) return;
  }
  rmSync(path, { recursive: true, force: true });
  git(repo, ['worktree', 'prune']);
  git(repo, ['worktree', 'add', '--quiet', '--detach', path, commit]);
}
