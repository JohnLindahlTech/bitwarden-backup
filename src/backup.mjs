import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import filenamify from 'filenamify';
import { createBw } from './bw.mjs';
import { exportBlocker } from './orgmap.mjs';
import { ATTACHMENTS, COLLECTIONS_FILE, EXPORT_FILE, FOLDERS_FILE, LIST_FILE, SKIPPED_FILE, ORGANIZATION, PERSONAL, RAW_FILE, TARGET_FILE_PREFIX, ARCHIVE_FILE_EXTENSION } from './constants.mjs';
import { loadCredentials } from './credentials.mjs';
import logger from './log.mjs';
import { createArchive } from './archive.mjs';
import { restore } from './restore.mjs';

const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2));

// Downloads every attachment, keeps going on failure, and throws once at the end.
async function downloadAttachments(bw, items, { dir, orgId }) {
  const files = items.flatMap((item) =>
    (item.attachments ?? []).map((a) => ({ itemId: item.id, itemName: item.name, fileId: a.id, fileName: a.fileName })));
  const failures = [];
  for (const [index, file] of files.entries()) {
    logger.info(`Fetching file ${index + 1}/${files.length}`);
    logger.debug(`Fetching ${file.itemName} - ${file.fileName}`);
    const output = path.join(dir, filenamify(file.itemName), filenamify(file.itemId), filenamify(file.fileId), '/');
    try {
      await fs.mkdir(output, { recursive: true });
      await bw.getAttachment({ fileId: file.fileId, itemId: file.itemId, orgId, output });
    } catch (err) {
      logger.error(`Attachment ${file.fileId} on item ${file.itemId} failed: ${err.message}`);
      failures.push(`${file.itemId}/${file.fileId}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${files.length} attachment(s) failed to download: ${failures.join(', ')}`);
  }
}

// Personal vault (no orgId) and organization vaults share the same steps.
async function backupVault(bw, { dir, orgId, includeFiles, label }) {
  await fs.mkdir(path.join(dir, ATTACHMENTS), { recursive: true });

  logger.info(`Will natively export ${label} to: ${path.join(dir, EXPORT_FILE)}`);
  await bw.exportVault({ file: path.join(dir, EXPORT_FILE), orgId });

  logger.info(`Will list ${label} for further processing`);
  // `bw list items` without an org id returns org items too, but a personal export does not contain them.
  const items = (await bw.listItems({ orgId })).filter((item) => orgId || !item.organizationId);
  await writeJson(path.join(dir, RAW_FILE), items);

  if (orgId) {
    await writeJson(path.join(dir, COLLECTIONS_FILE), await bw.listOrgCollections({ orgId }));
  } else {
    await writeJson(path.join(dir, FOLDERS_FILE), await bw.listFolders());
  }

  if (includeFiles) {
    logger.info(`Will export ${label} attachments`);
    await downloadAttachments(bw, items, { dir: path.join(dir, ATTACHMENTS), orgId });
  } else {
    logger.info(`Did not export ${label} attachments, as it was not requested.`);
  }
}

// Returns the organizations that were skipped, never silently.
async function backupOrganizations(bw, argv) {
  const orgDir = path.join(argv.tempDir, ORGANIZATION);
  await fs.mkdir(orgDir, { recursive: true });

  logger.info('Will get Org info');
  const orgs = await bw.listOrgs();
  await writeJson(path.join(orgDir, LIST_FILE), orgs);
  const skipped = [];
  for (const org of orgs) {
    const reason = exportBlocker(org);
    if (reason) {
      logger.warn(`Skipping org (${org.name}), NOT backed up: ${reason}.`);
      skipped.push({ id: org.id, name: org.name, reason });
      continue;
    }
    await backupVault(bw, { dir: path.join(orgDir, filenamify(org.name), filenamify(org.id)), orgId: org.id, includeFiles: argv.includeFiles, label: `org (${org.name})` });
  }
  await writeJson(path.join(orgDir, SKIPPED_FILE), skipped);
  return skipped;
}

export async function backup(argv, { bwBin, bwBinArgs, sevenZipBin } = {}) {
  if (!argv.archive && !argv.targetCredentialsFile) {
    throw new Error('Nothing to do: the backup would go nowhere. Keep the archive, or give --targetCredentialsFile to mirror it into another vault.');
  }
  const needsBw = argv.includePersonal || argv.includeOrg;
  const credentials = await loadCredentials(argv.credentialsFile, [
    ...(needsBw ? ['clientId', 'clientSecret', 'masterPassword'] : []),
    ...(argv.archive ? ['passphrase'] : []),
  ]);

  const stamp = new Date().toISOString().replaceAll(/[.:]/g, '-');
  const targetFile = path.join(argv.backupDir, `${TARGET_FILE_PREFIX}-${stamp}${ARCHIVE_FILE_EXTENSION}`);
  const bwHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bwbu-bw-')); // isolated bw login state
  const bw = createBw({ credentials, appDataDir: bwHome, bin: bwBin, binArgs: bwBinArgs });
  let archived = false;
  let loggedIn = false;
  let skippedOrgs = [];

  try {
    if (argv.ensureFresh) {
      logger.info(`Will now remove: ${argv.tempDir}`);
      await fs.rm(argv.tempDir, { recursive: true, force: true });
    }
    await fs.mkdir(argv.tempDir, { recursive: true });

    if (needsBw) {
      logger.info('Will log into and unlock BW.');
      await bw.login(); // logging in already syncs the vault
      loggedIn = true;
      await bw.unlock();
    } else {
      logger.info('No need to log in, unlock, sync as we will not fetch anything.');
    }

    if (argv.includePersonal) {
      await backupVault(bw, { dir: path.join(argv.tempDir, PERSONAL), includeFiles: argv.includeFiles, label: 'personal vault' });
    } else {
      logger.info('Did not export Personal vault, as it was not requested.');
    }

    if (argv.includeOrg) {
      skippedOrgs = await backupOrganizations(bw, argv);
    } else {
      logger.info('Did not export Organization vaults, as it was not requested.');
    }

    // The archive and the mirror are independent: both are attempted, and a failure of one does not skip the other.
    const failures = [];
    if (argv.archive) {
      try {
        logger.info(`Will create encrypted archive: ${targetFile}`);
        await fs.mkdir(argv.backupDir, { recursive: true });
        await createArchive({ source: argv.tempDir, target: targetFile, passphrase: credentials.passphrase }, { sevenZipBin });
        archived = true;
      } catch (err) {
        logger.error(`Creating the archive failed: ${err.shortMessage ?? err.message}`);
        failures.push('the archive was not created');
      }
    } else {
      logger.info('Did not create the encrypted archive, as it was not requested.');
    }

    if (argv.targetCredentialsFile) {
      try {
        logger.info('Will now mirror the backup into the target vault');
        await restore({
          credentialsFile: argv.targetCredentialsFile, sourceDir: argv.tempDir, apply: true,
          includePersonal: argv.includePersonal, includeOrg: argv.includeOrg,
          org: argv.org, removed: argv.removed, force: argv.force,
        }, { bwBin, bwBinArgs });
      } catch (err) {
        logger.error(`Mirroring into the target vault failed: ${err.message}`);
        failures.push('the mirror into the target vault is incomplete');
      }
    }

    if (skippedOrgs.length > 0) {
      logger.warn(`WARNING: ${skippedOrgs.length} organization(s) were NOT backed up: ${skippedOrgs.map((o) => `${o.name} (${o.reason})`).join('; ')}`);
    }
    if (failures.length > 0) throw new Error(`Backup finished incompletely: ${failures.join('; ')}.`);
    logger.info('DONE!');
  } finally {
    if (loggedIn) {
      await bw.logout().catch((err) => logger.error(err.message));
    }
    await fs.rm(bwHome, { recursive: true, force: true });

    if (!archived) {
      await fs.rm(targetFile, { force: true }).catch(() => {}); // never leave a partial archive behind
    }

    if (argv.cleanUp) {
      logger.info(`Will clean up temp directory: ${argv.tempDir}`);
      await fs.rm(argv.tempDir, { recursive: true, force: true }).catch((err) => logger.error(err.message));
    } else {
      logger.info('Will not clean up temp directory, as it was not requested.');
    }
  }
}
