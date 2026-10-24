# johnlindahl/bitwarden-backup

**[Github Repo](https://github.com/johnlindahltech/bitwarden-backup)**

![GitHub Repo stars](https://img.shields.io/github/stars/johnlindahltech/bitwarden-backup)
![GitHub watchers](https://img.shields.io/github/watchers/johnlindahltech/bitwarden-backup?style=flat-square)
![GitHub forks](https://img.shields.io/github/forks/johnlindahltech/bitwarden-backup?style=flat-square)
![GitHub Workflow Status (with branch)](https://img.shields.io/github/actions/workflow/status/johnlindahltech/bitwarden-backup/build.yaml?style=flat-square)

This is a script for backing up your Bitwarden Vault in an encrypted archive.
It supports:

- Bitwarden native plain text json export of personal vault.
- Bitwarden native plain text json export of organizational vault(s).
- Downloads all attachments and adds to the archive. (Not supported by BW native export)
- Downloads the raw json from `bw list` commands to be able to map the attachments back into a restore. (Not supported by BW native export)
- Packs everything into one `.7z` file, encrypted (file names too) with 7zip AES256 encryption with your own passphrase (Remember to keep it long!). This allows for non-vendor lock in backups (vs the BW native encrypted-json backup requires you restore to the same user account).
- Decrypt and unpack a backup archive to gain access to the backed up files.

## Credentials file

All secrets live in one JSON file. Pass its path with `--credentials-file` (`-c`) or `BWBU_CREDENTIALS_FILE`. A template is in [`credentials.example.json`](credentials.example.json).

| Field            | Needed for        | Where it comes from                                                                                                                                             |
| ---------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientId`       | backup            | Personal API key: web vault -> Settings -> Security -> Keys -> View API key. Looks like `user.xxxxxxxx-...`. Use the personal key, not an organization API key. |
| `clientSecret`   | backup            | Same page as `clientId`. "Rotate API key" there invalidates a leaked key.                                                                                       |
| `masterPassword` | backup            | Your Bitwarden master password. Bitwarden requires it for unlock and export.                                                                                    |
| `passphrase`     | backup and unpack | You choose it. Encrypts the 7z archive, so make it long and random (`openssl rand -base64 32`) and store it away from the backups.                              |

### Getting the API key

1. Open the Bitwarden web vault and go to **Settings -> Security -> Keys**.
2. Click **View API key** and enter your master password.
3. Copy `client_id` (looks like `user.xxxxxxxx-...`, never changes) into `clientId` and `client_secret` into `clientSecret`. Ignore `scope` and `grant_type`.

Use this personal key. Organization API keys (`organization.` prefix) are for the Public API and cannot unlock your vault. **Rotate API key** on the same page only changes `client_secret`, the old one stops working immediately, so update the credentials file afterwards.

API key login skips MFA, and unlock only needs the master password, so unattended runs work with MFA enabled. `unpack` only reads `passphrase`, the other fields may be absent there.

### Handling rules the tool enforces

- The file must not be readable by group or others (`chmod 600` or `400`). Otherwise the tool refuses to start. In Docker, run the container as the file's owner (`user:` / `--user "$(id -u):$(id -g)"`) so it can read a private file, see `compose.example.yaml`.
- Error messages never contain the file's content or its path, and every secret is masked in `bw` errors.
- Secrets are handed to `bw` and `7z` via environment or stdin, never as command line arguments.
- Never commit the file. `credentials.json` and `*.credentials.json` are git-ignored as a safety net.

Create it with an editor and a private umask, so secrets stay out of shell history:

```bash
umask 077 && ${EDITOR:-nano} /path/to/credentials.json
```

## Run

```bash
# Backup
docker run --rm -v /path/to/creds.json:/run/secrets/bwbu.json:ro -v /tmp/backup:/backup johnlindahl/bitwarden-backup

# Unpack into /unpack/bw-backup-[DATE]/ (refuses to write into a non-empty directory)
docker run --rm -v /path/to/creds.json:/run/secrets/bwbu.json:ro -v /tmp/backup:/backup -v /tmp/unpack:/unpack \
  -e BWBU_SOURCE_FILE=/backup/bw-backup-[DATE].7z johnlindahl/bitwarden-backup unpack
```

Optional env vars: `BWBU_INCLUDE_PERSONAL`, `BWBU_INCLUDE_ORG`, `BWBU_INCLUDE_FILES` (all default `true`), `LOG_LEVEL`.

### Backup layout

```
personal/
  export.json  items.json  folders.json
  attachments/<item name>/<item id>/<attachment id>/<file>
org/
  list.json
  <org name>/<org id>/
    export.json  items.json  collections.json
    attachments/<item name>/<item id>/<attachment id>/<file>
```
Names make browsing easy, ids make every path unique (Bitwarden allows duplicate item and organization names). Names are sanitized for the file system.

### Why not Bitwarden's native zip export?

Attachments are fetched one by one (`bw get attachment`, sequentially) instead of using `bw export --format zip`:

* The zip export is refused for organizations ("Zip export not supported for organization").
* Its layout is keyed by item name (`attachments/<item name>/...`). Bitwarden allows several items with the same name, so those could collide or get mixed up. Our layout is `attachments/<item name>/<item id>/<attachment id>/`, which cannot collide.
* For the personal vault the zip was complete in testing and faster (about 7-14s vs about 4s per attachment), but one code path for personal and org vaults is easier to trust and to restore from.
* `bw list items` also returns organization items, so the personal backup filters those out to avoid backing them up twice.

A hardened Compose example (secret mount, read-only root fs, RAM-only temp dir, cron line) is in [`compose.example.yaml`](compose.example.yaml).

## Development

```bash
nvm use && npm ci && npm test
```

Tests use fake `bw` and `7z` executables (`testing/fixtures`), no credentials needed.

## Roadmap / TODO

- Restore personal vault into a (new) Bitwarden Account from Backup archive.
- Restore organizational vault(s) into a (new) Bitwarden Organization from Backup archive.
