#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { backup } from './backup.mjs';
import { restore } from './restore.mjs';
import { unpack } from './unpack.mjs';
import logger from './log.mjs';

const bool = (describe, def = true, extra = {}) => ({ describe, boolean: true, default: def, ...extra });

// Options of the mirror, shared by `restore` and by `backup --targetCredentialsFile`.
const mirrorOptions = {
  org: { type: 'array', describe: 'Which target organization a backed-up one goes into: <backed-up org id>=<target org id>. Repeatable. Otherwise matched by earlier runs or a unique name.' },
  removed: { describe: 'What to do with mirrored items that are gone from the backup: "trash" (recoverable) or "keep".', default: 'trash', choices: ['trash', 'keep'] },
  force: bool('Rewrite all mirrored items, even if they did not change.', false),
};

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
      'Backup a bitwarden vault, with organization and file attachments, into a single encrypted 7z file and/or straight into another vault (--targetCredentialsFile).',
      {
        targetCredentialsFile: { describe: 'Credentials file of the account to mirror the backup into, right away (same format as for restore, serverUrl for a self-hosted server). With --no-archive nothing is written to disk but the temporary directory.' },
        backupDir: { alias: 'b', describe: 'Target directory for the encrypted backup.', default: '/tmp/bwbu/target' },
        tempDir: { alias: 'd', describe: 'Temporary directory for storing the data while working', default: '/tmp/bwbu/ws' },
        ensureFresh: bool('Indicate if temp folder should be cleaned out before starting. Used only for debugging.'),
        includePersonal: bool('Indicate if personal vault should be backed up.'),
        includeOrg: bool('Indicate if organization vault(s) should be backed up.', true, { alias: 'o' }),
        includeFiles: bool('Indicate if attachments files should be backed up.', true, { alias: 'f' }),
        archive: bool('Create the encrypted .7z archive. Needs a passphrase in the credentials file. Turn it off only together with --targetCredentialsFile.'),
        cleanUp: bool('Indicate if temp directory should be removed after a job well done. Used only for debugging.'),
        ...mirrorOptions,
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
      ['restore', 'sync'],
      'Mirrors the personal vault of a backup into the account of the credentials file (one way: the backup wins). Safe to repeat. Dry run unless --apply.',
      {
        sourceDir: { describe: 'An unpacked backup directory (containing personal/).' },
        sourceFile: { describe: 'A .7z backup. Its passphrase is read from the credentials file.' },
        apply: bool('Really change the target account. Without it only a dry run (the plan) is shown.', false),
        includePersonal: bool('Mirror the personal vault.'),
        includeOrg: bool('Mirror the organization vault(s).', true, { alias: 'o' }),
        ...mirrorOptions,
      },
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
