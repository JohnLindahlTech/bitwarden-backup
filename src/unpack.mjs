import fs from 'node:fs/promises';
import path from 'node:path';
import { ARCHIVE_FILE_EXTENSION } from './constants.mjs';
import { loadCredentials } from './credentials.mjs';
import logger from './log.mjs';
import { extractArchive } from './archive.mjs';

export async function unpack(argv, deps = {}) {
  const { passphrase } = await loadCredentials(argv.credentialsFile, ['passphrase']);

  const name = path.basename(argv.sourceFile, ARCHIVE_FILE_EXTENSION);
  const targetDir = path.join(argv.unpackDir, name);

  const existing = await fs.readdir(targetDir).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
  if (existing.length > 0) {
    throw new Error(`Refusing to unpack into non-empty directory: ${targetDir}`);
  }
  await fs.mkdir(targetDir, { recursive: true });

  logger.info(`Will decrypt and extract: ${argv.sourceFile} -> ${targetDir}/`);
  try {
    await extractArchive({ sourceFile: argv.sourceFile, passphrase, targetDir }, deps);
  } catch (err) {
    await fs.rm(targetDir, { recursive: true, force: true });
    throw new Error(`Could not unpack the backup (wrong passphrase or corrupt archive?): ${err.shortMessage ?? err.message}`);
  }
  const extracted = await fs.readdir(targetDir);
  if (extracted.length === 1 && extracted[0].endsWith('.tar.gz')) {
    logger.warn(`Legacy backup: the files are inside ${extracted[0]}, extract it with: tar -xzf ${extracted[0]}`);
  }
  logger.info('DONE!');
}
