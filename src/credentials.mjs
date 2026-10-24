import fs from 'node:fs/promises';

// Schema of the credentials file (JSON). Never log values or the file path.
export const CREDENTIAL_FIELDS = ['clientId', 'clientSecret', 'masterPassword', 'passphrase'];

export async function loadCredentials(file, required = CREDENTIAL_FIELDS) {
  if (!file) {
    throw new Error('No credentials file given (--credentials-file or BWBU_CREDENTIALS_FILE).');
  }
  let stat;
  let text;
  try {
    stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error();
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw Object.assign(new Error(), { insecure: true });
    }
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.insecure) {
      throw new Error('Credentials file is accessible by group/others, run: chmod 600 <file>');
    }
    throw new Error('Credentials file could not be read.');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // JSON.parse errors can quote file content, so never forward them.
    throw new Error('Credentials file is not valid JSON.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Credentials file must contain a JSON object.');
  }
  const missing = required.filter((f) => typeof data[f] !== 'string' || data[f] === '');
  if (missing.length > 0) {
    throw new Error(`Credentials file is missing fields: ${missing.join(', ')}`);
  }
  return Object.fromEntries(CREDENTIAL_FIELDS.filter((f) => f in data).map((f) => [f, data[f]]));
}

// Returns a function that masks every credential value in a string.
export function redactor(credentials) {
  const secrets = Object.values(credentials).filter((v) => typeof v === 'string' && v.length > 0);
  return (text) => secrets.reduce((acc, s) => acc.split(s).join('***'), String(text ?? ''));
}
