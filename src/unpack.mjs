import fs from 'node:fs/promises';
import path from 'node:path';
import { ENCRYPT_FILE_EXTENSION, TAR_FILE_EXTENSION } from './constants.mjs';
import logger from './log.mjs';
import { decrypt, untar } from './tar.mjs';

export async function unpack(argv){
  logger.info(`Will ensure target dir: ${argv.unpackDir}`);
  await fs.mkdir(argv.unpackDir, {recursive: true});
  
  logger.info(`Will decrypt: ${argv.sourceFile}`)
  await decrypt(argv)

  const filename = path.basename(argv.sourceFile);
  const tarFile = path.join(argv.unpackDir, filename.replace(new RegExp(`${ENCRYPT_FILE_EXTENSION}$`), ''));
  const untarDir = tarFile.replace(new RegExp(`${TAR_FILE_EXTENSION}$`), '')
  
  await fs.mkdir(untarDir, {recursive: true});
  
  logger.info(`Will untar: ${tarFile} -> ${untarDir}/`);
  await untar(tarFile, untarDir);

  logger.info(`Will remove: ${tarFile}`);
  await fs.rm(tarFile);

  logger.info(`DONE!`)
}