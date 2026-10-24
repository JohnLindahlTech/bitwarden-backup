# johnlindahl/bitwarden-backup
**[Github Repo](https://github.com/johnlindahltech/bitwarden-backup)**

![GitHub Repo stars](https://img.shields.io/github/stars/johnlindahltech/bitwarden-backup)
![GitHub watchers](https://img.shields.io/github/watchers/johnlindahltech/bitwarden-backup?style=flat-square)
![GitHub forks](https://img.shields.io/github/forks/johnlindahltech/bitwarden-backup?style=flat-square)
![GitHub Workflow Status (with branch)](https://img.shields.io/github/actions/workflow/status/johnlindahltech/bitwarden-backup/build.yaml?style=flat-square)

This is a script for backing up your Bitwarden Vault in an encrypted archive.
It supports:
* Bitwarden native plain text json export of personal vault.
* Bitwarden native plain text json export of organizational vault(s).
* Downloads all attachments and adds to the archive. (Not supported by BW native export)
* Downloads the raw json from `bw list` commands to be able to map the attachments back into a restore. (Not supported by BW native export)
* Encrypts the archive with 7zip AES256 encryption with your own passphrase (Remember to keep it long!). This allows for non-vendor lock in backups (vs the BW native encrypted-json backup requires you restore to the same user account). 
* Decrypt and unpack a backup archive to gain access to the backed up files.


## Credentials

Secrets are never passed as flags or env vars. Put them in a JSON file readable only by you (`chmod 600`, the tool refuses anything group/world readable) and point to it with `--credentials-file` / `BWBU_CREDENTIALS_FILE`:

```json
{
  "clientId": "user.xxxxxxxx-...",
  "clientSecret": "...",
  "masterPassword": "...",
  "passphrase": "a very long random string used to encrypt the backup"
}
```

* `clientId` / `clientSecret`: your personal API key (web vault -> Settings -> Security -> Keys -> View API key). API key login skips MFA.
* `masterPassword`: Bitwarden requires it for unlock and export.
* `passphrase`: encrypts the 7z archive. Keep it somewhere else than the backups.

## Run

```bash
# Backup
docker run --rm -v /path/to/creds.json:/run/secrets/bwbu.json:ro -v /tmp/backup:/backup johnlindahl/bitwarden-backup

# Unpack into /unpack/bw-backup-[DATE]/ (refuses to write into a non-empty directory)
docker run --rm -v /path/to/creds.json:/run/secrets/bwbu.json:ro -v /tmp/backup:/backup -v /tmp/unpack:/unpack \
  -e BWBU_SOURCE_FILE=/backup/bw-backup-[DATE].tar.gz.7z johnlindahl/bitwarden-backup unpack
```

Optional env vars: `BWBU_INCLUDE_PERSONAL`, `BWBU_INCLUDE_ORG`, `BWBU_INCLUDE_FILES` (all default `true`), `LOG_LEVEL`.

Note: `bw export --format zip` does not support organizations, which is why attachments are fetched one by one.

## Development

```bash
nvm use && npm ci && npm test
```

Tests use fake `bw` and `7z` executables (`testing/fixtures`), no credentials needed.

## Roadmap / TODO
* Restore personal vault into a (new) Bitwarden Account from Backup archive.
* Restore organizational vault(s) into a (new) Bitwarden Organization from Backup archive.