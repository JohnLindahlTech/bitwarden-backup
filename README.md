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
- Runs as a hardened, distroless Docker image for `linux/amd64` and `linux/arm64`.

Scope: an offline backup of your vault in open, portable formats (plain JSON and the original attachment files, inside a standard 7z) that you can read and import without Bitwarden. It does not store Bitwarden's own formats, such as the encrypted JSON export or the CLI's local vault cache, which only work with Bitwarden.

Not implemented yet: restoring a backup into a Bitwarden/Vaultwarden account (see the [Roadmap](#roadmap--todo)).

## Upgrading from 1.x

The next major release has breaking changes:

| Before                                                                                                                | Now                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Secrets as env vars/flags: `BWBU_PASSPHRASE`, `BWBU_BW_MASTERPASSWORD`, `BWBU_BW_CLIENTID`, `BWBU_BW_CLIENTSECRET`    | One [credentials file](#credentials-file) (`clientId`, `clientSecret`, `masterPassword`, `passphrase`)                  |
| `BWBU_BW_SESSION` / `--bwSession` to skip login                                                                       | Removed, every run logs in, unlocks and syncs in its own throwaway `bw` state                                           |
| `bw-backup-<time>.tar.gz.7z`, `--archive` / `BWBU_ARCHIVE`                                                            | `bw-backup-<time>.7z` (no tar), the archive flag is gone                                                                |
| `org/<org name>/…`                                                                                                    | `org/<org name>/<org id>/…`                                                                                             |
| Organization items and their attachments were also written to `personal/`                                             | `personal/` only holds personal items                                                                                   |
| `unpack` decrypted a `.tar.gz` into the unpack dir, then untarred it, with no overwrite check                          | `unpack` extracts straight into `<unpackDir>/<backup name>/` and refuses a non-empty directory                         |
| Alpine image with a shell, ran as `node`                                                                              | Distroless image (no shell), runs as the uid you give it, see [`compose.example.yaml`](compose.example.yaml)           |

Old `.tar.gz.7z` backups still open: `unpack` (or `7zz x`) extracts the `.tar.gz` inside, then run `tar -xzf` on it. `unpack` prints that hint.

## Credentials file

All secrets live in one JSON file. Pass its path with `--credentials-file` (`-c`) or `BWBU_CREDENTIALS_FILE`. A template is in [`credentials.example.json`](credentials.example.json).

| Field            | Needed for        | Where it comes from                                                                                                                                             |
| ---------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientId`       | backup            | Personal API key: web vault -> Settings -> Security -> Keys -> View API key. Looks like `user.xxxxxxxx-...`. Use the personal key, not an organization API key. |
| `clientSecret`   | backup            | Same page as `clientId`. "Rotate API key" there invalidates a leaked key.                                                                                       |
| `masterPassword` | backup            | Your Bitwarden master password. Bitwarden requires it for unlock and export.                                                                                    |
| `serverUrl`      | optional          | Only for a self-hosted Bitwarden/Vaultwarden server, e.g. `https://vault.example.com`. Defaults to bitwarden.com. Not a secret.                                |
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

For scheduled runs use Compose, see [Scheduling](#scheduling).

### Options

Every option is a flag and an environment variable (`BWBU_` + upper snake case). Booleans accept `--no-<flag>` or `=false`. In the image the env defaults below are already set.

| Flag (short)               | Env var                | Default (image)                                   | Meaning                                                                                                                           |
| -------------------------- | ---------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--credentialsFile` (`-c`) | `BWBU_CREDENTIALS_FILE` | required (`/run/secrets/bwbu.json`)               | Path to the [credentials file](#credentials-file).                                                                                |
| `--backupDir` (`-b`)       | `BWBU_BACKUP_DIR`      | `/tmp/bwbu/target` (`/backup`)                    | Where the encrypted `.7z` is written.                                                                                             |
| `--tempDir` (`-d`)         | `BWBU_TEMP_DIR`        | `/tmp/bwbu/ws` (`/tmp/bwbu`)                      | Working directory. **Holds the plaintext vault** while running, keep it in RAM (tmpfs) or on encrypted storage.                    |
| `--includePersonal`        | `BWBU_INCLUDE_PERSONAL` | `true`                                            | Back up the personal vault.                                                                                                       |
| `--includeOrg` (`-o`)      | `BWBU_INCLUDE_ORG`     | `true`                                            | Back up all organization vaults you belong to.                                                                                    |
| `--includeFiles` (`-f`)    | `BWBU_INCLUDE_FILES`   | `true`                                            | Download attachments.                                                                                                             |
| `--encrypt`                | `BWBU_ENCRYPT`         | `true`                                            | Create the encrypted archive. Debugging only, without it nothing is archived.                                                     |
| `--ensureFresh`            | `BWBU_ENSURE_FRESH`    | `true`                                            | Empty the temp dir before starting. Debugging only.                                                                               |
| `--cleanUp`                | `BWBU_CLEAN_UP`        | `true`                                            | Remove the temp dir afterwards, also after failures. Debugging only, `false` leaves plaintext behind.                             |
| `--sourceFile` (unpack)    | `BWBU_SOURCE_FILE`     | required                                          | The `.7z` backup to unpack.                                                                                                       |
| `--unpackDir` (`-u`)       | `BWBU_UNPACK_DIR`      | `/tmp/bwbu/unpack` (`/unpack`)                    | Parent directory for the unpacked backup. Plaintext, delete it when done.                                                         |
| –                          | `LOG_LEVEL`            | `INFO`                                            | `ERROR`, `WARN`, `INFO` or `DEBUG`. Never logs secrets or vault content.                                                          |

The exit code is `0` on success and `1` on any failure (including a single attachment that could not be downloaded), so cron can alert on it.

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

## Scheduling

[`compose.example.yaml`](compose.example.yaml) is a hardened setup: the credentials as a file secret, read-only root filesystem, RAM-only `/tmp`, no capabilities, runs as a uid you choose (`BWBU_UID`/`BWBU_GID` in `.env`). Then run it from cron:

```
15 3 * * * cd /srv/bwbu && docker compose run --rm bwbu
```

On Linux you can `chown` the credentials file to a uid that has no user on the host (for example `10001`) and set `BWBU_UID=10001`, so that only the container (and root) can read it.

## Opening a backup without this tool

Any 7-Zip can open a backup, this is the point of using a standard format. With the official 7-Zip (`brew install sevenzip` gives `7zz`, Linux packages give `7zz` or `7z`):

```bash
7zz x -o./restored bw-backup-<time>.7z   # prompts for the passphrase
```

Do not pass the passphrase with `-p<passphrase>`, it ends up in shell history and the process list. The file names are encrypted too, `7zz l` also needs the passphrase.

## Security notes

- The archive holds your **whole vault as plaintext JSON** (and the attachments), protected only by the 7z AES-256 passphrase. Make it long and random, and keep a copy somewhere other than the backups, a lost passphrase means unreadable backups.
- The credentials file contains your master password, API key and that passphrase. It is the most sensitive file in the setup: keep it out of the repo and off the backup storage, private to one uid (`chmod 400`/`600`).
- Anyone who can start containers on the host (members of the `docker` group, root) can read what the container can read.
- Store the backups on **encrypted storage** (an encrypted disk or volume). It does not replace the 7z encryption but adds a layer for everything else on the disk.
- The temp directory is plaintext while a backup runs. The Compose example keeps it in RAM and it is removed afterwards even when the backup fails. If you run without tmpfs, point `BWBU_TEMP_DIR` at encrypted storage.
- API key login skips MFA, so the API key plus the master password is full access to the vault. Rotate the key in the web vault if the file ever leaks.

## Limitations

- Only organizations you can export (owner/admin, confirmed membership, enabled) are backed up. Others are **skipped with a warning** per organization and a summary before `DONE!`, listed in `org/skipped.json` inside the archive, and the backup still succeeds. An export that fails for an organization you may export fails the whole backup.
- Organization members, roles, groups, per-collection permissions and policies are not part of the export.
- Attachments are downloaded one at a time (about 4 seconds each), by design, see above.
- There is no incremental backup, every run creates a complete new archive. Prune old ones yourself.
- Restore is not implemented. The plaintext JSON inside the archive can be imported into Bitwarden or Vaultwarden by hand, but attachments are not restored by that import.

## Local Vaultwarden playground

For practicing backups (and later restores) without touching a real account: `npm run playground` starts a throwaway Vaultwarden from [`compose.vaultwarden.yaml`](compose.vaultwarden.yaml) and registers two test users. **This is a test environment, not a production-ready Vaultwarden setup**: open signups, no admin panel, no mail, an unpinned image, a throwaway self-signed certificate and data in `./tmp`. Never put real passwords in it.

```bash
npm run playground                                               # certs, Vaultwarden, users a@test.local and b@test.local
docker compose -f compose.vaultwarden.yaml run --rm bwbu-test    # back up user a -> ./tmp/backup-test
```
The generated credentials (random passwords) are in `tmp/test-vw-a.json` and `tmp/test-vw-b.json`, both git-ignored.

`a@test.local` is seeded with test data: a folder, logins, a note and a card, attachments of different sizes (including a 12 byte one and an item with two), a name with odd characters, an item whose name also exists in an organization, and **two organizations with the same name** (with collections, items and attachments). What exists, with the sha256 of every attachment, is recorded in `tmp/test-vw-a.seed.json`. `b@test.local` stays empty, as a restore target. To check a backup of `a` after unpacking it: `node scripts/verify-against-seed.mjs <unpacked dir>`.

## Development

```bash
nvm use && npm ci && npm test
```

Tests use fake `bw` and `7z` executables (`testing/fixtures`), no credentials needed.

## Roadmap / TODO

- Restore personal vault into a (new) Bitwarden or Vaultwarden account from a backup archive, including attachments.
- Restore organizational vault(s) into a (new) Bitwarden Organization from a backup archive.
- Verify a backup after it is written (extract it and compare the counts with `items.json`).
