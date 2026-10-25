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

Mirroring the **personal vault** and the **organizations** (items, folders or collections, and attachments) into a Bitwarden/Vaultwarden account is repeatable, see [Restore (mirror)](#restore-mirror). The organization part has so far only been tested against a fake `bw`, not yet against a real server (see the [Roadmap](#roadmap--todo)).

## Upgrading from 1.x

The next major release has breaking changes:

| Before                                                                                                                | Now                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Secrets as env vars/flags: `BWBU_PASSPHRASE`, `BWBU_BW_MASTERPASSWORD`, `BWBU_BW_CLIENTID`, `BWBU_BW_CLIENTSECRET`    | One [credentials file](#credentials-file) (`clientId`, `clientSecret`, `masterPassword`, `passphrase`)                  |
| `BWBU_BW_SESSION` / `--bwSession` to skip login                                                                       | Removed, every run logs in, unlocks and syncs in its own throwaway `bw` state                                           |
| `bw-backup-<time>.tar.gz.7z`, `--encrypt` / `BWBU_ENCRYPT` and `--archive` / `BWBU_ARCHIVE` (debugging switches)        | `bw-backup-<time>.7z` (no tar). One switch remains: `--archive` / `BWBU_ARCHIVE` (default on), see [Direct mode](#direct-mode) |
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
| `--archive`                | `BWBU_ARCHIVE`         | `true`                                            | Create the encrypted `.7z`. Needs a `passphrase`. Turn it off only together with `--targetCredentialsFile`.                       |
| `--targetCredentialsFile`  | `BWBU_TARGET_CREDENTIALS_FILE` | none                                      | Also mirror the backup straight into this account, see [Direct mode](#direct-mode). Takes `--org`, `--removed` and `--force` like `restore`. |
| `--ensureFresh`            | `BWBU_ENSURE_FRESH`    | `true`                                            | Empty the temp dir before starting. Debugging only.                                                                               |
| `--cleanUp`                | `BWBU_CLEAN_UP`        | `true`                                            | Remove the temp dir afterwards, also after failures. Debugging only, `false` leaves plaintext behind.                             |
| `--sourceFile` (unpack)    | `BWBU_SOURCE_FILE`     | required                                          | The `.7z` backup to unpack.                                                                                                       |
| `--unpackDir` (`-u`)       | `BWBU_UNPACK_DIR`      | `/tmp/bwbu/unpack` (`/unpack`)                    | Parent directory for the unpacked backup. Plaintext, delete it when done.                                                         |
| –                          | `BWBU_SEVENZIP_BIN`    | `7z`                                              | The 7-Zip executable to use. Only needed outside the Docker image, where Homebrew installs it as `7zz`.                            |
| –                          | `LOG_LEVEL`            | `INFO`                                            | `ERROR`, `WARN`, `INFO` or `DEBUG`. Never logs secrets or vault content.                                                          |

The exit code is `0` on success and `1` on any failure (including a single attachment that could not be downloaded), so cron can alert on it.

### Direct mode

Instead of (or as well as) writing an archive, a backup can go straight into another vault. Give the credentials of the target account (the same file format as for `restore`, with `serverUrl` for a self-hosted server):

```bash
# archive AND mirror into the target
bwbu backup --credentialsFile source.json --targetCredentialsFile target.json
# mirror only: no archive is ever written, the data only exists in the temporary directory (RAM in the Docker setup)
bwbu backup --credentialsFile source.json --targetCredentialsFile target.json --no-archive
```
| Flags | Result |
| --- | --- |
| `--credentialsFile` only | the encrypted `.7z`, as always |
| plus `--targetCredentialsFile` | the `.7z` and a mirror into the target account |
| plus `--no-archive` | the mirror only. No `passphrase` is needed |
| `--no-archive` without a target | an error, there would be nowhere for the backup to go |

The mirror works exactly like [`restore`](#restore-mirror) (one way, repeatable, markers, trash) and applies right away; preview the first run with `bwbu restore`. The archive and the mirror are independent: if one fails the other still happens, and the run exits with an error. The two steps stay available on their own too: `bwbu backup` writes the archive, and `bwbu restore --sourceFile` mirrors from it later.

What to keep in mind: the target is a replica of the latest state, not a history (removed items only stay in its trash until that is purged), so keep the archive on if you want point-in-time copies. One job then holds the secrets of both accounts, which is why the target has its own credentials file. Both servers must be reachable in the same run.

### Restore (mirror)

`bwbu restore` (alias `sync`) mirrors the personal vault and the organizations of a backup into a target account, for example a local Vaultwarden. It is built to run on a schedule against a vault that **already exists**: each run adds what is new, updates what changed and leaves everything else alone.

**Use the target as a read-only replica.** The data flows one way, from the backup into the target, and the backup is the source of truth. Do your own edits in the source vault, not in the replica: a change made in the replica is not tracked, and it is overwritten when the same item changes in the source.

```bash
# 1. dry run (the default): shows the plan, changes nothing
bwbu restore --credentialsFile target.json --sourceFile bw-backup-<time>.7z
# 2. really mirror
bwbu restore --credentialsFile target.json --sourceFile bw-backup-<time>.7z --apply
```
The credentials file is the one of the **target** account (`serverUrl` for a self-hosted server). It needs a `passphrase` only when you use `--sourceFile` (the one the backup was made with). Instead you can point `--sourceDir` at an unpacked backup.

What a run does:

| In the backup | On the target |
| --- | --- |
| a new item | created |
| a changed item | updated (Bitwarden keeps the password history) |
| an unchanged item | nothing at all, no `bw` call |
| an item that is gone | moved to the target's **trash** (recoverable), never deleted. `--removed keep` leaves it |
| a gone item that returns | restored from the trash, not duplicated |
| attachments added or removed | uploaded or removed, exactly those |
| an empty personal vault | one bulk import, then the attachments |
| items the target already has that this tool did not create | left alone, and counted in the summary |

A failed upload or edit is reported at the end (exit code 1) and retried by the next run, because only what succeeded is recorded. `--force` rewrites all mirrored items.

**How it knows what is what.** Nothing is stored outside the vault. Every mirrored item carries three custom fields, so the mapping lives in the target vault itself and survives losing the machine that runs the job:

- `bwbu:v1:src`: the id of the item in the source vault,
- `bwbu:v1:fp`: a fingerprint of the source content that was written, to skip unchanged items,
- `bwbu:v1:att`: which attachments are synced (source id to target id).

Do not delete these fields. An item without them looks new and is created again (the old one stays, as an item that is not ours). Items are sent to `bw` over stdin, never as command line arguments.

**Organizations.** The `bw` CLI cannot create an organization, so the target organization must already exist (create it in the web vault). Each backed-up organization is mirrored into one target organization, chosen in this order, and **never guessed**:

1. `--org <backed-up org id>=<target org id>` (repeatable) always wins,
2. otherwise the target organization that already holds items mirrored from it (the markers above), so later runs need no flags,
3. otherwise a unique name match (exactly one backed-up and one target organization with that name).

Anything else, for example two organizations with the same name on a first run, is reported as `Organization "<name>" (<id>) was NOT mirrored: <reason>`, with a summary at the end, and the run still succeeds. Add the `--org` flag it asks for. You need to be owner or admin of the target organization. Collections are matched by name and created when missing (never deleted), items are moved between collections when they moved in the source, and attachments, trash and repeat runs behave as for the personal vault. Organization items are created one at a time (about 4 seconds each) and not bulk imported, because Bitwarden's import creates a second collection when one with the same name exists. Use `--no-includeOrg` or `--no-includePersonal` to mirror only one of the two.

Limits: folders are matched by name and never deleted; passkeys are not restored; creation and revision dates are set by the target.

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
- Organization mirroring needs the target organization to exist already, and members, roles, groups and collection permissions are not recreated.

## Local Vaultwarden playground

For practicing backups (and later restores) without touching a real account: `npm run playground` starts a throwaway Vaultwarden from [`compose.vaultwarden.yaml`](compose.vaultwarden.yaml) and registers two test users. **This is a test environment, not a production-ready Vaultwarden setup**: open signups, no admin panel, no mail, an unpinned image, a throwaway self-signed certificate and data in `./tmp`. Never put real passwords in it.

```bash
npm run playground                                               # certs, Vaultwarden, users a@test.local and b@test.local
docker compose -f compose.vaultwarden.yaml run --rm bwbu-test    # back up user a -> ./tmp/backup-test-a
```
To try the mirror: unpack the backup of `a` into `tmp/restore-source`, then `BWBU_APPLY=true docker compose -f compose.vaultwarden.yaml run --rm restore-test` mirrors it into `b` (leave out `BWBU_APPLY` for a dry run). Change something in `a`, back it up again and rerun it to see `b` follow. `TEST_USER=b docker compose -f compose.vaultwarden.yaml run --rm bwbu-test` backs up `b`, and `node scripts/verify-against-seed.mjs <unpacked dir> --personal-only` checks it against what was seeded.
The generated credentials (random passwords) are in `tmp/test-vw-a.json` and `tmp/test-vw-b.json`, both git-ignored.

`a@test.local` is seeded with test data: a folder, logins, a note and a card, attachments of different sizes (including a 12 byte one and an item with two), a name with odd characters, an item whose name also exists in an organization, and **two organizations with the same name** (with collections, items and attachments). What exists, with the sha256 of every attachment, is recorded in `tmp/test-vw-a.seed.json`. `b@test.local` stays empty, as a restore target. To check a backup of `a` after unpacking it: `node scripts/verify-against-seed.mjs <unpacked dir>`.

## Development

```bash
nvm use && npm ci && npm test
```

Tests use fake `bw` and `7z` executables (`testing/fixtures`), no credentials needed.

### End-to-end tests

`npm run e2e` runs the real scripts (`node src/index.mjs`) against a real, throwaway Vaultwarden, starting from a fresh `playground --reset` so every run is isolated (it destroys the playground's data in `tmp/`, nothing else). It needs Docker, and takes around 15 to 20 minutes because the `bw` CLI makes one request at a time. In order, it checks that:

1. a backup of the seeded account is complete: items, folders, both same-named organizations and every attachment byte for byte;
2. the first mirror into the empty account imports everything, and a backup of that account is identical;
3. mirroring again changes nothing;
4. an edit, a new item with an attachment, a trashed item and swapped attachments in the source all follow, and the user's own fields, TOTP and notes survive;
5. an item restored from the source's trash is restored from the target's trash and not duplicated;
6. items on the target that the tool did not create are left alone, and removals only trash mirrored items;
7. everything has converged and a further run is a no-op.

It needs 7-Zip on the host (`7z`, or `7zz` from `brew install sevenzip`; `BWBU_SEVENZIP_BIN` overrides). `npm run e2e:smoke` runs only the first three. `npm run e2e:image` runs those three through the Docker image instead, to prove the packaged environment (read-only filesystem, non-root uid, CA and secret mounts). The fast `npm test` never touches Docker or a server.

## Roadmap / TODO

- Run the organization mirror in the end-to-end tests against a real server (it is covered by unit tests with a fake `bw` only so far).
- Verify a backup after it is written (extract it and compare the counts with `items.json`).
