#!/usr/bin/env node
import dotenv from 'dotenv'
dotenv.config()
import Yargs from 'yargs/yargs';
import { backup } from './backup.mjs';
import { restore } from './restore.mjs';
import { unpack } from './unpack.mjs';

const argv = Yargs(process.argv.slice(2))
  .scriptName('bwbu')
  .usage('$0 <cmd> [args]')
  .help().alias('h', 'help')
  .env('BWBU')
  .options({
    passphrase: {
      alias: "p",
      required: true,
      describe: "Passphrase to encrypt the zip with. Prefer BWBU_PASSPHRASE environment variable."
    },
  })
  .command(
    ["backup", "$0"],
    "Backup a bitwarden vault, with organization and file attachments, into a zip encrypted backup file.",
    {
      bwSession: {
        describe: "Bitwarden Session Token, if this is provided the prior auth steps are not needed. Prefer use of BWBU_BW_SESSION environment variable.",
      },
      backupDir: {
        alias: 'b',
        describe: "Target file for the zipped backup.",
        default: "/tmp/bwbu/target"
      },
      tempDir: {
        alias: "d",
        describe: "Temporary directory for storing the data while working",
        default: "/tmp/bwbu/ws"
      },
      bwClientid: {
        alias: 'i',
        required: true,
        describe: 'Bitwarden API Client Id, for authentication. Prefer use of BWBU_BW_CLIENTID environment variable.'
      },
      bwClientsecret: {
        alias: 's',
        required: true,
        describe: 'Bitwarden API Client Secret, for authentication. Prefer use of BWBU_BW_CLIENTSECRET environment variable.'
      },
      bwMasterpassword: {
        required: true,
        describe: 'Bitwarden master password, required by Bitwarden on exports. Prefer use of BWBY_BW_MASTERPASSWORD environment variable.'
      },
      ensureFresh: {
        describe: "Indicate if temp folder should be cleaned out before starting. Used only for debugging.",
        boolean: true,
        default: true,
      },
      includePersonal: {
        describe: "Indicate if personal vault should be backed up.",
        boolean: true,
        default: true,
      },
      includeOrg: {
        alias: 'o',
        describe: "Indicate if organization vault(s) should be backed up.",
        boolean: true,
        default: true,
      },
      includeFiles: {
        alias: 'f',
        describe: 'Indicate if attachments files should be backed up.',
        boolean: true,
        default: true,
      },
      archive: {
        describe: "Indicate if target archive should be created. Used only for debugging.",
        boolean: true,
        default: true,
      },
      encrypt: {
        describe: "Indicate if target archive should be encrypted, implies archive. Used only for debugging.",
        boolean: true,
        default: true,
      },
      cleanUp: {
        describe: "Indicate if temp directory should be removed after a job well done. Used only for debugging.",
        boolean: true,
        default: true
      }
    },
    backup
  )
  .command(
    "unpack",
    "Unpacks given backup for manual access to files.",
    {
      sourceFile:{
        required: true,
        describe: "Source zip file with the backup."
      },
      unpackDir: {
        alias: 'u',
        describe: "Target file for the unzipped backup.",
        default: "/tmp/bwbu/unpack"
      },
    },
    unpack
  )
  .command(
    "restore", 
    "Restores a backup into a bitwarden account. (Not implemented)",
    {
      bwClientid: {
        alias: 'i',
        required: true,
        describe: 'API Client Id, for authentication. Prefer use of BWBU_BW_CLIENTID environment variable.'
      },
      bwClientsecret: {
        alias: 's',
        reqiured: true,
        describe: 'API Client Secret, for authentication. Prefer use of BWBU_BW_CLIENTSECRET environment variable.'
      },
      sourceFile:{
        required: true,
        describe: "Source zip file with the backup."
      },
      includeOrg: {
        alias: 'o',
        describe: "Indicate if organization vault(s) should be backed up.",
        boolean: true,
        default: true,
      },
      includeFiles: {
        alias: 'f',
        describe: 'Indicate if attachments files should be backed up.',
        boolean: true,
        default: true,
      }
    },
    restore
  )
  .argv
