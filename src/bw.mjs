import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { redactor } from './credentials.mjs';
import logger from './log.mjs';

// Run bw's JS entrypoint with the current node, so no shell, `env` or PATH lookup is needed.
const BW_SCRIPT = fileURLToPath(new URL('../node_modules/@bitwarden/cli/build/bw.js', import.meta.url));
const ALREADY_LOGGED_IN_REGEX = /You are already logged in as/;

/**
 * Thin wrapper around the `bw` CLI. Secrets only travel via the child's env or stdin,
 * never argv. Errors are redacted, and stdout (the vault!) is never logged.
 */
export function createBw({ credentials, appDataDir, bin = process.execPath, binArgs = bin === process.execPath ? [BW_SCRIPT] : [] }) {
  let session;
  let redact = redactor(credentials);

  async function run(args, { input, env } = {}) {
    logger.debug(`bw ${args.slice(0, 2).join(' ')}`);
    try {
      const { stdout } = await execa(bin, [...binArgs, ...args], {
        env: {
          ...(appDataDir && { BITWARDENCLI_APPDATA_DIR: appDataDir }),
          BW_CLIENTID: credentials.clientId,
          BW_CLIENTSECRET: credentials.clientSecret,
          ...(session && { BW_SESSION: session }),
          ...env,
        },
        input,
      });
      return stdout;
    } catch (err) {
      const stderr = redact(err.stderr ?? '');
      const firstLine = stderr.split('\n').find(Boolean) ?? redact(err.shortMessage ?? 'unknown error');
      throw Object.assign(new Error(`bw ${args[0]} failed (exit ${err.exitCode ?? '?'}): ${firstLine.slice(0, 300)}`), { stderr });
    }
  }

  async function json(args, opts) {
    const stdout = await run(args, opts);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`bw ${args.slice(0, 2).join(' ')} returned invalid JSON`);
    }
  }

  const orgArgs = (orgId) => (orgId ? ['--organizationid', orgId] : []);

  return {
    async login() {
      try {
        await run(['login', '--apikey']);
      } catch (err) {
        if (!ALREADY_LOGGED_IN_REGEX.test(err.stderr)) throw err;
      }
    },

    async unlock() {
      const stdout = await run(['unlock', '--raw', '--passwordenv', 'BW_PASSWORD'], {
        env: { BW_PASSWORD: credentials.masterPassword },
      });
      session = stdout.trim();
      redact = redactor({ ...credentials, session });
    },

    async logout() {
      session = undefined;
      await run(['logout']);
    },

    sync: () => run(['sync']),

    // Bitwarden re-checks the master password on export, read from stdin.
    exportVault: ({ file, orgId }) =>
      run(['export', '--format', 'json', '--output', file, ...orgArgs(orgId)], { input: credentials.masterPassword }),

    listItems: ({ orgId } = {}) => json(['list', 'items', ...orgArgs(orgId)]),
    listFolders: () => json(['list', 'folders']),
    listOrgs: () => json(['list', 'organizations']),
    listOrgCollections: ({ orgId }) => json(['list', 'org-collections', ...orgArgs(orgId)]),

    getAttachment: ({ fileId, itemId, orgId, output }) =>
      run(['get', 'attachment', fileId, '--itemid', itemId, '--output', output, ...orgArgs(orgId)]),
  };
}
