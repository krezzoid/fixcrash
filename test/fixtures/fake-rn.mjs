// A fake React Native toolchain for fixcrash's own tests: npm, Jest, the
// bundler, hermesc, compose-source-maps and metro-symbolicate, each as small
// as the Jest runner and rnbuild.ts need.
//
// `npm ci` writes node_modules with a stub per tool that runs this script.
// App code: src/*.ts, with lines
//   `behaviour: bug | fixed`             (src/profile.ts: the test crashes at that line, or passes)
//   `bundle column <n> in <function>`    (the bundle's source map places column n at that line)
// Tests: __tests__/*.test.ts, with lines
//   `test: <full name> => crash | pass | fail`
// FAKE_RN_CALLS names a file each tool appends its name to.
// FAKE_NPM_ENOTCACHED makes `npm ci --offline` miss a package in npm's cache.
//
// usage: node fake-rn.mjs <tool> <args…>

import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function option(args, name) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
}

function npm(args) {
  if (args[0] !== 'ci') throw new Error(`fake npm: ${args.join(' ')}`);
  if (args.includes('--offline') && process.env.FAKE_NPM_ENOTCACHED) {
    console.log('npm error code ENOTCACHED');
    console.log("npm error request to https://registry.npmjs.org/jest failed: cache mode is 'only-if-cached' but no cached response is available.");
    process.exit(1);
  }
  const stub = (tool) => `import(${JSON.stringify(SELF)}).then((m) => m.main(${JSON.stringify(tool)}, process.argv.slice(2)));\n`;
  write('node_modules/jest/bin/jest.js', stub('jest'));
  write('node_modules/react-native/cli.js', stub('bundle'));
  write('node_modules/react-native/scripts/compose-source-maps.js', stub('compose'));
  write('node_modules/metro-symbolicate/src/index.js', stub('symbolicate'));
  for (const dir of ['osx-bin', 'linux64-bin']) {
    const hermesc = `node_modules/hermes-compiler/hermesc/${dir}/hermesc`;
    write(hermesc, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SELF)} hermesc "$@"\n`);
    chmodSync(hermesc, 0o755);
  }
}

/** Every `bundle column <n> in <function>` line under src/, as metro-symbolicate prints it. */
function sourceMap() {
  const columns = {};
  for (const file of readdirSync('src')) {
    readFileSync(join('src', file), 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/bundle column (\d+) in (\S+)/);
      if (m) columns[m[1]] = `${process.cwd()}/src/${file}:${i + 1}:${m[2]}`;
    });
  }
  return { columns };
}

function bundle(args) {
  if (args[0] !== 'bundle') throw new Error(`fake react-native: ${args.join(' ')}`);
  if (!existsSync(option(args, 'entry-file'))) throw new Error('no entry file');
  write(option(args, 'bundle-output'), '// the bundle\n');
  write(option(args, 'sourcemap-output'), JSON.stringify(sourceMap()));
}

function hermesc(args) {
  const out = args[args.indexOf('-out') + 1];
  write(out, 'hbc');
  if (args.includes('-output-source-map')) write(`${out}.map`, '{}');
}

function compose([packagerMap, hbcMap, o, out]) {
  if (o !== '-o' || !existsSync(hbcMap)) throw new Error('fake compose-source-maps: no Hermes map');
  copyFileSync(packagerMap, out);
}

function symbolicate([map]) {
  const { columns } = JSON.parse(readFileSync(map, 'utf8'));
  const lines = readFileSync(0, 'utf8').trim().split('\n');
  console.log(lines.map((l) => columns[l.split(':').at(-1)] ?? 'null:null:null').join('\n'));
}

function jest(args) {
  const cwd = process.cwd();
  const byPath = option(args, 'runTestsByPath');
  const pattern = option(args, 'testNamePattern');
  const files = byPath ? [byPath] : readdirSync('__tests__').filter((f) => f.endsWith('.test.ts')).map((f) => `__tests__/${f}`);
  const profile = readFileSync('src/profile.ts', 'utf8').split('\n');
  const bug = profile.findIndex((l) => /behaviour: bug/.test(l)) + 1;
  const testResults = [];
  let failed = 0;
  for (const file of files.filter((f) => existsSync(f))) {
    const assertionResults = [];
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/^test: (.+) => (\w+)$/);
      if (!m || (pattern && !new RegExp(pattern).test(m[1]))) return;
      const at = `    at Object.<anonymous> (${cwd}/${file}:${i + 1}:5)`;
      const failure = m[2] === 'fail'
        ? `Error: expect(received).toBe(expected)\n\nExpected: 1\nReceived: 2\n${at}`
        : m[2] === 'crash' && bug > 0
          ? `TypeError: Cannot read properties of undefined (reading 'url')\n    at url (${cwd}/src/profile.ts:${bug}:20)\n${at}\n    at new Promise (<anonymous>)`
          : undefined;
      if (failure) failed++;
      assertionResults.push({ fullName: m[1], status: failure ? 'failed' : 'passed', failureMessages: failure ? [failure] : [] });
    });
    testResults.push({ name: `${cwd}/${file}`, status: assertionResults.some((a) => a.status === 'failed') ? 'failed' : 'passed', assertionResults });
  }
  write(option(args, 'outputFile'), JSON.stringify({ testResults }));
  const ran = testResults.reduce((n, r) => n + r.assertionResults.length, 0);
  if (ran === 0) console.log('No tests found, exiting with code 1');
  process.exit(failed > 0 || ran === 0 ? 1 : 0);
}

const TOOLS = { npm, bundle, hermesc, compose, symbolicate, jest };

export function main(tool, args) {
  if (process.env.FAKE_RN_CALLS) appendFileSync(process.env.FAKE_RN_CALLS, `${tool}\n`);
  TOOLS[tool](args);
}

if (import.meta.main) main(process.argv[2], process.argv.slice(3));
