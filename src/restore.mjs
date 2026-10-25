import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import filenamify from 'filenamify';
import { extractArchive } from './archive.mjs';
import { createBw } from './bw.mjs';
import { ATTACHMENTS, EXPORT_FILE, FOLDERS_FILE, PERSONAL, RAW_FILE } from './constants.mjs';
import { loadCredentials } from './credentials.mjs';
import logger from './log.mjs';
import { folderNames, markFieldsForImport, planSync, readMarkers, targetPayload, withAttachmentMarker, fingerprint } from './mirror.mjs';

const readJson = async (...p) => JSON.parse(await fs.readFile(path.join(...p), 'utf8'));
const attachmentFile = (dir, item, attachment) =>
  path.join(dir, PERSONAL, ATTACHMENTS, filenamify(item.name), filenamify(item.id), filenamify(attachment.id), attachment.fileName);

export function describePlan(plan) {
  const uploads = [...plan.create, ...plan.update, ...plan.restoreFromTrash].reduce((n, e) => n + e.upload.length, 0);
  const removals = [...plan.update, ...plan.restoreFromTrash].reduce((n, e) => n + e.remove.length, 0);
  const content = plan.update.filter((e) => !e.contentUnchanged).length;
  return `create ${plan.create.length}, update ${content}, unchanged ${plan.unchanged.length}, ` +
    `restore from trash ${plan.restoreFromTrash.length}, move to trash ${plan.trash.length}; ` +
    `attachments +${uploads} -${removals}; items on the target that are not ours (never touched): ${plan.unmanaged}`;
}

/**
 * Mirrors the personal vault of a backup into the account of the credentials file, one way (the backup wins).
 * Mirrored items carry marker fields (see mirror.mjs), so repeated runs only change what differs.
 */
export async function restore(argv, deps = {}) {
  if (Boolean(argv.sourceDir) === Boolean(argv.sourceFile)) {
    throw new Error('Give exactly one of --sourceDir (an unpacked backup) or --sourceFile (a .7z backup).');
  }
  if (argv.removed && !['trash', 'keep'].includes(argv.removed)) throw new Error('--removed must be "trash" or "keep".');
  const credentials = await loadCredentials(argv.credentialsFile, [
    'clientId', 'clientSecret', 'masterPassword', ...(argv.sourceFile ? ['passphrase'] : []),
  ]);

  let dir = argv.sourceDir;
  const temp = [];
  const mkTemp = async (prefix) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); temp.push(d); return d; };
  const bwHome = await mkTemp('bwbu-bw-');
  const bw = createBw({ credentials, appDataDir: bwHome, bin: deps.bwBin, binArgs: deps.bwBinArgs });
  let loggedIn = false;
  try {
    if (argv.sourceFile) {
      dir = await mkTemp('bwbu-restore-');
      logger.info('Will decrypt and extract the backup into a temporary directory');
      await extractArchive({ sourceFile: argv.sourceFile, passphrase: credentials.passphrase, targetDir: dir }, deps);
    }
    const sourceItems = await readJson(dir, PERSONAL, RAW_FILE);
    const sourceFolders = await readJson(dir, PERSONAL, FOLDERS_FILE);
    const sourceAttachments = sourceItems.reduce((n, i) => n + (i.attachments?.length ?? 0), 0);
    logger.info(`Backup holds ${sourceItems.length} personal items, ${sourceFolders.filter((f) => f.id).length} folders and ${sourceAttachments} attachments.`);

    logger.info('Will log into and unlock the TARGET account');
    await bw.login(); // logging in already syncs the vault
    loggedIn = true;
    await bw.unlock();

    const mine = (items) => items.filter((i) => !i.organizationId);
    const load = async () => {
      const [items, trashed] = [mine(await bw.listItems()), mine(await bw.listItems({ trash: true }))];
      return planSync({ sourceItems, sourceFolders, targetItems: items, targetTrashed: trashed, force: argv.force });
    };
    let plan = await load();
    logger.info(`Plan: ${describePlan(plan)}`);
    for (const d of plan.duplicates) logger.warn(`Source item ${d.source} has several mirrors on the target (${d.targets.join(', ')}), only the first is kept up to date.`);
    if (!argv.apply) {
      logger.warn('DRY RUN: nothing was changed. Add --apply to mirror the backup into the target account.');
      return;
    }

    const problems = [];
    const stats = { created: 0, updated: 0, trashed: 0, restored: 0, uploaded: 0, removed: 0 };
    const names = folderNames(sourceFolders);
    const folderIds = new Map();

    // Empty target: one bulk import, with the markers already in the file. The attachments follow in the normal loop.
    const targetEmpty = plan.unmanaged === 0 && plan.trash.length === 0 && plan.restoreFromTrash.length === 0 && plan.update.length === 0 && plan.unchanged.length === 0;
    if (targetEmpty && plan.create.length > 0 && (await bw.listFolders()).every((f) => !f.id)) {
      logger.info(`Target is empty: bulk importing ${plan.create.length} items`);
      const exported = await readJson(dir, PERSONAL, EXPORT_FILE);
      const bySource = new Map(sourceItems.map((i) => [i.id, i]));
      exported.items = exported.items.filter((i) => bySource.has(i.id)).map((i) => {
        const source = bySource.get(i.id);
        return { ...i, fields: markFieldsForImport(i.fields, source, fingerprint(source, names.get(source.folderId ?? null))) };
      });
      const file = path.join(await mkTemp('bwbu-import-'), EXPORT_FILE);
      await fs.writeFile(file, JSON.stringify(exported), { mode: 0o600 });
      await bw.importFile({ file });
      stats.created = exported.items.length;
      await bw.sync();
      plan = await load();
    }

    for (const folder of await bw.listFolders()) if (folder.id) folderIds.set(folder.name, folder.id);
    for (const folder of sourceFolders.filter((f) => f.id)) {
      if (!folderIds.has(folder.name)) folderIds.set(folder.name, (await bw.createFolder(folder.name)).id);
    }
    const folderIdOf = (entry) => (entry.folderName ? folderIds.get(entry.folderName) ?? null : null);

    async function syncAttachments(entry, current) {
      const itemId = current.id;
      let synced = readMarkers(current).attachments;
      let changed = false;
      for (const att of entry.remove) {
        try {
          await bw.deleteAttachment({ attachmentId: att.t, itemId });
          synced = synced.filter((s) => s.i !== att.i);
          stats.removed++; changed = true;
        } catch (err) { problems.push(`remove attachment ${att.t} of ${entry.item.id}: ${err.message}`); logger.error(err.message); }
      }
      for (const att of entry.upload) {
        try {
          const known = new Set((current.attachments ?? []).map((a) => a.id));
          current = await bw.createAttachment({ file: attachmentFile(dir, entry.item, att), itemId });
          const created = (current.attachments ?? []).find((a) => !known.has(a.id));
          synced = [...synced, { i: att.id, t: created.id }];
          stats.uploaded++; changed = true;
        } catch (err) { problems.push(`upload attachment ${att.id} of ${entry.item.id}: ${err.message}`); logger.error(`Attachment ${att.id} of item ${entry.item.id} was not restored: ${err.message}`); }
      }
      if (changed) await bw.editItem(itemId, withAttachmentMarker(current, synced));
    }

    const attempt = async (what, id, fn) => { try { await fn(); } catch (err) { problems.push(`${what} ${id}: ${err.message}`); logger.error(`${what} ${id} failed: ${err.message}`); } };

    for (const entry of plan.create) {
      await attempt('create item', entry.item.id, async () => {
        const created = await bw.createItem(targetPayload(entry.item, { folderId: folderIdOf(entry), fp: entry.fp }));
        stats.created++;
        await syncAttachments(entry, created);
      });
    }
    for (const entry of [...plan.restoreFromTrash, ...plan.update]) {
      await attempt('update item', entry.item.id, async () => {
        let current = entry.target;
        if (plan.restoreFromTrash.includes(entry)) { current = await bw.restoreItem(current.id); stats.restored++; }
        if (!entry.contentUnchanged || plan.restoreFromTrash.includes(entry)) {
          current = await bw.editItem(current.id, targetPayload(entry.item, { folderId: folderIdOf(entry), fp: entry.fp, attachments: readMarkers(current).attachments }));
          stats.updated++;
        }
        await syncAttachments(entry, current);
      });
    }
    if ((argv.removed ?? 'trash') === 'trash') {
      for (const target of plan.trash) await attempt('trash item', target.id, async () => { await bw.deleteItem(target.id); stats.trashed++; });
    } else if (plan.trash.length) {
      logger.warn(`${plan.trash.length} mirrored item(s) are gone from the backup but kept on the target (--removed keep).`);
    }

    logger.info(`Mirrored: ${stats.created} created, ${stats.updated} updated, ${stats.restored} restored from trash, ${stats.trashed} moved to trash; attachments +${stats.uploaded} -${stats.removed}.`);
    if (plan.unmanaged) logger.warn(`${plan.unmanaged} item(s) on the target were not created by this tool and were left alone.`);
    if (problems.length) {
      throw new Error(`Mirror finished incompletely, ${problems.length} problem(s): ${problems.join('; ')}. Running it again retries what failed.`);
    }
    logger.info('DONE!');
  } finally {
    if (loggedIn) await bw.logout().catch((err) => logger.error(err.message));
    for (const d of temp) await fs.rm(d, { recursive: true, force: true });
  }
}
