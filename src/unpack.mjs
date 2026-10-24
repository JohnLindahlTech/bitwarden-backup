import fs from 'node:fs/promises';
import path from 'node:path';
import { ENCRYPT_FILE_EXTENSION, TAR_FILE_EXTENSION } from './constants.mjs';
import { loadCredentials } from './credentials.mjs';
import logger from './log.mjs';
import { decryptAndUntar } from './tar.mjs';

const stripSuffix = (name, suffix) => (name.endsWith(suffix) ? name.slice(0, -suffix.length) : name);

export async function unpack(argv, deps = {}) {
  const { passphrase } = await loadCredentials(argv.credentialsFile, ['passphrase']);

  const name = stripSuffix(stripSuffix(path.basename(argv.sourceFile), ENCRYPT_FILE_EXTENSION), TAR_FILE_EXTENSION);
  const targetDir = path.join(argv.unpackDir, name);

  const existing = await fs.readdir(targetDir).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
  if (existing.length > 0) {
    throw new Error(`Refusing to unpack into non-empty directory: ${targetDir}`);
  }
  await fs.mkdir(targetDir, { recursive: true });

  logger.info(`Will decrypt and unpack: ${argv.sourceFile} -> ${targetDir}/`);
  try {
    await decryptAndUntar({ sourceFile: argv.sourceFile, passphrase, targetDir }, deps);
  } catch (err) {
    await fs.rm(targetDir, { recursive: true, force: true });
    throw new Error(`Could not unpack the backup (wrong passphrase or corrupt archive?): ${err.shortMessage ?? err.message}`);
  }
  logger.info('DONE!');
}
