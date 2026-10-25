import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { redactor } from './credentials.mjs';
import logger from './log.mjs';

// Run bw's JS entrypoint with the current node, so no shell, `env` or PATH lookup is needed.
const BW_SCRIPT = fileURLToPath(new URL('../node_modules/@bitwarden/cli/build/bw.js', import.meta.url));
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
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
      // Download links carry signed ?token=... query strings, never let those reach logs or errors.
      const stderr = redact(err.stderr ?? '').replace(/(https?:\/\/[^\s?]+)\?\S*/g, '$1?[query removed]');
      // bw prints raw stack traces; prefer the line that names the error (FetchError, ECONNREFUSED, ...).
      const lines = stderr.split('\n').filter(Boolean);
      const firstLine = lines.find((l) => /^\s*\w*Error:/.test(l)) ?? lines.find((l) => /\bE[A-Z]{3,}\b|certificate/.test(l)) ?? lines[0] ?? redact(err.shortMessage ?? 'unknown error');
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
      // Must happen while logged out; each run starts from a fresh bw state, so it always is.
      if (credentials.serverUrl) await run(['config', 'server', credentials.serverUrl]);
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
    // format 'zip' (personal vault only) bundles the attachments, organizations only support json.
    exportVault: ({ file, orgId, format = 'json' }) =>
      run(['export', '--format', format, '--output', file, ...orgArgs(orgId)], { input: credentials.masterPassword }),

    listItems: ({ orgId, trash } = {}) => json(['list', 'items', ...(trash ? ['--trash'] : []), ...orgArgs(orgId)]),
    listFolders: () => json(['list', 'folders']),
    listOrgs: () => json(['list', 'organizations']),
    listOrgCollections: ({ orgId }) => json(['list', 'org-collections', ...orgArgs(orgId)]),
    createOrgCollection: ({ orgId, name }) =>
      json(['create', 'org-collection', ...orgArgs(orgId)], { input: encode({ organizationId: orgId, name, externalId: null, groups: [] }) }),
    // `edit item` does not move an item between collections, this does.
    editItemCollections: async ({ id, orgId, collectionIds }) => {
      await run(['edit', 'item-collections', id, ...orgArgs(orgId)], { input: encode(collectionIds) });
      return json(['get', 'item', id]);
    },

    // `format` is a bw import format name, 'bitwardenjson' is what our export.json is.
    importFile: ({ file, format = 'bitwardenjson', orgId }) => run(['import', format, file, ...orgArgs(orgId)]),

    // Items go to bw as base64 JSON on stdin, so passwords never show up in a process list. Returns the item.
    createItem: (item) => json(['create', 'item'], { input: encode(item) }),
    editItem: (id, item) => json(['edit', 'item', id], { input: encode(item) }),
    getItem: (id) => json(['get', 'item', id]),
    deleteItem: (id) => run(['delete', 'item', id]), // to the trash, not permanent
    // bw prints a plain message here, not the item, so read it back
    restoreItem: async (id) => { await run(['restore', 'item', id]); return json(['get', 'item', id]); },
    createFolder: (name) => json(['create', 'folder'], { input: encode({ name }) }),

    // Both return/affect the item, createAttachment returns it with its attachments list.
    createAttachment: ({ file, itemId }) => json(['create', 'attachment', '--file', file, '--itemid', itemId]),
    deleteAttachment: ({ attachmentId, itemId }) => run(['delete', 'attachment', attachmentId, '--itemid', itemId]),

    getAttachment: ({ fileId, itemId, orgId, output }) =>
      run(['get', 'attachment', fileId, '--itemid', itemId, '--output', output, ...orgArgs(orgId)]),
  };
}
