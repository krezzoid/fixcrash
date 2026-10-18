// The plugin folder is what an install copies into the user's cache (ADR-0006):
// it holds everything the plugin runs, and nothing that makes Claude Code
// install packages or Anthropic's directory hold it for a reviewer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sh } from './helpers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN = join(ROOT, 'plugin');
const json = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
/** The plugin's committed files, as `<mode> <path>`. */
const shipped = () => sh(ROOT, 'git', 'ls-files', '--stage', '--', 'plugin').split('\n')
  .map((line) => { const [meta = '', path = ''] = line.split('\t'); return { mode: meta.split(' ')[0], path }; });

test('the marketplace lists the plugin folder under the manifest name', () => {
  const marketplace = json('.claude-plugin/marketplace.json');
  const manifest = json('plugin/.claude-plugin/plugin.json');
  assert.deepEqual(marketplace.plugins.map((p: { name: string; source: string }) => [p.name, p.source]), [[manifest.name, './plugin']]);
});

test('the plugin folder sets ES modules and has no packages to install', () => {
  assert.deepEqual(json('plugin/package.json'), { private: true, type: 'module' });
  const lockfiles = shipped().filter((f) => /^plugin\/(package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?)$/.test(f.path));
  assert.deepEqual(lockfiles, []);
});

test('the plugin folder holds small text files, no links', () => {
  for (const { mode, path } of shipped()) {
    assert.notEqual(mode, '120000', `${path} is a symbolic link`);
    const bytes = readFileSync(join(ROOT, path));
    assert.ok(bytes.length < 256 * 1024, `${path} is 256 KiB or more`);
    assert.equal(bytes.includes(0), false, `${path} is binary`);
  }
});

test('the sources reach no file outside the plugin folder', () => {
  const ts = shipped().map((f) => f.path).filter((p) => p.endsWith('.ts'));
  assert.ok(ts.length > 0);
  for (const path of ts) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const [, target] of text.matchAll(/(?:from |import\(|new URL\()'(\.{1,2}\/[^']*)'/g)) {
      const at = relative(PLUGIN, resolve(dirname(join(ROOT, path)), target!));
      assert.ok(!at.startsWith('..'), `${path} reaches ${target}`);
    }
  }
});
