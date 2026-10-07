import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How to run tests for one build tool. Paths are POSIX and relative to the
 * project directory (where the build tool runs), unless they say otherwise.
 */
export interface Runner {
  name: string;
  isTestFile(path: string): boolean;
  /** The test file that defines `testId`, among `testFiles`. */
  locateTest(testId: string, testFiles: string[]): string | undefined;
  /** Runs one test. `testFile` is what `locateTest` returned. */
  targetCommand(testId: string, testFile: string): string[];
  /** Runs the full unit test suite. */
  suiteCommand(): string[];
  /** JUnit XML reports present in a project directory. */
  reportFiles(projectDir: string): string[];
  /** Untracked files the build needs (e.g. `local.properties`), by name, copied from the checkout. */
  localFiles: string[];
  /** Extra environment for the commands, and a line saying why, or undefined. */
  environment(env: NodeJS.ProcessEnv): { env: Record<string, string>; note: string } | undefined;
  /** A hint for a failed command, from its output. */
  hint(output: string): string | undefined;
}

const SKIP_DIRS = new Set(['.git', '.gradle', '.idea', '.kotlin', 'build', 'node_modules']);
// Reports are never under sources.
const SKIP_FOR_REPORTS = new Set([...SKIP_DIRS, 'src']);

/** Files under `dir` whose name is in `names`, skipping build outputs and VCS dirs. */
export function findFiles(dir: string, names: Set<string>, depth = 6): string[] {
  const found: string[] = [];
  const walk = (abs: string, rel: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (level < depth && !SKIP_DIRS.has(e.name)) walk(join(abs, e.name), childRel, level + 1);
      } else if (names.has(e.name)) {
        found.push(childRel);
      }
    }
  };
  walk(dir, '', 0);
  return found;
}

/** XML files under every `build/test-results` directory of a Gradle project. */
function gradleReports(projectDir: string): string[] {
  const reports: string[] = [];
  const collect = (abs: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name.endsWith('.xml')) reports.push(p);
    }
  };
  const walk = (abs: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'build') {
        const results = join(abs, 'build', 'test-results');
        if (existsSync(results)) collect(results);
      } else if (level < 6 && !SKIP_FOR_REPORTS.has(e.name)) {
        walk(join(abs, e.name), level + 1);
      }
    }
  };
  walk(projectDir, 0);
  return reports;
}

/** A JDK for Gradle when neither JAVA_HOME nor a working `java` is set: Android Studio's bundled one. */
function androidStudioJdk(env: NodeJS.ProcessEnv): string | undefined {
  if (env.JAVA_HOME) return undefined;
  const java = spawnSync('java', ['-version'], { env, stdio: 'ignore' });
  if (java.status === 0) return undefined;
  const home = homedir();
  const candidates = [
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    join(home, 'Applications/Android Studio.app/Contents/jbr/Contents/Home'),
    '/opt/android-studio/jbr',
    join(home, 'android-studio/jbr'),
    '/snap/android-studio/current/jbr',
  ];
  return candidates.find((c) => existsSync(join(c, 'bin', 'java')));
}

const GRADLE_TEST_DIR = /(^|\/)src\/test[A-Za-z0-9]*\//;
const GRADLE_TASK = 'testDebugUnitTest';
const GRADLE_FLAGS = ['--offline', '--console=plain'];

/** Android Gradle projects: JVM unit tests (`src/test`), run with `./gradlew --offline`. */
export const gradle: Runner = {
  name: 'gradle',

  isTestFile: (path) => GRADLE_TEST_DIR.test(path),

  locateTest(testId, testFiles) {
    // `testId` is `Class` or `Class.method`; the class lives in `<package path>/<Class>.kt|.java`.
    const parts = testId.split('.');
    const classes = [parts.join('/'), parts.slice(0, -1).join('/')].filter(Boolean);
    for (const cls of classes) {
      for (const ext of ['.kt', '.java']) {
        const file = testFiles.find((f) => GRADLE_TEST_DIR.test(f) && f.endsWith(`/${cls}${ext}`));
        if (file) return file;
      }
    }
    return undefined;
  },

  targetCommand(testId, testFile) {
    const moduleDir = testFile.slice(0, testFile.search(GRADLE_TEST_DIR));
    const modulePath = moduleDir ? `:${moduleDir.replace(/\//g, ':')}` : '';
    return ['./gradlew', ...GRADLE_FLAGS, `${modulePath}:${GRADLE_TASK}`, '--tests', testId];
  },

  suiteCommand: () => ['./gradlew', ...GRADLE_FLAGS, '--continue', GRADLE_TASK],

  reportFiles: gradleReports,

  localFiles: ['local.properties', 'google-services.json'],

  environment(env) {
    const jdk = androidStudioJdk(env);
    return jdk ? { env: { JAVA_HOME: jdk }, note: `JAVA_HOME is not set: using Android Studio's JDK, ${jdk}` } : undefined;
  },

  hint(output) {
    if (/offline mode/i.test(output)) {
      return 'Gradle ran with --offline and a dependency is missing from the local cache. Run the same command once without --offline in that directory, then verify again.';
    }
    if (/JAVA_HOME|Unable to locate a Java Runtime/.test(output)) {
      return 'Gradle found no JDK: set JAVA_HOME.';
    }
    if (/google-services\.json is missing/.test(output)) {
      return 'The build needs google-services.json, which git ignores: verify copies it from your checkout, so put it there first.';
    }
    if (/SDK location not found|sdk\.dir/.test(output)) {
      return 'Gradle found no Android SDK: set ANDROID_HOME, or sdk.dir in local.properties.';
    }
    return undefined;
  },
};

/** The runner for a project directory, or undefined when no supported build tool is found. */
export function detectRunner(projectDir: string): Runner | undefined {
  if (existsSync(join(projectDir, 'gradlew'))) return gradle;
  return undefined;
}
