import { execa } from 'execa';
import filenamify from 'filenamify';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from './log.mjs';
import {PERSONAL, EXPORT_FILE, RAW_FILE, PERSONAL_ATTACHMENTS_DIR, ORGANIZATION, LIST_FILE, ATTACHMENTS, FOLDERS_FILE, COLLECTIONS_FILE} from './constants.mjs';

const ALREADY_LOGGED_IN_REGEX = /^You are already logged in as/

export function getAttachmentDirPath({attachmentsDir, itemName, itemId, fileId}){
  return path.join(attachmentsDir, filenamify(itemName), filenamify(itemId),filenamify(fileId), '/')
}

export async function login(argv){
  const cmdArgs = ["login"];
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
    }
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
  } catch (err){
    if(ALREADY_LOGGED_IN_REGEX.test(err.stderr)){
      // Already logged in, nothing to see here, lets carry on.
      return;
    }
    throw err
  }
}

export async function exportPersonalVault(argv){
  const cmdArgs = ["export", "--format", "json", "--output", path.join(argv.tempDir, PERSONAL, EXPORT_FILE)]
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_SESSION: argv.bwSession
    },
    input: argv.bwMasterpassword
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
  } catch (err){
    throw err
  }
}

export async function exportOrgVault(org, argv){
  const cmdArgs = ["export", "--format", "json", "--output", path.join(argv.tempDir, ORGANIZATION, filenamify(org.name), EXPORT_FILE), "--organizationid", org.id]
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_SESSION: argv.bwSession
    },
    input: argv.bwMasterpassword
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
  } catch (err){
    throw err
  }
}

export async function sync(argv){
  const cmdArgs = ["sync"]
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_SESSION: argv.bwSession
    },
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
  } catch (err){
    throw err
  }
}

export async function listPersonalVault(argv){
  const cmdArgs = ["list", "items"]
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_SESSION: argv.bwSession
    },
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
    const vault = await JSON.parse(stdout);
    await fs.writeFile(path.join(argv.tempDir, PERSONAL, RAW_FILE), JSON.stringify(vault, null, 2));
    return vault;
  } catch (err){
    throw err
  }
}
export async function listOrgVault(org, argv){
  const cmdArgs = ["list", "items", '--organizationid', org.id]
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_SESSION: argv.bwSession
    },
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
    const vault = await JSON.parse(stdout);
    await fs.writeFile(path.join(argv.tempDir, ORGANIZATION, filenamify(org.name), RAW_FILE), JSON.stringify(vault, null, 2));
    return vault;
  } catch (err){
    throw err
  }
}


export async function exportFile({fileId, itemId, itemName, attachmentsDir}, org, argv){
  const itemDir = getAttachmentDirPath({attachmentsDir, itemName, itemId, fileId});
  const cmdArgs = ["get", "attachment", fileId, "--itemid", itemId, "--output", itemDir]
  if (org){
    cmdArgs.push('--organizationid', org.id)
  }
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_SESSION: argv.bwSession
    }
  }
  try{
    await fs.mkdir(itemDir, {recursive: true});
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
  } catch (err){
    logger.error(err)
    // throw err
  }
}

export async function exportPersonalFiles(vault, argv){
  const itemsWithAttachments = vault.filter(item => item.attachments?.length > 0);
  const filesToFetch = itemsWithAttachments.flatMap((item) => item.attachments.map(attachment => ({itemId: item.id, itemName: item.name, fileName: attachment.fileName, fileId: attachment.id, attachmentsDir: path.join(argv.tempDir, PERSONAL_ATTACHMENTS_DIR)})))
  for (const file of filesToFetch) {
    logger.debug(`Fetching ${file.itemName} - ${file.fileName}`)
    await exportFile(file, null, argv)
  }
}


export async function exportOrgFiles(vault, org, argv){
  const itemsWithAttachments = vault.filter(item => item.attachments?.length > 0);
  const filesToFetch = itemsWithAttachments.flatMap((item) => item.attachments.map(attachment => ({itemId: item.id, itemName: item.name, fileName: attachment.fileName, fileId: attachment.id, attachmentsDir: path.join(argv.tempDir, ORGANIZATION, filenamify(org.name), ATTACHMENTS)})))
  for (const file of filesToFetch) {
    logger.debug(`Fetching ${file.itemName} - ${file.fileName}`)
    await exportFile(file, argv)
  }
}

export async function unlock(argv){
  const cmdArgs = ["unlock", "--raw", "--passwordenv", "BW_MASTERPASSWORD"]
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_MASTERPASSWORD: argv.bwMasterpassword,
    }
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
    return stdout;
  } catch (err){
    throw err
  }
}

export async function listOrgs(argv){
  const cmdArgs = ["list", "organizations"]
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_SESSION: argv.bwSession
    },
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
    const orgs = await JSON.parse(stdout);
    await fs.writeFile(path.join(argv.tempDir, ORGANIZATION, LIST_FILE), JSON.stringify(orgs, null, 2));
    return orgs;
  } catch (err){
    throw err
  }

}

export async function listPersonalFolders(argv){
  const cmdArgs = ["list", "folders"]
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_SESSION: argv.bwSession
    },
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
    const folders = await JSON.parse(stdout);
    await fs.writeFile(path.join(argv.tempDir, PERSONAL, FOLDERS_FILE), JSON.stringify(folders, null, 2));
    return folders;
  } catch (err){
    throw err
  }
}

export async function listOrgCollections(org, argv){
  const cmdArgs = ["list", "org-collections", "--organizationid", org.id]
  const execaOpts = {
    env: {
      BW_CLIENTID: argv.bwClientid,
      BW_CLIENTSECRET: argv.bwClientsecret,
      BW_SESSION: argv.bwSession
    },
  }
  try{
    const {stdout} = await execa("bw", cmdArgs, execaOpts)
    logger.debug(stdout);
    const collections = await JSON.parse(stdout);
    await fs.writeFile(path.join(argv.tempDir, ORGANIZATION, filenamify(org.name), COLLECTIONS_FILE), JSON.stringify(collections, null, 2));
    return collections;
  } catch (err){
    throw err
  }
}