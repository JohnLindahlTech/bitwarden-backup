import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { backup } from '../src/backup.mjs';
import { exists, makeSandbox } from '../testing/helpers.mjs';

async function captureWarnings(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  process.env.LOG_LEVEL = 'warn';
  try { await fn(); } finally { console.warn = orig; process.env.LOG_LEVEL = 'error'; }
  return warnings.join('\n');
}

test('orgs we may not export are skipped loudly, the backup still succeeds', async () => {
  const sb = await makeSandbox();
  process.env.FAKE_BW_EXTRA_ORGS = '1';
  const argv = sb.argv({ encrypt: false, cleanUp: false });
  const warnings = await captureWarnings(() => backup(argv, sb.deps));

  // the exportable org is backed up as usual
  assert.ok(await exists(path.join(argv.tempDir, 'org', 'My Org', 'org-1', 'export.json')));
  // the others were never touched
  const touched = (await sb.bwCalls()).filter((c) => c.args.includes('--organizationid')).map((c) => c.args.at(-1));
  assert.deepEqual([...new Set(touched)], ['org-1']);
  // and nothing is silent: one warning each, a summary, and a record in the archive
  for (const [name, reason] of [['Member Org', 'not an owner/admin'], ['Invited Org', 'not confirmed'], ['Disabled Org', 'disabled']]) {
    assert.match(warnings, new RegExp(`Skipping org \\(${name}\\), NOT backed up: .*${reason}`));
  }
  assert.match(warnings, /WARNING: 3 organization\(s\) were NOT backed up/);
  const skipped = JSON.parse(await fs.readFile(path.join(argv.tempDir, 'org', 'skipped.json'), 'utf8'));
  assert.deepEqual(skipped.map((o) => o.id), ['org-2', 'org-3', 'org-4']);
  await sb.cleanup();
});

test('no warnings when every org can be exported', async () => {
  const sb = await makeSandbox();
  const argv = sb.argv({ encrypt: false, cleanUp: false });
  const warnings = await captureWarnings(() => backup(argv, sb.deps));
  assert.doesNotMatch(warnings, /NOT backed up/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(argv.tempDir, 'org', 'skipped.json'), 'utf8')), []);
  await sb.cleanup();
});

test('a real export failure on an exportable org still fails the backup', async () => {
  const sb = await makeSandbox();
  process.env.FAKE_BW_FAIL = 'export';
  // personal vault off, so the failing export is the org's
  await assert.rejects(backup(sb.argv({ encrypt: false, includePersonal: false }), sb.deps), /export failed/);
  await sb.cleanup();
});
