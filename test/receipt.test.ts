import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { checkReceipt, receiptPath, writeReceipt, type Receipt, type RunRecord } from '../src/receipt.ts';
import { tempDir } from './helpers.ts';

const HEAD = 'a'.repeat(40);

function run(role: RunRecord['role'], ok = true): RunRecord {
  return {
    role, commit: role === 'head' ? HEAD : 'b'.repeat(40), command: ['./gradlew'], exitCode: ok ? 0 : 1,
    durationMs: 1, log: '/tmp/x.log', tests: { total: 1, failed: 0, skipped: 0 }, target: [], ok, reason: '',
  };
}

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    schema: 1, verified: true, head: HEAD, base: 'b'.repeat(40), from: 'b'.repeat(40), issue: 'i', test: 'a.BTest.c',
    expected: { exception: 'java.lang.NullPointerException', frame: 'a.B.c' }, projectDir: '', runner: 'gradle',
    testFiles: [], fixFiles: [], runs: [run('base'), run('head')], createdAt: '2026-10-07T00:00:00Z', fixcrash: '0.0.0',
    ...overrides,
  };
}

function writeRaw(gitDir: string, commit: string, content: string): void {
  const path = receiptPath(gitDir, commit);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test('accepts the receipt written for a commit', (t) => {
  const gitDir = tempDir(t);
  const path = writeReceipt(gitDir, receipt());

  const check = checkReceipt(gitDir, HEAD);

  assert.ok(check.ok);
  assert.equal(check.path, path);
  assert.equal(check.receipt.issue, 'i');
});

test('rejects a missing receipt, and one for another commit', (t) => {
  const gitDir = tempDir(t);
  assert.match((checkReceipt(gitDir, HEAD) as { reason: string }).reason, /no receipt for aaaaaaaaaaaa/);

  writeRaw(gitDir, HEAD, JSON.stringify(receipt({ head: 'c'.repeat(40) })));
  assert.match((checkReceipt(gitDir, HEAD) as { reason: string }).reason, /is for c{40}/);
});

test('rejects malformed, old-schema and unverified receipts', (t) => {
  const gitDir = tempDir(t);
  const reason = () => (checkReceipt(gitDir, HEAD) as { reason: string }).reason;

  writeRaw(gitDir, HEAD, '{');
  assert.match(reason(), /not valid JSON/);
  writeRaw(gitDir, HEAD, JSON.stringify({ ...receipt(), schema: 0 }));
  assert.match(reason(), /schema 0/);
  writeRaw(gitDir, HEAD, JSON.stringify({ ...receipt(), verified: false }));
  assert.match(reason(), /does not say verified/);
});

test('rejects a receipt without a passing base and head run', (t) => {
  const gitDir = tempDir(t);

  writeRaw(gitDir, HEAD, JSON.stringify(receipt({ runs: [run('head')] })));
  assert.equal(checkReceipt(gitDir, HEAD).ok, false);
  writeRaw(gitDir, HEAD, JSON.stringify(receipt({ runs: [run('base'), run('head', false)] })));
  assert.equal(checkReceipt(gitDir, HEAD).ok, false);
});
