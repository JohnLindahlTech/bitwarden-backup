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
      'Backup a bitwarden vault, with organization and file attachments, into a single encrypted 7z file.',
      {
        backupDir: { alias: 'b', describe: 'Target directory for the encrypted backup.', default: '/tmp/bwbu/target' },
        tempDir: { alias: 'd', describe: 'Temporary directory for storing the data while working', default: '/tmp/bwbu/ws' },
        ensureFresh: bool('Indicate if temp folder should be cleaned out before starting. Used only for debugging.'),
        includePersonal: bool('Indicate if personal vault should be backed up.'),
        includeOrg: bool('Indicate if organization vault(s) should be backed up.', true, { alias: 'o' }),
        includeFiles: bool('Indicate if attachments files should be backed up.', true, { alias: 'f' }),
        encrypt: bool('Indicate if the encrypted archive should be created. Disable only for debugging, the plaintext stays in tempDir.'),
        cleanUp: bool('Indicate if temp directory should be removed after a job well done. Used only for debugging.'),
      },
      backup,
    )
    .command(
      'unpack',
      'Decrypts and unpacks a backup into a new sub directory of the unpack dir.',
      {
        sourceFile: { required: true, describe: 'Source .7z file with the backup.' },
        unpackDir: { alias: 'u', describe: 'Directory to unpack into.', default: '/tmp/bwbu/unpack' },
      },
      unpack,
    )
    .command(
      'restore',
      'Restores a backup into a bitwarden account. (Not implemented)',
      { sourceFile: { required: true, describe: 'Source .7z file with the backup.' } },
      restore,
    )
    // Not .strict(): the image sets env vars for every command (BWBU_SOURCE_FILE etc.), which would be
    // rejected as unknown arguments by the other commands.
    .strictCommands()
    .fail(false) // let errors reach the catch below: one log line, no help dump or stack trace
    .parseAsync();
} catch (err) {
  logger.error(err.message);
  process.exitCode = 1;
}
