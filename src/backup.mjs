import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import filenamify from 'filenamify';
import { createBw } from './bw.mjs';
import { ATTACHMENTS, COLLECTIONS_FILE, EXPORT_FILE, FOLDERS_FILE, LIST_FILE, ORGANIZATION, PERSONAL, RAW_FILE, TARGET_FILE_PREFIX, TAR_FILE_EXTENSION } from './constants.mjs';
import { loadCredentials } from './credentials.mjs';
import logger from './log.mjs';
import { encrypt, tar } from './tar.mjs';

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
  const items = await bw.listItems({ orgId });
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

async function backupOrganizations(bw, argv) {
  const orgDir = path.join(argv.tempDir, ORGANIZATION);
  await fs.mkdir(orgDir, { recursive: true });

  logger.info('Will get Org info');
  const orgs = await bw.listOrgs();
  await writeJson(path.join(orgDir, LIST_FILE), orgs);
  for (const org of orgs) {
    await backupVault(bw, { dir: path.join(orgDir, filenamify(org.name)), orgId: org.id, includeFiles: argv.includeFiles, label: `org (${org.name})` });
  }
}

export async function backup(argv, { bwBin, tarBin, sevenZipBin } = {}) {
  const needsBw = argv.includePersonal || argv.includeOrg;
  const credentials = await loadCredentials(argv.credentialsFile, [
    ...(needsBw ? ['clientId', 'clientSecret', 'masterPassword'] : []),
    ...(argv.encrypt ? ['passphrase'] : []),
  ]);

  const stamp = new Date().toISOString().replaceAll(/[.:]/g, '-');
  const targetFile = path.join(argv.backupDir, `${TARGET_FILE_PREFIX}-${stamp}${TAR_FILE_EXTENSION}`);
  const bwHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bwbu-bw-')); // isolated bw login state
  const bw = createBw({ credentials, appDataDir: bwHome, bin: bwBin });
  let encrypted = false;

  try {
    if (argv.ensureFresh) {
      logger.info(`Will now remove: ${argv.tempDir}`);
      await fs.rm(argv.tempDir, { recursive: true, force: true });
    }

    if (needsBw) {
      logger.info('Will log into, unlock and sync BW.');
      await bw.login();
      await bw.unlock();
      await bw.sync();
    } else {
      logger.info('No need to log in, unlock, sync as we will not fetch anything.');
    }

    if (argv.includePersonal) {
      await backupVault(bw, { dir: path.join(argv.tempDir, PERSONAL), includeFiles: argv.includeFiles, label: 'personal vault' });
    } else {
      logger.info('Did not export Personal vault, as it was not requested.');
    }

    if (argv.includeOrg) {
      await backupOrganizations(bw, argv);
    } else {
      logger.info('Did not export Organization vaults, as it was not requested.');
    }

    if (argv.archive || argv.encrypt) {
      logger.info(`Will archive to: ${targetFile}`);
      await fs.mkdir(argv.backupDir, { recursive: true });
      await tar(targetFile, argv.tempDir, { tarBin });
    }

    if (argv.encrypt) {
      logger.info(`Will encrypt archive to: ${targetFile}.7z`);
      await encrypt(targetFile, credentials.passphrase, { sevenZipBin });
      encrypted = true;
    }
    logger.info('DONE!');
  } finally {
    if (needsBw) {
      await bw.logout().catch((err) => logger.error(err.message));
    }
    await fs.rm(bwHome, { recursive: true, force: true });

    if (argv.cleanUp) {
      if (encrypted) {
        logger.info(`Will remove unencrypted archive: ${targetFile}`);
        await fs.rm(targetFile, { force: true }).catch((err) => logger.error(err.message));
      }
      logger.info(`Will clean up temp directory: ${argv.tempDir}`);
      await fs.rm(argv.tempDir, { recursive: true, force: true }).catch((err) => logger.error(err.message));
    } else {
      logger.info('Will not clean up temp directory, as it was not requested.');
    }
  }
}
