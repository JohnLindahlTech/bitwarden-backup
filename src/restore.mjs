import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import filenamify from 'filenamify';
import { extractArchive } from './archive.mjs';
import { createBw } from './bw.mjs';
import { ATTACHMENTS, EXPORT_FILE, FOLDERS_FILE, PERSONAL, RAW_FILE } from './constants.mjs';
import { loadCredentials } from './credentials.mjs';
import logger from './log.mjs';

const readJson = async (...p) => JSON.parse(await fs.readFile(path.join(...p), 'utf8'));

// An import gives every item a new id, so items are paired by what survives an import.
function signature(item, folderNames) {
  return JSON.stringify([
    item.type, item.name, folderNames.get(item.folderId ?? null) ?? null,
    item.login?.username ?? null, (item.login?.uris ?? []).map((u) => u.uri), item.notes ?? null,
  ]);
}

/**
 * Pairs backed-up items that have attachments with the freshly imported items. Never guesses: an item whose
 * signature is shared with another item (before or after the import) is reported as ambiguous.
 */
export function matchItems({ oldItems, oldFolders, newItems, newFolders }) {
  const nameOf = (folders) => new Map(folders.map((f) => [f.id ?? null, f.name]));
  const [oldNames, newNames] = [nameOf(oldFolders), nameOf(newFolders)];
  const count = (items, names) => items.reduce((m, i) => m.set(signature(i, names), [...(m.get(signature(i, names)) ?? []), i]), new Map());
  const oldBySig = count(oldItems, oldNames);
  const newBySig = count(newItems, newNames);

  const matched = [], ambiguous = [], missing = [];
  for (const old of oldItems.filter((i) => i.attachments?.length > 0)) {
    const sig = signature(old, oldNames);
    const [sameOld, sameNew] = [oldBySig.get(sig), newBySig.get(sig) ?? []];
    if (sameNew.length === 0) missing.push(old);
    else if (sameOld.length === 1 && sameNew.length === 1) matched.push({ old, created: sameNew[0] });
    else ambiguous.push(old);
  }
  return { matched, ambiguous, missing };
}

const attachmentFile = (dir, item, attachment) =>
  path.join(dir, PERSONAL, ATTACHMENTS, filenamify(item.name), filenamify(item.id), filenamify(attachment.id), attachment.fileName);

export async function restore(argv, deps = {}) {
  if (Boolean(argv.sourceDir) === Boolean(argv.sourceFile)) {
    throw new Error('Give exactly one of --sourceDir (an unpacked backup) or --sourceFile (a .7z backup).');
  }
  const credentials = await loadCredentials(argv.credentialsFile, [
    'clientId', 'clientSecret', 'masterPassword', ...(argv.sourceFile ? ['passphrase'] : []),
  ]);

  let dir = argv.sourceDir;
  let tempDir;
  const bwHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bwbu-bw-'));
  const bw = createBw({ credentials, appDataDir: bwHome, bin: deps.bwBin, binArgs: deps.bwBinArgs });
  let loggedIn = false;
  try {
    if (argv.sourceFile) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bwbu-restore-'));
      logger.info('Will decrypt and extract the backup into a temporary directory');
      await extractArchive({ sourceFile: argv.sourceFile, passphrase: credentials.passphrase, targetDir: tempDir }, deps);
      dir = tempDir;
    }

    const exported = await readJson(dir, PERSONAL, EXPORT_FILE);
    const oldItems = await readJson(dir, PERSONAL, RAW_FILE);
    const oldFolders = await readJson(dir, PERSONAL, FOLDERS_FILE);
    const attachmentCount = oldItems.reduce((n, i) => n + (i.attachments?.length ?? 0), 0);
    logger.info(`Backup holds ${exported.items?.length ?? 0} personal items, ${(exported.folders ?? []).length} folders and ${attachmentCount} attachments.`);

    if (!argv.apply) {
      logger.warn('DRY RUN: nothing was changed. Add --apply to restore into the target account.');
      return;
    }

    logger.info('Will log into and unlock the TARGET account');
    await bw.login();
    loggedIn = true;
    await bw.unlock();
    await bw.sync();

    const [existingItems, existingFolders] = [await bw.listItems(), await bw.listFolders()];
    const existing = existingItems.filter((i) => !i.organizationId).length + existingFolders.filter((f) => f.id).length;
    if (existing > 0 && !argv.allowNonEmpty) {
      throw new Error(`Refusing to restore: the target account is not empty (${existing} items/folders). Use an empty account, or pass --allowNonEmpty to import anyway (this can create duplicates).`);
    }

    logger.info('Will import the personal vault');
    await bw.importFile({ file: path.join(dir, PERSONAL, EXPORT_FILE) });
    await bw.sync();

    const [newItems, newFolders] = [(await bw.listItems()).filter((i) => !i.organizationId), await bw.listFolders()];
    const { matched, ambiguous, missing } = matchItems({ oldItems, oldFolders, newItems, newFolders });

    const failures = [];
    let uploaded = 0;
    for (const { old, created } of matched) {
      for (const attachment of old.attachments) {
        try {
          await bw.createAttachment({ file: attachmentFile(dir, old, attachment), itemId: created.id });
          uploaded++;
        } catch (err) {
          logger.error(`Attachment ${attachment.id} of item ${old.id} was not restored: ${err.message}`);
          failures.push(`${old.id}/${attachment.id}`);
        }
      }
    }
    logger.info(`Restored ${uploaded} of ${attachmentCount} attachments.`);

    const problems = [];
    if (ambiguous.length) problems.push(`${ambiguous.length} item(s) with attachments could not be matched safely (duplicates): ${ambiguous.map((i) => i.id).join(', ')}`);
    if (missing.length) problems.push(`${missing.length} item(s) with attachments were not found after the import: ${missing.map((i) => i.id).join(', ')}`);
    if (failures.length) problems.push(`${failures.length} attachment upload(s) failed: ${failures.join(', ')}`);
    if (problems.length) {
      throw new Error(`Restore finished incompletely. ${problems.join('. ')}. The files are still in the backup under ${PERSONAL}/${ATTACHMENTS}/.`);
    }
    logger.info('DONE!');
  } finally {
    if (loggedIn) await bw.logout().catch((err) => logger.error(err.message));
    await fs.rm(bwHome, { recursive: true, force: true });
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
}
