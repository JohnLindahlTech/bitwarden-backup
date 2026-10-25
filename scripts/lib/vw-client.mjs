// Minimal Bitwarden/Vaultwarden API client for the TEST playground: registration, login, API key and organization
// creation. These need client-side crypto because the server only ever stores keys the client generated.
import crypto from 'node:crypto';
import https from 'node:https';

const KDF_ITERATIONS = 600_000;
const b64 = (buf) => Buffer.from(buf).toString('base64');
const hmac = (key, ...parts) => crypto.createHmac('sha256', key).update(Buffer.concat(parts)).digest();

// Bitwarden "EncString" type 2: AES-256-CBC + HMAC-SHA256 -> "2.<iv>|<data>|<mac>"
export function encString(plain, key64) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key64.subarray(0, 32), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `2.${b64(iv)}|${b64(data)}|${b64(hmac(key64.subarray(32), iv, data))}`;
}

// Account/organization key material: a 64 byte symmetric key and an RSA key pair, the private half encrypted with it.
function newKeyMaterial() {
  const symKey = crypto.randomBytes(64);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    symKey,
    publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
    encryptedPrivateKey: encString(privateKey.export({ type: 'pkcs8', format: 'der' }), symKey),
  };
}

export function vwClient({ base, ca, debug = false }) {
  function request(method, url, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(body);
      const req = https.request(url, { method, ca, headers: { ...headers, ...(payload && { 'content-length': payload.length }) } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json; try { json = JSON.parse(text); } catch { /* not json */ }
          if (debug && res.statusCode >= 400) console.error(`[debug] ${method} ${url} -> ${res.statusCode} ${JSON.stringify(text.slice(0, 300))}`);
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  const postJson = (url, data, headers = {}) => request('POST', url, { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const normalize = (email) => email.trim().toLowerCase();

  async function prelogin(email) {
    const j = (await postJson(`${base}/identity/accounts/prelogin`, { email })).json ?? {};
    return { kdf: j.kdf ?? j.Kdf ?? 0, iterations: j.kdfIterations ?? j.KdfIterations ?? KDF_ITERATIONS, memory: j.kdfMemory ?? j.KdfMemory, parallelism: j.kdfParallelism ?? j.KdfParallelism };
  }

  function masterKeyFor(email, password, kdf) {
    return kdf.kdf === 1
      ? crypto.argon2Sync('argon2id', { message: Buffer.from(password), nonce: crypto.createHash('sha256').update(normalize(email)).digest(), memory: kdf.memory * 1024, passes: kdf.iterations, parallelism: kdf.parallelism, tagLength: 32 })
      : crypto.pbkdf2Sync(password, normalize(email), kdf.iterations, 32, 'sha256');
  }
  const passwordHashFor = (masterKey, password) => b64(crypto.pbkdf2Sync(masterKey, password, 1, 32, 'sha256'));

  async function register({ email, password }) {
    const kdf = { kdf: 0, iterations: KDF_ITERATIONS };
    const masterKey = masterKeyFor(email, password, kdf);
    const keys = newKeyMaterial();
    // key stretching: HKDF-Expand only (no extract), single block: T1 = HMAC(prk, info | 0x01)
    const stretched = Buffer.concat([hmac(masterKey, Buffer.from('enc'), Buffer.from([1])), hmac(masterKey, Buffer.from('mac'), Buffer.from([1]))]);
    const protectedKey = encString(keys.symKey, stretched);
    const info = { email, masterPasswordHash: passwordHashFor(masterKey, password), masterPasswordHint: null, kdf: 0, kdfIterations: KDF_ITERATIONS };
    const keyPair = { publicKey: keys.publicKey, encryptedPrivateKey: keys.encryptedPrivateKey };
    const name = email.split('@')[0];

    // Newer servers: ask for a verification token (without mail configured the server hands it straight back), then finish.
    const start = await postJson(`${base}/identity/accounts/register/send-verification-email`, { email, name, receiveMarketingEmails: false });
    if (start.status !== 404) {
      const token = start.status < 300 ? (typeof start.json === 'string' ? start.json : start.text.trim().replace(/^"|"$/g, '')) : null;
      if (!token || token.split('.').length !== 3) return { ...start, status: start.status < 300 ? 502 : start.status, step: 'send-verification-email (no token returned, is SMTP/SIGNUPS_VERIFY configured?)' };
      // The two flows name the keys differently; sending both spellings makes strict servers reject a duplicate field.
      return { ...(await postJson(`${base}/identity/accounts/register/finish`, { ...info, userSymmetricKey: protectedKey, userAsymmetricKeys: keyPair, emailVerificationToken: token, name })), step: 'register/finish' };
    }
    return { ...(await postJson(`${base}/identity/accounts/register`, { ...info, key: protectedKey, keys: keyPair, name })), step: 'register' };
  }

  async function login({ email, password }) {
    const kdf = await prelogin(email);
    const masterKey = masterKeyFor(email, password, kdf);
    const hash = passwordHashFor(masterKey, password);
    const res = await request('POST', `${base}/identity/connect/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'auth-email': Buffer.from(normalize(email)).toString('base64url') },
      body: new URLSearchParams({ grant_type: 'password', username: email, password: hash, scope: 'api offline_access', client_id: 'web', deviceType: '9', deviceIdentifier: crypto.randomUUID(), deviceName: 'bwbu-playground' }).toString(),
    });
    if (!res.json?.access_token) throw new Error(`login failed for ${email}: HTTP ${res.status} ${res.json?.error_description || res.json?.message || res.text.slice(0, 160)}`);
    return { token: res.json.access_token, hash };
  }

  async function apiKeyFor(user) {
    const { token, hash } = await login(user);
    const auth = { authorization: `Bearer ${token}` };
    const profile = await request('GET', `${base}/api/accounts/profile`, { headers: auth });
    const key = await postJson(`${base}/api/accounts/api-key`, { masterPasswordHash: hash }, auth);
    const secret = key.json?.apiKey ?? key.json?.ApiKey;
    if (!profile.json?.id || !secret) throw new Error(`could not read the API key of ${user.email} (HTTP ${key.status})`);
    return { userId: profile.json.id, clientId: `user.${profile.json.id}`, clientSecret: secret };
  }

  // The CLI cannot create organizations. The org key is encrypted to the creator's public key (RSA-OAEP SHA-1, "4.").
  async function createOrganization(user, name, { billingEmail = user.email } = {}) {
    const { token } = await login(user);
    const auth = { authorization: `Bearer ${token}` };
    const profile = (await request('GET', `${base}/api/accounts/profile`, { headers: auth })).json;
    const pub = (await request('GET', `${base}/api/users/${profile.id}/public-key`, { headers: auth })).json?.publicKey;
    if (!pub) throw new Error('could not read the public key of the organization creator');
    const org = newKeyMaterial();
    const encOrgKey = `4.${b64(crypto.publicEncrypt({ key: crypto.createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }), oaepHash: 'sha1', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, org.symKey))}`;
    const res = await postJson(`${base}/api/organizations`, {
      name, billingEmail, planType: 0, key: encOrgKey, keys: { publicKey: org.publicKey, encryptedPrivateKey: org.encryptedPrivateKey },
      collectionName: encString(Buffer.from('Default collection'), org.symKey),
    }, auth);
    if (res.status >= 300 || !res.json?.id) throw new Error(`creating organization "${name}" failed: HTTP ${res.status} ${res.json?.message ?? res.text.slice(0, 160)}`);
    return { id: res.json.id, name };
  }

  async function waitAlive(tries = 40) {
    for (let i = 0; i < tries; i++) {
      try { if ((await request('GET', `${base}/alive`)).status === 200) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`Vaultwarden did not become alive on ${base}`);
  }

  return { request, postJson, register, login, apiKeyFor, createOrganization, waitAlive };
}
