import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { backup } from '../src/backup.mjs';
import { unpack } from '../src/unpack.mjs';
import { exists, makeSandbox } from '../testing/helpers.mjs';

test('backs up personal and org vaults including org attachments', async () => {
  const sb = await makeSandbox();
  const argv = sb.argv({ encrypt: false, cleanUp: false });
  await backup(argv, sb.deps);

  const read = (...p) => fs.readFile(path.join(argv.tempDir, ...p), 'utf8');
  assert.equal(JSON.parse(await read('personal', 'export.json')).orgId, null);
  assert.equal(await read('personal', 'attachments', 'Personal item', 'pi1', 'pa1', 'file.txt'), 'content of pa1');
  assert.equal(JSON.parse(await read('org', 'My Org', 'export.json')).orgId, 'org-1');
  assert.equal(await read('org', 'My Org', 'attachments', 'Org item', 'oi1', 'oa2', 'file.txt'), 'content of oa2');
  assert.ok(await exists(path.join(argv.tempDir, 'personal', 'folders.json')));
  assert.ok(await exists(path.join(argv.tempDir, 'org', 'My Org', 'collections.json')));

  // Regression: `bw list items` also returns org items, they belong in org/ only, not in personal/.
  const personalItems = JSON.parse(await read('personal', 'items.json'));
  assert.deepEqual(personalItems.map((i) => i.id), ['pi1', 'pi2']);
  assert.equal((await sb.bwCalls()).some((c) => c.args.includes('xa1')), false);
  assert.equal(await exists(path.join(argv.tempDir, 'personal', 'attachments', 'Org item seen via personal list')), false);

  // Regression: org attachments must be fetched with --organizationid.
  const orgFetches = (await sb.bwCalls()).filter((c) => c.args[0] === 'get' && c.args.includes('oa1'));
  assert.deepEqual(orgFetches.map((c) => c.args.includes('--organizationid')), [true]);
  await sb.cleanup();
});

test('a failed attachment does not stop the others but fails the backup', async () => {
  const sb = await makeSandbox();
  process.env.FAKE_BW_FAIL_FILE = 'oa1';
  const argv = sb.argv({ encrypt: false, cleanUp: false });
  await assert.rejects(backup(argv, sb.deps), /1 of 2 attachment\(s\) failed.*oi1\/oa1/);
  assert.ok(await exists(path.join(argv.tempDir, 'org', 'My Org', 'attachments', 'Org item', 'oi1', 'oa2', 'file.txt')));
  await sb.cleanup();
});

test('cleans up temp dir and logs out even when the backup fails', async () => {
  const sb = await makeSandbox();
  process.env.FAKE_BW_FAIL = 'sync';
  const argv = sb.argv();
  await assert.rejects(backup(argv, sb.deps));
  assert.equal(await exists(argv.tempDir), false);
  assert.ok((await sb.bwCalls()).some((c) => c.args[0] === 'logout'));
  await sb.cleanup();
});

test('bw errors never leak the master password or session key', async () => {
  const sb = await makeSandbox();
  process.env.FAKE_BW_FAIL = 'list';
  await assert.rejects(backup(sb.argv(), sb.deps), (err) => !/master-pw|SESSIONKEY/.test(err.message));
  await sb.cleanup();
});

test('secrets are never passed as command line arguments', async () => {
  const sb = await makeSandbox();
  await backup(sb.argv(), sb.deps);
  const bwArgs = (await sb.bwCalls()).flatMap((c) => c.args).join(' ');
  assert.doesNotMatch(bwArgs, /master-pw|client-secret|SESSIONKEY/);
  await sb.cleanup();
});

test('encrypted backup round-trips through unpack', async () => {
  const sb = await makeSandbox();
  const argv = sb.argv();
  await backup(argv, sb.deps);
  const [file] = await fs.readdir(argv.backupDir);
  assert.match(file, /^bw-backup-.*\.7z$/);
  assert.equal((await fs.readdir(argv.backupDir)).length, 1); // a single file, nothing else left behind

  const unpackDir = path.join(sb.dir, 'unpacked');
  await unpack({ credentialsFile: sb.credentialsFile, sourceFile: path.join(argv.backupDir, file), unpackDir }, sb.deps);
  const [name] = await fs.readdir(unpackDir);
  assert.equal(await fs.readFile(path.join(unpackDir, name, 'org', 'My Org', 'attachments', 'Org item', 'oi1', 'oa1', 'file.txt'), 'utf8'), 'content of oa1');
  await sb.cleanup();
});

test('unpack refuses a non-empty target and removes its dir on a wrong passphrase', async () => {
  const sb = await makeSandbox();
  const argv = sb.argv();
  await backup(argv, sb.deps);
  const [file] = await fs.readdir(argv.backupDir);
  const sourceFile = path.join(argv.backupDir, file);
  const unpackDir = path.join(sb.dir, 'unpacked');
  const target = path.join(unpackDir, file.replace(/\.7z$/, ''));

  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'precious'), 'x');
  await assert.rejects(unpack({ credentialsFile: sb.credentialsFile, sourceFile, unpackDir }, sb.deps), /non-empty/);
  assert.ok(await exists(path.join(target, 'precious')));

  await fs.rm(target, { recursive: true });
  process.env.FAKE_7Z_PASSPHRASE = 'other';
  await assert.rejects(unpack({ credentialsFile: sb.credentialsFile, sourceFile, unpackDir }, sb.deps), /Could not unpack/);
  assert.equal(await exists(target), false);
  await sb.cleanup();
});

test('no partial archive is left behind when archiving fails', async () => {
  const sb = await makeSandbox();
  process.env.FAKE_7Z_PASSPHRASE = 'something-else'; // fake 7z rejects the real passphrase
  const argv = sb.argv();
  await assert.rejects(backup(argv, sb.deps));
  assert.deepEqual(await fs.readdir(argv.backupDir).catch(() => []), []);
  await sb.cleanup();
});

test('unpack hints at legacy .tar.gz archives', async () => {
  const sb = await makeSandbox();
  const src = path.join(sb.dir, 'legacy-src');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, 'bw-backup-old.tar.gz'), 'x');
  const sourceFile = path.join(sb.dir, 'bw-backup-old.7z');
  const { createArchive } = await import('../src/archive.mjs');
  await createArchive({ source: src, target: sourceFile, passphrase: 'archive-pass' }, { sevenZipBin: sb.deps.sevenZipBin });
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  process.env.LOG_LEVEL = 'warn';
  try {
    await unpack({ credentialsFile: sb.credentialsFile, sourceFile, unpackDir: path.join(sb.dir, 'u') }, sb.deps);
  } finally {
    console.warn = orig;
    process.env.LOG_LEVEL = 'error';
  }
  assert.match(warnings.join('\n'), /Legacy backup.*tar -xzf bw-backup-old\.tar\.gz/);
  await sb.cleanup();
});

test('unpack rejects an empty or missing source file and never touches the unpack dir', async () => {
  const sb = await makeSandbox();
  const unpackDir = path.join(sb.dir, 'unpacked');
  await fs.mkdir(unpackDir);
  for (const sourceFile of ['', undefined, path.join(sb.dir, 'nope.7z')]) {
    await assert.rejects(unpack({ credentialsFile: sb.credentialsFile, sourceFile, unpackDir }, sb.deps), /No source file given|Source file not found/);
  }
  assert.ok(await exists(unpackDir));
  await sb.cleanup();
});

test('unpack keeps a pre-existing empty target dir when extraction fails', async () => {
  const sb = await makeSandbox();
  const argv = sb.argv();
  await backup(argv, sb.deps);
  const [file] = await fs.readdir(argv.backupDir);
  const unpackDir = path.join(sb.dir, 'unpacked');
  const target = path.join(unpackDir, file.replace(/\.7z$/, ''));
  await fs.mkdir(target, { recursive: true });
  process.env.FAKE_7Z_PASSPHRASE = 'other';
  await assert.rejects(unpack({ credentialsFile: sb.credentialsFile, sourceFile: path.join(argv.backupDir, file), unpackDir }, sb.deps), /Could not unpack/);
  assert.ok(await exists(target)); // it was there before us, so we leave it
  await sb.cleanup();
});
