#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { backup } from './backup.mjs';
import { restore } from './restore.mjs';
import { unpack } from './unpack.mjs';
import logger from './log.mjs';

const bool = (describe, def = true, extra = {}) => ({ describe, boolean: true, default: def, ...extra });

try {
  await yargs(hideBin(process.argv))
    .scriptName('bwbu')
    .usage('$0 <cmd> [args]')
    .help().alias('h', 'help')
    .env('BWBU')
    .options({
      credentialsFile: {
        alias: 'c',
        required: true,
        describe: 'Path to a JSON file with clientId, clientSecret, masterPassword and passphrase. Prefer BWBU_CREDENTIALS_FILE environment variable.',
      },
    })
    .command(
      ['backup', '$0'],
      'Backup a bitwarden vault, with organization and file attachments, into an encrypted 7z backup file.',
      {
        backupDir: { alias: 'b', describe: 'Target directory for the encrypted backup.', default: '/tmp/bwbu/target' },
        tempDir: { alias: 'd', describe: 'Temporary directory for storing the data while working', default: '/tmp/bwbu/ws' },
        ensureFresh: bool('Indicate if temp folder should be cleaned out before starting. Used only for debugging.'),
        includePersonal: bool('Indicate if personal vault should be backed up.'),
        includeOrg: bool('Indicate if organization vault(s) should be backed up.', true, { alias: 'o' }),
        includeFiles: bool('Indicate if attachments files should be backed up.', true, { alias: 'f' }),
        archive: bool('Indicate if target archive should be created. Used only for debugging.'),
        encrypt: bool('Indicate if target archive should be encrypted, implies archive. Used only for debugging.'),
        cleanUp: bool('Indicate if temp directory should be removed after a job well done. Used only for debugging.'),
      },
      backup,
    )
    .command(
      'unpack',
      'Decrypts and unpacks a backup into a new sub directory of the unpack dir.',
      {
        sourceFile: { required: true, describe: 'Source .tar.gz.7z file with the backup.' },
        unpackDir: { alias: 'u', describe: 'Directory to unpack into.', default: '/tmp/bwbu/unpack' },
      },
      unpack,
    )
    .command(
      'restore',
      'Restores a backup into a bitwarden account. (Not implemented)',
      { sourceFile: { required: true, describe: 'Source .tar.gz.7z file with the backup.' } },
      restore,
    )
    .strict()
    .parseAsync();
} catch (err) {
  logger.error(err.message);
  process.exitCode = 1;
}
