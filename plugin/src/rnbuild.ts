// Steps of a React Native run in fixcrash's worktree, run with the app's
// directory as the working directory:
//
//   node rnbuild.ts deps                    node_modules for this commit's lockfile (ADR-0005)
//   node rnbuild.ts bundle <platform> <out>  the release bundle, its Hermes bytecode and the
//                                           composed source map, as release builds make them (ADR-0004)
//
// Output goes to the run's log. Exit codes: 0 done, 2 cannot, else the failed command's.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCKFILE = 'package-lock.json';
const STAMP = join('node_modules', '.fixcrash-lockfile');

function run(argv: string[]): void {
  console.log(`$ ${argv.join(' ')}`);
  const r = spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit' });
  if (r.error) {
    console.log(`cannot run ${argv[0]}: ${r.error.message}`);
    process.exit(2);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** ADR-0005: `npm ci --offline` when node_modules wasn't installed from this lockfile. */
export function deps(): void {
  if (!existsSync(LOCKFILE)) {
    const other = ['yarn.lock', 'pnpm-lock.yaml'].find((f) => existsSync(f));
    console.log(other ? `${other}: fixcrash installs node_modules with only npm for now` : `no ${LOCKFILE}: fixcrash needs it to install node_modules`);
    process.exit(2);
  }
  const hash = createHash('sha256').update(readFileSync(LOCKFILE)).digest('hex');
  if (existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === hash) {
    console.log(`node_modules matches ${LOCKFILE}`);
    return;
  }
  run(['npm', 'ci', '--offline', '--no-audit', '--no-fund']);
  writeFileSync(STAMP, `${hash}\n`);
}

const HERMESC_DIR: Record<string, string> = { darwin: 'osx-bin', linux: 'linux64-bin', win32: 'win64-bin' };

function hermesc(): string {
  const dir = HERMESC_DIR[process.platform];
  const exe = process.platform === 'win32' ? 'hermesc.exe' : 'hermesc';
  const found = dir && [
    join('node_modules', 'hermes-compiler', 'hermesc', dir, exe),
    join('node_modules', 'react-native', 'sdks', 'hermesc', dir, exe),
  ].find((p) => existsSync(p));
  if (!found) {
    console.log('hermesc not found in node_modules (hermes-compiler, react-native/sdks)');
    process.exit(2);
  }
  return found;
}

/** The release bundle as the Gradle plugin and react-native-xcode.sh build it, with Hermes. */
export function bundle(platform: string, out: string): void {
  if (platform !== 'android' && platform !== 'ios') {
    console.log(`not a platform: ${platform}`);
    process.exit(2);
  }
  const entry = [`index.${platform}.js`, 'index.js'].find((f) => existsSync(f));
  if (!entry) {
    console.log(`no index.${platform}.js or index.js`);
    process.exit(2);
  }
  mkdirSync(join(out, 'assets'), { recursive: true });
  const js = join(out, 'bundle.js');
  const hbc = join(out, 'bundle.hbc');
  run([
    'node', 'node_modules/react-native/cli.js', 'bundle', '--platform', platform, '--dev', 'false', '--reset-cache',
    '--entry-file', entry, '--bundle-output', js, '--assets-dest', join(out, 'assets'),
    '--sourcemap-output', join(out, 'packager.map'), '--minify', 'false',
  ]);
  const flags = platform === 'android'
    ? ['-w', '-emit-binary', '-max-diagnostic-width=80', '-out', hbc, js, '-O', '-output-source-map']
    : ['-emit-binary', '-max-diagnostic-width=80', '-O', '-output-source-map', '-out', hbc, js];
  run([hermesc(), ...flags]);
  run(['node', 'node_modules/react-native/scripts/compose-source-maps.js', join(out, 'packager.map'), `${hbc}.map`, '-o', join(out, 'bundle.map')]);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'deps') deps();
  else if (command === 'bundle' && args.length === 2) bundle(args[0]!, args[1]!);
  else {
    console.log('usage: rnbuild.ts deps | bundle <android|ios> <out dir>');
    process.exit(2);
  }
}
