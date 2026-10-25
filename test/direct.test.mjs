import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createArchive } from '../src/archive.mjs';
import { backup } from '../src/backup.mjs';
import { readMarkers } from '../src/mirror.mjs';
import { restore } from '../src/restore.mjs';
import { CREDENTIALS, exists, makeSandbox } from '../testing/helpers.mjs';

// A sandbox with a source account (the default fake) and a stateful fake TARGET account that only answers
// to its own client id, so one process can talk to both.
async function world({ sourceCredentials } = {}) {
  const sb = await makeSandbox();
  const state = path.join(sb.dir, 'target.json');
  await fs.writeFile(state, JSON.stringify({ seq: 0, items: [], folders: [] }));
  process.env.FAKE_BW_STATE = state;
  process.env.FAKE_BW_STATE_CLIENTID = 'user.target';
  const targetCredentialsFile = path.join(sb.dir, 'target-creds.json');
  await fs.writeFile(targetCredentialsFile, JSON.stringify({ ...CREDENTIALS, clientId: 'user.target' }), { mode: 0o600 });
  const credentialsFile = sourceCredentials ? path.join(sb.dir, 'source-creds.json') : sb.credentialsFile;
  if (sourceCredentials) await fs.writeFile(credentialsFile, JSON.stringify(sourceCredentials), { mode: 0o600 });
  return {
    sb, targetCredentialsFile,
    argv: (extra = {}) => sb.argv({ credentialsFile, targetCredentialsFile, includeOrg: false, ...extra }),
    target: async () => JSON.parse(await fs.readFile(state, 'utf8')),
    archives: async (dir) => (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.7z')),
  };
}

test('with a target the backup writes the archive AND mirrors straight into the target', async () => {
  const w = await world();
  const argv = w.argv();
  await backup(argv, w.sb.deps);
  assert.equal((await w.archives(argv.backupDir)).length, 1);
  const { items } = await w.target();
  assert.deepEqual(items.map((i) => i.name).sort(), ['No files', 'Personal item']);
  assert.ok(items.every((i) => readMarkers(i).src)); // mirrored with markers, like a restore
  assert.deepEqual(items.find((i) => i.name === 'Personal item').attachments.map((a) => a.fileName), ['p.txt']);
  assert.equal(await exists(argv.tempDir), false); // the plaintext is gone afterwards
  await w.sb.cleanup();
});

test('--no-archive with a target mirrors without writing any archive', async () => {
  const w = await world();
  const argv = w.argv({ archive: false });
  await backup(argv, w.sb.deps);
  assert.deepEqual(await w.archives(argv.backupDir), []);
  assert.equal((await w.target()).items.length, 2);
  assert.equal(await exists(argv.tempDir), false);
  await w.sb.cleanup();
});

test('--no-archive needs no passphrase in the credentials file', async () => {
  const { passphrase, ...withoutPassphrase } = CREDENTIALS;
  const w = await world({ sourceCredentials: withoutPassphrase });
  await backup(w.argv({ archive: false }), w.sb.deps);
  assert.equal((await w.target()).items.length, 2);
  await w.sb.cleanup();
});

test('--no-archive without a target is refused before anything happens', async () => {
  const w = await world();
  await assert.rejects(backup(w.argv({ archive: false, targetCredentialsFile: undefined }), w.sb.deps), /Nothing to do/);
  assert.deepEqual(await w.sb.bwCalls(), []); // not even a login
  await w.sb.cleanup();
});

test('a failing mirror does not cost the archive, and the run reports it', async () => {
  const w = await world();
  const argv = w.argv({ targetCredentialsFile: path.join(w.sb.dir, 'missing.json') });
  await assert.rejects(backup(argv, w.sb.deps), /incompletely.*mirror/);
  assert.equal((await w.archives(argv.backupDir)).length, 1);
  assert.equal(await exists(argv.tempDir), false);
  await w.sb.cleanup();
});

test('a failing archive does not stop the mirror, and the run reports it', async () => {
  const w = await world();
  process.env.FAKE_7Z_PASSPHRASE = 'something-else'; // the fake 7z rejects the real passphrase
  const argv = w.argv();
  await assert.rejects(backup(argv, w.sb.deps), /incompletely.*archive was not created/);
  assert.deepEqual(await w.archives(argv.backupDir), []);
  assert.equal((await w.target()).items.length, 2);
  await w.sb.cleanup();
});

test('secrets of both accounts stay out of every command line', async () => {
  const w = await world();
  await backup(w.argv(), w.sb.deps);
  assert.doesNotMatch((await w.sb.bwCalls()).flatMap((c) => c.args).join(' '), /master-pw|client-secret|SESSIONKEY/);
  await w.sb.cleanup();
});

test('the separate path still works: restore from the .7z archive with --sourceFile', async () => {
  const w = await world();
  const argv = w.argv({ targetCredentialsFile: undefined }); // a plain backup to an archive
  await backup(argv, w.sb.deps);
  const [archive] = await w.archives(argv.backupDir);
  assert.equal((await w.target()).items.length, 0); // the backup alone touched nothing

  await restore({ credentialsFile: w.targetCredentialsFile, sourceFile: path.join(argv.backupDir, archive), apply: true, includeOrg: false }, w.sb.deps);
  const { items } = await w.target();
  assert.deepEqual(items.map((i) => i.name).sort(), ['No files', 'Personal item']);
  assert.deepEqual(items.find((i) => i.name === 'Personal item').attachments.map((a) => a.fileName), ['p.txt']);
  await w.sb.cleanup();
});
