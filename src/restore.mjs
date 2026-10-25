import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import filenamify from 'filenamify';
import { extractArchive } from './archive.mjs';
import { createBw } from './bw.mjs';
import { ATTACHMENTS, COLLECTIONS_FILE, EXPORT_FILE, FOLDERS_FILE, LIST_FILE, ORGANIZATION, PERSONAL, RAW_FILE, SKIPPED_FILE } from './constants.mjs';
import { loadCredentials } from './credentials.mjs';
import logger from './log.mjs';
import { fingerprint, folderNames, markFieldsForImport, planSync, readMarkers, targetPayload, withAttachmentMarker } from './mirror.mjs';
import { resolveOrgMapping } from './orgmap.mjs';

const readJson = async (...p) => JSON.parse(await fs.readFile(path.join(...p), 'utf8'));
const readJsonOr = async (fallback, ...p) => readJson(...p).catch(() => fallback);
const attachmentFile = (scopeDir, item, attachment) =>
  path.join(scopeDir, ATTACHMENTS, filenamify(item.name), filenamify(item.id), filenamify(attachment.id), attachment.fileName);

export function describePlan(plan) {
  const uploads = [...plan.create, ...plan.update, ...plan.restoreFromTrash].reduce((n, e) => n + e.upload.length, 0);
  const removals = [...plan.update, ...plan.restoreFromTrash].reduce((n, e) => n + e.remove.length, 0);
  const content = plan.update.filter((e) => !e.contentUnchanged).length;
  return `create ${plan.create.length}, update ${content}, unchanged ${plan.unchanged.length}, ` +
    `restore from trash ${plan.restoreFromTrash.length}, move to trash ${plan.trash.length}; ` +
    `attachments +${uploads} -${removals}; items on the target that are not ours (never touched): ${plan.unmanaged}`;
}

const newStats = () => ({ created: 0, updated: 0, trashed: 0, restored: 0, uploaded: 0, removed: 0 });

/**
 * Mirrors one vault (the personal vault, or one organization) of the backup into the target, one way. Items carry
 * marker fields (see mirror.mjs), so repeated runs only change what differs.
 *  scope: { label, orgId?, dir, items, placementOf(item), prepare() -> placement(entry) -> payload fields, bulkImport? }
 */
async function mirrorScope(ctx, scope) {
  const { bw, argv, problems } = ctx;
  const stats = newStats();
  const orgId = scope.orgId;
  const live = async () => {
    const mine = (items) => (orgId ? items : items.filter((i) => !i.organizationId));
    return planSync({
      sourceItems: scope.items, placementOf: scope.placementOf, force: argv.force,
      targetItems: mine(await bw.listItems({ orgId })), targetTrashed: mine(await bw.listItems({ orgId, trash: true })),
    });
  };
  let plan = await live();
  logger.info(`${scope.label}: ${describePlan(plan)}`);
  for (const d of plan.duplicates) logger.warn(`${scope.label}: source item ${d.source} has several mirrors on the target (${d.targets.join(', ')}), only the first is kept up to date.`);
  if (!argv.apply) return { stats, plan };

  // Empty personal vault: one bulk import, with the markers already in the file. The attachments follow in the normal loop.
  const empty = plan.unmanaged === 0 && plan.trash.length === 0 && plan.restoreFromTrash.length === 0 && plan.update.length === 0 && plan.unchanged.length === 0;
  if (scope.bulkImport && empty && plan.create.length > 0 && (await bw.listFolders()).every((f) => !f.id)) {
    logger.info(`${scope.label}: target is empty, bulk importing ${plan.create.length} items`);
    const exported = await readJson(scope.dir, EXPORT_FILE);
    const bySource = new Map(scope.items.map((i) => [i.id, i]));
    exported.items = exported.items.filter((i) => bySource.has(i.id)).map((i) => {
      const source = bySource.get(i.id);
      return { ...i, fields: markFieldsForImport(i.fields, source, fingerprint(source, scope.placementOf(source))) };
    });
    const file = path.join(await ctx.mkTemp('bwbu-import-'), EXPORT_FILE);
    await fs.writeFile(file, JSON.stringify(exported), { mode: 0o600 });
    await bw.importFile({ file });
    stats.created = exported.items.length;
    await bw.sync();
    plan = await live();
  }

  const placementFields = await scope.prepare();
  const attempt = async (what, id, fn) => { try { await fn(); } catch (err) { problems.push(`${scope.label}: ${what} ${id}: ${err.message}`); logger.error(`${scope.label}: ${what} ${id} failed: ${err.message}`); } };

  async function syncAttachments(entry, current) {
    const itemId = current.id;
    let synced = readMarkers(current).attachments;
    let changed = false;
    for (const att of entry.remove) {
      try {
        await bw.deleteAttachment({ attachmentId: att.t, itemId });
        synced = synced.filter((s) => s.i !== att.i);
        stats.removed++; changed = true;
      } catch (err) { problems.push(`${scope.label}: remove attachment ${att.t} of ${entry.item.id}: ${err.message}`); logger.error(err.message); }
    }
    for (const att of entry.upload) {
      try {
        const known = new Set((current.attachments ?? []).map((a) => a.id));
        current = await bw.createAttachment({ file: attachmentFile(scope.dir, entry.item, att), itemId });
        const created = (current.attachments ?? []).find((a) => !known.has(a.id));
        synced = [...synced, { i: att.id, t: created.id }];
        stats.uploaded++; changed = true;
      } catch (err) { problems.push(`${scope.label}: upload attachment ${att.id} of ${entry.item.id}: ${err.message}`); logger.error(`${scope.label}: attachment ${att.id} of item ${entry.item.id} was not restored: ${err.message}`); }
    }
    if (changed) await bw.editItem(itemId, withAttachmentMarker(current, synced));
  }

  for (const entry of plan.create) {
    await attempt('create item', entry.item.id, async () => {
      const created = await bw.createItem(targetPayload(entry.item, { ...placementFields(entry), fp: entry.fp }));
      stats.created++;
      await syncAttachments(entry, created);
    });
  }
  for (const entry of [...plan.restoreFromTrash, ...plan.update]) {
    await attempt('update item', entry.item.id, async () => {
      const restoring = plan.restoreFromTrash.includes(entry);
      let current = entry.target;
      if (restoring) { current = await bw.restoreItem(current.id); stats.restored++; }
      if (!entry.contentUnchanged || restoring) {
        const fields = placementFields(entry);
        current = await bw.editItem(current.id, targetPayload(entry.item, { ...fields, fp: entry.fp, attachments: readMarkers(current).attachments }));
        // `edit item` does not move an organization item between collections, so compare with the item as it was before
        const [have, want] = [[...(entry.target.collectionIds ?? [])].sort(), [...(fields.collectionIds ?? [])].sort()];
        if (orgId && have.join() !== want.join()) current = { ...current, ...(await bw.editItemCollections({ id: current.id, orgId, collectionIds: want })), collectionIds: want };
        stats.updated++;
      }
      await syncAttachments(entry, current);
    });
  }
  if ((argv.removed ?? 'trash') === 'trash') {
    for (const target of plan.trash) await attempt('trash item', target.id, async () => { await bw.deleteItem(target.id); stats.trashed++; });
  } else if (plan.trash.length) {
    logger.warn(`${scope.label}: ${plan.trash.length} mirrored item(s) are gone from the backup but kept on the target (--removed keep).`);
  }
  logger.info(`${scope.label}: ${stats.created} created, ${stats.updated} updated, ${stats.restored} restored from trash, ${stats.trashed} moved to trash; attachments +${stats.uploaded} -${stats.removed}.`);
  if (plan.unmanaged) logger.warn(`${scope.label}: ${plan.unmanaged} item(s) on the target were not created by this tool and were left alone.`);
  return { stats, plan };
}

const parseOrgFlags = (list = []) => Object.fromEntries([].concat(list).map((pair) => {
  const [source, target] = String(pair).split('=');
  if (!source || !target) throw new Error(`--org expects <backed-up org id>=<target org id>, got "${pair}".`);
  return [source, target];
}));

export async function restore(argv, deps = {}) {
  if (Boolean(argv.sourceDir) === Boolean(argv.sourceFile)) {
    throw new Error('Give exactly one of --sourceDir (an unpacked backup) or --sourceFile (a .7z backup).');
  }
  if (argv.removed && !['trash', 'keep'].includes(argv.removed)) throw new Error('--removed must be "trash" or "keep".');
  const explicitOrgs = parseOrgFlags(argv.org);
  const credentials = await loadCredentials(argv.credentialsFile, [
    'clientId', 'clientSecret', 'masterPassword', ...(argv.sourceFile ? ['passphrase'] : []),
  ]);

  let dir = argv.sourceDir;
  const temp = [];
  const mkTemp = async (prefix) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); temp.push(d); return d; };
  const bwHome = await mkTemp('bwbu-bw-');
  const bw = createBw({ credentials, appDataDir: bwHome, bin: deps.bwBin, binArgs: deps.bwBinArgs });
  const problems = [];
  const ctx = { bw, argv, problems, mkTemp };
  const totals = newStats();
  const add = (s) => { for (const k of Object.keys(totals)) totals[k] += s[k]; };
  let loggedIn = false;
  try {
    if (argv.sourceFile) {
      dir = await mkTemp('bwbu-restore-');
      logger.info('Will decrypt and extract the backup into a temporary directory');
      await extractArchive({ sourceFile: argv.sourceFile, passphrase: credentials.passphrase, targetDir: dir }, deps);
    }

    logger.info('Will log into and unlock the TARGET account');
    await bw.login(); // logging in already syncs the vault
    loggedIn = true;
    await bw.unlock();

    if (argv.includePersonal !== false) {
      const personalDir = path.join(dir, PERSONAL);
      const items = await readJson(personalDir, RAW_FILE);
      const folders = await readJson(personalDir, FOLDERS_FILE);
      logger.info(`Backup holds ${items.length} personal items, ${folders.filter((f) => f.id).length} folders and ${items.reduce((n, i) => n + (i.attachments?.length ?? 0), 0)} attachments.`);
      const names = folderNames(folders);
      const folderIds = new Map();
      add((await mirrorScope(ctx, {
        label: 'personal vault', dir: personalDir, items, bulkImport: true,
        placementOf: (item) => names.get(item.folderId ?? null) ?? null,
        async prepare() {
          for (const f of await bw.listFolders()) if (f.id) folderIds.set(f.name, f.id);
          for (const f of folders.filter((x) => x.id)) if (!folderIds.has(f.name)) folderIds.set(f.name, (await bw.createFolder(f.name)).id);
          return (entry) => ({ folderId: entry.placement ? folderIds.get(entry.placement) ?? null : null });
        },
      })).stats);
    }

    const notMirrored = [];
    if (argv.includeOrg !== false) {
      const sourceOrgs = [];
      const skipped = new Set((await readJsonOr([], dir, ORGANIZATION, SKIPPED_FILE)).map((o) => o.id));
      for (const org of await readJsonOr([], dir, ORGANIZATION, LIST_FILE)) {
        const orgDir = path.join(dir, ORGANIZATION, filenamify(org.name), filenamify(org.id));
        if (skipped.has(org.id) || !(await fs.stat(orgDir).then(() => true, () => false))) continue;
        const items = await readJson(orgDir, RAW_FILE);
        sourceOrgs.push({ id: org.id, name: org.name, dir: orgDir, items, itemIds: new Set(items.map((i) => i.id)) });
      }
      if (sourceOrgs.length) {
        const targetOrgs = await bw.listOrgs();
        const markedSources = new Map();
        for (const t of targetOrgs) {
          const found = new Set();
          try { for (const item of [...await bw.listItems({ orgId: t.id }), ...await bw.listItems({ orgId: t.id, trash: true })]) { const { src } = readMarkers(item); if (src) found.add(src); } } catch { /* not readable for us: not a candidate */ }
          markedSources.set(t.id, found);
        }
        const { mapping, unmapped } = resolveOrgMapping({ sourceOrgs, targetOrgs, explicit: explicitOrgs, markedSources });
        for (const { org, reason } of unmapped) {
          logger.warn(`Organization "${org.name}" (${org.id}) was NOT mirrored: ${reason}.`);
          notMirrored.push(`${org.name} (${org.id})`);
        }
        for (const org of sourceOrgs.filter((o) => mapping.has(o.id))) {
          const target = mapping.get(org.id);
          const collections = await readJson(org.dir, COLLECTIONS_FILE);
          const collectionNames = new Map(collections.map((c) => [c.id, c.name]));
          const collectionIds = new Map();
          logger.info(`Organization "${org.name}" (${org.id}) -> target organization ${target.id}`);
          add((await mirrorScope(ctx, {
            label: `org "${org.name}"`, orgId: target.id, dir: org.dir, items: org.items,
            placementOf: (item) => (item.collectionIds ?? []).map((id) => collectionNames.get(id)).filter(Boolean).sort(),
            async prepare() {
              for (const c of await bw.listOrgCollections({ orgId: target.id })) collectionIds.set(c.name, c.id);
              for (const c of collections) if (!collectionIds.has(c.name)) collectionIds.set(c.name, (await bw.createOrgCollection({ orgId: target.id, name: c.name })).id);
              return (entry) => ({ organizationId: target.id, collectionIds: entry.placement.map((name) => collectionIds.get(name)).filter(Boolean) });
            },
          })).stats);
        }
      }
    }

    if (!argv.apply) {
      logger.warn('DRY RUN: nothing was changed. Add --apply to mirror the backup into the target account.');
      return;
    }
    logger.info(`Mirrored: ${totals.created} created, ${totals.updated} updated, ${totals.restored} restored from trash, ${totals.trashed} moved to trash; attachments +${totals.uploaded} -${totals.removed}.`);
    if (notMirrored.length) logger.warn(`WARNING: ${notMirrored.length} organization(s) were NOT mirrored: ${notMirrored.join('; ')}`);
    if (problems.length) {
      throw new Error(`Mirror finished incompletely, ${problems.length} problem(s): ${problems.join('; ')}. Running it again retries what failed.`);
    }
    logger.info('DONE!');
  } finally {
    if (loggedIn) await bw.logout().catch((err) => logger.error(err.message));
    for (const d of temp) await fs.rm(d, { recursive: true, force: true });
  }
}
