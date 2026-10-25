#!/usr/bin/env node
// One command to get a local Vaultwarden test environment (NOT a production setup, see compose.vaultwarden.yaml):
//   npm run playground            create certs, start Vaultwarden, register a@test.local and b@test.local, seed a
//   npm run playground -- --reset wipe the playground's data first (restores the seeded snapshot when there is one, seconds)
//   npm run playground -- --fresh like --reset, but seed again and refresh the snapshot (minutes)
// Credentials land in tmp/test-vw-a.json and tmp/test-vw-b.json (mode 600, git-ignored, random passwords).
// What was seeded into a is recorded in tmp/test-vw-a.seed.json (with attachment hashes, to verify a restore).
import { execa } from 'execa';
import crypto from 'node:crypto';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedAccount } from './lib/seed.mjs';
import { vwClient } from './lib/vw-client.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TLS_DIR = path.join(ROOT, 'tmp/vw-tls');
const PORT = process.env.VW_PORT ?? '8222';
const BASE = `https://localhost:${PORT}`;
const COMPOSE = ['compose', '-f', 'compose.vaultwarden.yaml'];
const USERS = [{ key: 'a', email: 'a@test.local' }, { key: 'b', email: 'b@test.local' }];

const log = (msg) => console.log(msg);
const exists = (p) => fs.access(p).then(() => true, () => false);
const compose = (...args) => execa('docker', [...COMPOSE, ...args], { cwd: ROOT, stdio: 'inherit' });
const credsFile = (u) => path.join(ROOT, `tmp/test-vw-${u.key}.json`);
const seedFile = path.join(ROOT, 'tmp/test-vw-a.seed.json');

// A seeded state costs minutes to create (the bw CLI does one request at a time), so it is snapshotted once and
// restored in seconds. The snapshot is keyed by the code that creates it and by the Vaultwarden image.
const fresh = process.argv.includes('--fresh');
const reset = process.argv.includes('--reset') || fresh;
const SNAP_ROOT = path.join(ROOT, 'tmp/snapshots');
async function codeHash() {
  const h = createHash('sha256');
  // everything that shapes the seeded state: the code that seeds, the Vaultwarden settings, and the bw CLI that encrypts the items
  for (const f of ['scripts/playground.mjs', 'scripts/lib/seed.mjs', 'scripts/lib/vw-client.mjs', 'compose.vaultwarden.yaml', 'node_modules/@bitwarden/cli/package.json']) h.update(await fs.readFile(path.join(ROOT, f)));
  return h.digest('hex').slice(0, 16);
}
const imageId = async () => (await execa('docker', ['image', 'inspect', 'vaultwarden/server:latest', '--format', '{{.Id}}'], { reject: false })).stdout.trim();
const SNAP_FILES = ['test-vw-a.json', 'test-vw-b.json', 'test-vw-a.seed.json'];
let snapDir;
let pristine = reset; // true while the playground has not been used since it was created

if (reset) {
  log('reset: stopping the playground and wiping tmp/vaultwarden, the generated test credentials and the seed manifest');
  await compose('down', '--remove-orphans').catch(() => {});
  await fs.rm(path.join(ROOT, 'tmp/vaultwarden'), { recursive: true, force: true });
  for (const u of USERS) await fs.rm(credsFile(u), { force: true });
  await fs.rm(seedFile, { force: true });
  snapDir = path.join(SNAP_ROOT, await codeHash());
  const meta = await fs.readFile(path.join(snapDir, 'meta.json'), 'utf8').then(JSON.parse, () => null);
  if (!fresh && meta && meta.imageId === (await imageId())) {
    log(`restoring the seeded playground from snapshot ${path.basename(snapDir)}`);
    await fs.cp(path.join(snapDir, 'vaultwarden'), path.join(ROOT, 'tmp/vaultwarden'), { recursive: true });
    for (const f of SNAP_FILES) await fs.copyFile(path.join(snapDir, f), path.join(ROOT, 'tmp', f));
    for (const f of ['test-vw-a.json', 'test-vw-b.json']) await fs.chmod(path.join(ROOT, 'tmp', f), 0o600);
    pristine = false; // nothing to seed or snapshot
  }
}
snapDir ??= path.join(SNAP_ROOT, await codeHash());

if (!(await exists(path.join(TLS_DIR, 'vw.crt')))) {
  log('creating throwaway TLS certificates in tmp/vw-tls');
  await execa('sh', ['scripts/vw-test-tls.sh'], { cwd: ROOT, stdio: 'inherit' });
}
const caFile = path.join(TLS_DIR, 'ca.crt');
const client = vwClient({ base: BASE, ca: await fs.readFile(caFile), debug: Boolean(process.env.PLAYGROUND_DEBUG) });
for (const u of USERS) await fs.mkdir(path.join(ROOT, `tmp/backup-test-${u.key}`), { recursive: true });

// bwbu-test mounts its credentials file as a secret, so it must exist before compose is happy
if (!(await exists(credsFile(USERS[0])))) await fs.writeFile(credsFile(USERS[0]), '{}', { mode: 0o600 });

log('starting Vaultwarden');
await compose('up', '-d', 'vaultwarden');
await client.waitAlive();
log(`Vaultwarden is alive on ${BASE}`);

const credentials = {};
for (const user of USERS) {
  const file = credsFile(user);
  let existing = {};
  try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* none yet */ }
  if (existing.email === user.email && existing.clientId) {
    log(`${user.email}: credentials already in tmp/test-vw-${user.key}.json, skipping`);
    credentials[user.key] = existing;
    continue;
  }
  const password = crypto.randomBytes(18).toString('base64url');
  const reg = await client.register({ email: user.email, password });
  if (reg.status >= 300) {
    throw new Error(`registering ${user.email} failed at ${reg.step}: HTTP ${reg.status} ${reg.json?.message ?? reg.json?.error_description ?? reg.text.slice(0, 160)}\n` +
      'If the account already exists (its random password is lost), run: npm run playground -- --reset');
  }
  const { clientId, clientSecret } = await client.apiKeyFor({ email: user.email, password });
  const creds = { email: user.email, serverUrl: BASE, clientId, clientSecret, masterPassword: password, passphrase: crypto.randomBytes(24).toString('base64url') };
  await fs.writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  credentials[user.key] = creds;
  log(`${user.email}: registered, credentials written to tmp/test-vw-${user.key}.json`);
}

if (await exists(seedFile)) {
  log('a@test.local: already seeded (tmp/test-vw-a.seed.json), skipping');
} else {
  log('seeding a@test.local');
  const a = credentials.a;
  const manifest = await seedAccount({ client, user: { email: a.email, password: a.masterPassword }, creds: a, base: BASE, caFile, root: ROOT, log });
  await fs.writeFile(seedFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  log('seed manifest written to tmp/test-vw-a.seed.json');
  if (pristine) {
    // snapshot the freshly seeded state (Vaultwarden must be stopped for a consistent copy of its database)
    log(`saving a snapshot of the seeded playground (${path.basename(snapDir)})`);
    await compose('stop', 'vaultwarden');
    await fs.rm(snapDir, { recursive: true, force: true });
    await fs.mkdir(snapDir, { recursive: true, mode: 0o700 });
    await fs.cp(path.join(ROOT, 'tmp/vaultwarden'), path.join(snapDir, 'vaultwarden'), { recursive: true });
    for (const f of SNAP_FILES) await fs.copyFile(path.join(ROOT, 'tmp', f), path.join(snapDir, f));
    await fs.writeFile(path.join(snapDir, 'meta.json'), JSON.stringify({ imageId: await imageId(), createdAt: new Date().toISOString() }));
    await compose('up', '-d', 'vaultwarden');
    await client.waitAlive();
  }
}
log('\nplayground ready. Next: docker compose -f compose.vaultwarden.yaml run --rm bwbu-test');
