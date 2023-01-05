# bitwarden-backup

## Install / Dependencies
* `node@^18.12`
* `pnpm`
* `@bitwarden/cli` aka `bw`
* `tar`
* `7z`


### Run Docker

Content of .env.docker
```ini
# Backup
# The Password to the encryption of the backup, this should be very long.
BWBU_PASSPHRASE=
# Bitwarden master password, needed for unlock and export
BWBU_BW_MASTERPASSWORD=
# Bitwarden API Key Client Id
BWBU_BW_CLIENTID=
# Bitwarden API Key Client Secret
BWBU_BW_CLIENTSECRET=

# Unpack
# Path to the backed up archive, Remember the mappings in docker!
# Should probably be like: /backup/bw-backup-[DATE].tar.gz.7z
BWBU_SOURCE_FILE=
```

```bash
# Backup
docker run --rm --env-file .env.docker -v /tmp/backup:/backup bwbu

# Unpack a backup file
docker run --rm --env-file .env.docker -v /tmp/bwbu/backup:/backup -v /tmp/bwbu/unpack:/unpack bwbu unpack

```