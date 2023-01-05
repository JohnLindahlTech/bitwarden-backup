import path from 'node:path';

export const EXPORT_FILE="export.json";
export const RAW_FILE="items.json";
export const LIST_FILE="list.json";
export const FOLDERS_FILE="folders.json";
export const COLLECTIONS_FILE="collections.json";
export const ATTACHMENTS='attachments';
export const PERSONAL='personal';
export const ORGANIZATION='org';
export const TARGET_FILE_PREFIX = 'bw-backup';
export const TAR_FILE_EXTENSION = '.tar.gz';
export const ENCRYPT_FILE_EXTENSION = '.7z';

export const PERSONAL_ATTACHMENTS_DIR=path.join(PERSONAL, ATTACHMENTS);
export const ORG_ATTACHMENTS_DIR=path.join(ORGANIZATION, ATTACHMENTS);