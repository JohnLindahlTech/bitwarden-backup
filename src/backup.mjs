import { login, exportPersonalVault, exportPersonalFiles, unlock, listPersonalVault, sync, listOrgs, exportOrgVault, listOrgVault, exportOrgFiles, listPersonalFolders, listOrgCollections} from "./bw.mjs";
import fs from 'node:fs/promises';
import path from 'node:path';
import filenamify from 'filenamify';
import { PERSONAL_ATTACHMENTS_DIR, TARGET_FILE_PREFIX, PERSONAL, EXPORT_FILE, RAW_FILE, ORGANIZATION, ATTACHMENTS, TAR_FILE_EXTENSION } from "./constants.mjs";
import logger from './log.mjs';
import { encrypt, tar } from "./tar.mjs";


async function personal(argv){
  logger.info(`Will now create: ${path.join(argv.tempDir, PERSONAL_ATTACHMENTS_DIR)}`);
  await fs.mkdir(path.join(argv.tempDir, PERSONAL_ATTACHMENTS_DIR), {recursive: true});

  logger.info(`Will natively export BW personal vault to: ${path.join(argv.tempDir, PERSONAL, EXPORT_FILE)}`)
  await exportPersonalVault(argv);
  
  logger.info(`Will list BW personal vault for further processing, will save to: ${path.join(argv.tempDir, PERSONAL, RAW_FILE)}`)
  const vault = await listPersonalVault(argv);

  logger.info(`Will store BW personal folders`);
  const folders = await listPersonalFolders(argv);
  if(argv.includeFiles){
    logger.info(`Will export personal attachments`)
    await exportPersonalFiles(vault, argv)
  } else {
    logger.info(`Did not export personal attachments, as it was not requested.`)
  }

}

async function organization(org, argv){
  await fs.mkdir(path.join(argv.tempDir, ORGANIZATION, filenamify(org.name), ATTACHMENTS), {recursive: true})
  await exportOrgVault(org, argv);
  const vault = await listOrgVault(org, argv);
  const collections = await listOrgCollections(org, argv);
  if(argv.includeFiles){
    logger.info(`Will export org (${org.name}) attachments`)
    await exportOrgFiles(vault, org, argv);
  } else {
    logger.info(`Did not export org (${org.name}) attachments, as it was not requested`);
  }
}

async function organizations(argv){
  logger.info(`Will now create: ${path.join(argv.tempDir, ORGANIZATION)}`);
  await fs.mkdir(path.join(argv.tempDir, ORGANIZATION), {recursive: true});

  logger.info(`Will get Org info`)
  const orgs = await listOrgs(argv);
  for(const org of orgs){
    await organization(org, argv)
  }

}


export async function backup(argv){
  let error;

  const time = new Date();
  const _fileFormatedTime = time.toISOString().replaceAll(/[\.:]/g, '-')
  const _tFileName = `${TARGET_FILE_PREFIX}-${_fileFormatedTime}${TAR_FILE_EXTENSION}`;
  const targetFile = path.join(argv.backupDir, _tFileName);
  try{
    if(argv.ensureFresh){
      logger.info(`Will now remove: ${argv.tempDir}`);
      await fs.rm(path.join(argv.tempDir /*, '*' */), {recursive: true, force: true, });
    } else {
      logger.info(`Did not clean out temp dir, as it was not requested.`)
    }
    if(argv.includePersonal || argv.includeOrg){
      if(argv.bwSession){
        logger.info(`Got BW_SESSION token, will not login etc.`);
      } else {
        logger.info(`Will log into BW.`)
        await login(argv);
      
        logger.info(`Will unlock BW.`)
        const sessionToken = await unlock(argv);
        argv.bwSession = sessionToken;
      }
      logger.info(`Will sync BW vault`);
      await sync(argv);
    } else {
      logger.info(`No need to log in, unlock, sync as we will not fetch anything.`)
    }

    if(argv.includePersonal){
      await personal(argv);
    } else {
      logger.info(`Did not export Personal vault, as it was not requested.`)
    }

    if(argv.includeOrg){
      await organizations(argv);
    } else {
      logger.info(`Did not export Organization vaults, as it was not requested.`)
    }

    if(argv.archive || argv.encrypt){
      logger.info(`Will archive to: ${targetFile}`)
      await fs.mkdir(argv.backupDir, {recursive: true})
      await tar(targetFile, argv.tempDir);
    } else {
      logger.info(`Did not archive, as it was not requested.`)
    }

    if(argv.encrypt){
      logger.info(`Will encrypt archive to: ${targetFile}.7z`);
      await encrypt(targetFile, argv);
    } else {
      logger.info(`Did not encrypt, as it was not requested`)
    }

  } catch(err){
    // logger.error(err);
    error = err;
  } finally {
    
    if(argv.cleanUp){
      logger.info(`Will remove unencrypted archive: ${targetFile}`);
      try{
        await fs.rm(targetFile, {recursive: true, force: true});
      } catch (err){
        logger.error(err);
      }
      
      logger.info(`Will clean up temp directory: ${argv.tempDir}`);
      try {
        await fs.rm(path.join(argv.tempDir /*, '*' */), {recursive: true, force: true});
      } catch(err){
        logger.error(err);
      }
    } else {
      logger.info(`Will not clean up temp directory, as it was not requested.`)
    }
  }
  if(error){
    throw error
  }
  logger.info(`DONE!`)
}
