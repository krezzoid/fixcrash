// `fixcrash commit-for-version`: the commit a crashing build was made from.
// First choice: the revision in the event's build stamp (Android release
// builds whose Gradle root is the git root). Fallback: a release tag.

import { GitError, resolveCommit, tryGit } from './git.ts';

export const DEFAULT_TAG_PATTERNS = ['v{display}', '{display}'];

export interface VersionCommit {
  commit: string;
  source: string;
}

export class VersionError extends Error {}

/** Tag names for a version: `{display}` and `{build}` are replaced. */
export function tagCandidates(patterns: string[], display: string, build: string): string[] {
  const names = patterns.map((p) => p.replaceAll('{display}', display).replaceAll('{build}', build));
  return [...new Set(names)];
}

export function commitForVersion(
  cwd: string,
  display: string,
  build: string,
  opts: { revision?: string; tagPatterns?: string[] } = {},
): VersionCommit {
  if (opts.revision !== undefined) {
    if (!/^[0-9a-f]{7,40}$/i.test(opts.revision)) {
      throw new VersionError(`not a commit sha: ${opts.revision}`);
    }
    try {
      return { commit: resolveCommit(cwd, opts.revision), source: 'build stamp' };
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      throw new VersionError(
        `commit ${opts.revision} from the build stamp is not in this repository: fetch it (git fetch origin ${opts.revision}) and try again`,
      );
    }
  }
  const tags = tagCandidates(opts.tagPatterns ?? DEFAULT_TAG_PATTERNS, display, build);
  for (const tag of tags) {
    const commit = tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
    if (commit) return { commit, source: `tag ${tag}` };
  }
  throw new VersionError(
    `no commit for version ${display} (${build}): the event has no build stamp, and none of these tags exist: ${tags.join(', ')}. ` +
      'Set the release tag pattern, or pass --revision with the commit the build was made from',
  );
}
