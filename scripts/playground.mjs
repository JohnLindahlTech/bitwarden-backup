#!/usr/bin/env node
// One command to get a local Vaultwarden test environment (NOT a production setup, see compose.vaultwarden.yaml):
//   npm run playground            create certs, start Vaultwarden, register a@test.local and b@test.local
//   npm run playground -- --reset wipe the playground's data first
// Credentials land in tmp/test-vw-a.json and tmp/test-vw-b.json (mode 600, git-ignored, random passwords).
import { execa } from 'execa';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TLS_DIR = path.join(ROOT, 'tmp/vw-tls');
const PORT = process.env.VW_PORT ?? '8222';
const BASE = `https://localhost:${PORT}`;
const COMPOSE = ['compose', '-f', 'compose.vaultwarden.yaml'];
const USERS = [{ key: 'a', email: 'a@test.local' }, { key: 'b', email: 'b@test.local' }];

const log = (msg) => console.log(msg);
const exists = (p) => fs.access(p).then(() => true, () => false);
const compose = (...args) => execa('docker', [...COMPOSE, ...args], { cwd: ROOT, stdio: 'inherit' });

// --- tiny https client that trusts the playground's throwaway CA ---
let ca;
function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const req = https.request(url, { method, ca, headers: { ...headers, ...(payload && { 'content-length': payload.length }) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json; try { json = JSON.parse(text); } catch { /* not json */ }
        if (process.env.PLAYGROUND_DEBUG && res.statusCode >= 400) console.error(`[debug] ${method} ${url} -> ${res.statusCode} ${JSON.stringify(res.headers['content-type'])} ${JSON.stringify(text.slice(0, 300))}`);
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const postJson = (url, data, headers = {}) => request('POST', url, { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });

// --- Bitwarden client-side crypto (PBKDF2 accounts) ---
const KDF_ITERATIONS = 600_000;
const b64 = (buf) => Buffer.from(buf).toString('base64');
const hmac = (key, ...parts) => crypto.createHmac('sha256', key).update(Buffer.concat(parts)).digest();

function masterKeyFor(email, password) {
  return crypto.pbkdf2Sync(password, email.trim().toLowerCase(), KDF_ITERATIONS, 32, 'sha256');
}
const passwordHashFor = (masterKey, password) => b64(crypto.pbkdf2Sync(masterKey, password, 1, 32, 'sha256'));

// Bitwarden "EncString" type 2: AES-256-CBC + HMAC-SHA256 -> "2.<iv>|<data>|<mac>"
function encString(plain, encKey, macKey) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `2.${b64(iv)}|${b64(data)}|${b64(hmac(macKey, iv, data))}`;
}

function newAccountKeys(masterKey) {
  // HKDF-Expand only (no extract), single block: T1 = HMAC(prk, info | 0x01)
  const stretchedEnc = hmac(masterKey, Buffer.from('enc'), Buffer.from([1]));
  const stretchedMac = hmac(masterKey, Buffer.from('mac'), Buffer.from([1]));
  const userKey = crypto.randomBytes(64);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    userKey,
    protectedKey: encString(userKey, stretchedEnc, stretchedMac),
    publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
    encryptedPrivateKey: encString(privateKey.export({ type: 'pkcs8', format: 'der' }), userKey.subarray(0, 32), userKey.subarray(32)),
  };
}

async function register({ email, password }) {
  const masterKey = masterKeyFor(email, password);
  const keys = newAccountKeys(masterKey);
  const base = { email, masterPasswordHash: passwordHashFor(masterKey, password), masterPasswordHint: null, kdf: 0, kdfIterations: KDF_ITERATIONS };
  const keyPair = { publicKey: keys.publicKey, encryptedPrivateKey: keys.encryptedPrivateKey };
  // The two flows name the keys differently; sending both spellings makes strict servers reject a duplicate field.
  const newAccount = { ...base, userSymmetricKey: keys.protectedKey, userAsymmetricKeys: keyPair };
  const oldAccount = { ...base, key: keys.protectedKey, keys: keyPair };

  // Newer servers: ask for a verification token (without mail configured the server hands it straight back), then finish.
  const start = await postJson(`${BASE}/identity/accounts/register/send-verification-email`, { email, name: email.split('@')[0], receiveMarketingEmails: false });
  if (start.status !== 404) {
    // Without mail configured the server hands the token straight back, as raw text (a JWT) or a JSON string.
    const token = start.status < 300 ? (typeof start.json === 'string' ? start.json : start.text.trim().replace(/^"|"$/g, '')) : null;
    if (!token || token.split('.').length !== 3) return { ...start, status: start.status < 300 ? 502 : start.status, step: 'send-verification-email (no token returned, is SMTP/SIGNUPS_VERIFY configured?)' };
    const done = await postJson(`${BASE}/identity/accounts/register/finish`, { ...newAccount, emailVerificationToken: token, name: email.split('@')[0] });
    return { ...done, step: 'register/finish' };
  }
  // Older servers
  return { ...(await postJson(`${BASE}/identity/accounts/register`, { ...oldAccount, name: email.split('@')[0] })), step: 'register' };
}

async function prelogin(email) {
  const res = await postJson(`${BASE}/identity/accounts/prelogin`, { email });
  const j = res.json ?? {};
  return { kdf: j.kdf ?? j.Kdf ?? 0, iterations: j.kdfIterations ?? j.KdfIterations ?? KDF_ITERATIONS, memory: j.kdfMemory ?? j.KdfMemory, parallelism: j.kdfParallelism ?? j.KdfParallelism };
}

async function login({ email, password }) {
  const kdf = await prelogin(email);
  if (process.env.PLAYGROUND_DEBUG) console.error(`[debug] prelogin ${email}: kdf=${kdf.kdf} iterations=${kdf.iterations} memory=${kdf.memory} parallelism=${kdf.parallelism}`);
  const masterKey = kdf.kdf === 1
    ? crypto.argon2Sync('argon2id', { message: Buffer.from(password), nonce: crypto.createHash('sha256').update(email.trim().toLowerCase()).digest(), memory: kdf.memory * 1024, passes: kdf.iterations, parallelism: kdf.parallelism, tagLength: 32 })
    : crypto.pbkdf2Sync(password, email.trim().toLowerCase(), kdf.iterations, 32, 'sha256');
  const hash = passwordHashFor(masterKey, password);
  const res = await request('POST', `${BASE}/identity/connect/token`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'auth-email': Buffer.from(email.trim().toLowerCase()).toString('base64url') },
    body: new URLSearchParams({ grant_type: 'password', username: email, password: hash, scope: 'api offline_access', client_id: 'web', deviceType: '9', deviceIdentifier: crypto.randomUUID(), deviceName: 'bwbu-playground' }).toString(),
  });
  return { res, hash, masterKey, token: res.json?.access_token, protectedKey: res.json?.Key ?? res.json?.key };
}

async function apiKeyFor(user) {
  const { token, hash, res } = await login(user);
  if (!token) throw new Error(`login failed for ${user.email}: ${res.status} ${res.json?.error_description ?? res.json?.error ?? res.json?.message ?? res.text.slice(0, 160)}`);
  const auth = { authorization: `Bearer ${token}` };
  const profile = await request('GET', `${BASE}/api/accounts/profile`, { headers: auth });
  const key = await postJson(`${BASE}/api/accounts/api-key`, { masterPasswordHash: hash }, auth);
  const secret = key.json?.apiKey ?? key.json?.ApiKey;
  if (!profile.json?.id || !secret) throw new Error(`could not read the API key of ${user.email} (HTTP ${key.status})`);
  return { clientId: `user.${profile.json.id}`, clientSecret: secret };
}

async function waitAlive() {
  for (let i = 0; i < 40; i++) {
    try { if ((await request('GET', `${BASE}/alive`)).status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Vaultwarden did not become alive on ${BASE}`);
}

export { register, login, apiKeyFor, request, postJson, setCa };
function setCa(buf) { ca = buf; }

// --- main ---
const isMain = import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) await main();
async function main() {
const reset = process.argv.includes('--reset');
if (reset) {
  log('reset: stopping the playground and wiping tmp/vaultwarden and the generated test credentials');
  await compose('down', '--remove-orphans').catch(() => {});
  await fs.rm(path.join(ROOT, 'tmp/vaultwarden'), { recursive: true, force: true });
  for (const u of USERS) await fs.rm(path.join(ROOT, `tmp/test-vw-${u.key}.json`), { force: true });
}

if (!(await exists(path.join(TLS_DIR, 'vw.crt')))) {
  log('creating throwaway TLS certificates in tmp/vw-tls');
  await execa('sh', ['scripts/vw-test-tls.sh'], { cwd: ROOT, stdio: 'inherit' });
}
ca = await fs.readFile(path.join(TLS_DIR, 'ca.crt'));
await fs.mkdir(path.join(ROOT, 'tmp/backup-test'), { recursive: true });

// bwbu-test mounts its credentials file as a secret, so it must exist before compose is happy
const credsFile = (u) => path.join(ROOT, `tmp/test-vw-${u.key}.json`);
if (!(await exists(credsFile(USERS[0])))) await fs.writeFile(credsFile(USERS[0]), '{}', { mode: 0o600 });

log('starting Vaultwarden');
await compose('up', '-d', 'vaultwarden');
await waitAlive();
log(`Vaultwarden is alive on ${BASE}`);

for (const user of USERS) {
  const file = credsFile(user);
  let existing = {};
  try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* none yet */ }
  if (existing.email === user.email && existing.clientId) {
    log(`${user.email}: credentials already in tmp/test-vw-${user.key}.json, skipping`);
    continue;
  }
  const password = crypto.randomBytes(18).toString('base64url');
  const reg = await register({ email: user.email, password });
  if (reg.status >= 300) {
    throw new Error(`registering ${user.email} failed at ${reg.step}: HTTP ${reg.status} ${reg.json?.message ?? reg.json?.error_description ?? reg.text.slice(0, 160)}\n` +
      'If the account already exists (its random password is lost), run: npm run playground -- --reset');
  }
  const { clientId, clientSecret } = await apiKeyFor({ email: user.email, password });
  const creds = { email: user.email, serverUrl: BASE, clientId, clientSecret, masterPassword: password, passphrase: crypto.randomBytes(24).toString('base64url') };
  await fs.writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  log(`${user.email}: registered, credentials written to tmp/test-vw-${user.key}.json`);
}
log('\nplayground ready. Next: docker compose -f compose.vaultwarden.yaml run --rm bwbu-test');
}
