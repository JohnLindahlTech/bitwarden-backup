# Migrating from 0.x to 1.0

Version 1.0 is a rewrite of how the tool handles your secrets and how a backup is stored. Your old `docker run` command will not work unchanged. This guide takes you from the old setup to the new one in a few minutes.

Your existing backup files stay readable, see [step 6](#6-your-old-backup-files). If something goes wrong you can go back by running the last 0.x image you used. Its tag looks like `v0.0.10`, the Tags tab on Docker Hub lists them.

## What changed

- **Secrets live in a file now**, not in environment variables or flags.
- **One encrypted file per backup**: `bw-backup-<time>.7z` (before: `bw-backup-<time>.tar.gz.7z`).
- **Organizations** are stored under `org/<name>/<id>/` (before: `org/<name>/`), and the personal vault no longer contains the items of your organizations (before, those were copied there too).
- **Unpacking** puts the files in a sub folder named after the backup, inside the unpack directory, and refuses to write into a folder that already has files.
- **The image is smaller and stricter**: no shell, and it does not run as the `node` user any more, you tell it which user to run as.
- **New, optional**: a copy of the backup can be mirrored into a second vault, for example your own Vaultwarden.

## 1. Create the credentials file

Your old settings were in `.env.docker` (or in `-e` flags). Move the four secrets into one JSON file:

| Old setting | Goes into the file as |
| --- | --- |
| `BWBU_BW_CLIENTID` | `clientId` |
| `BWBU_BW_CLIENTSECRET` | `clientSecret` |
| `BWBU_BW_MASTERPASSWORD` | `masterPassword` |
| `BWBU_PASSPHRASE` | `passphrase` (keep the same one, so old and new backups share it) |

```json
{
  "clientId": "user.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "clientSecret": "...",
  "masterPassword": "...",
  "passphrase": "..."
}
```
Add `"serverUrl": "https://vault.example.com"` if you use a self-hosted server. Create it with an editor, then make it private with `chmod 600 credentials.json`. The tool refuses a file that others can read. Delete the old `.env.docker` when you are done.

## 2. Change the command

Before:

```bash
docker run --rm --env-file .env.docker -v /tmp/backup:/backup johnlindahl/bitwarden-backup
```
After:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:size=1g,mode=1777 \
  -v /path/to/credentials.json:/run/secrets/bwbu.json:ro \
  -v /tmp/backup:/backup \
  johnlindahl/bitwarden-backup
```
- `--user` is new and **needed**: the container runs as that user, so it can read your private credentials file and write into `/tmp/backup`. Without it you will see permission errors.
- `--tmpfs /tmp` is recommended: the unencrypted working files then only exist in memory.
- Pin a version in scripts, for example `johnlindahl/bitwarden-backup:1`, so an update never surprises you.

## 3. Settings that changed

| 0.x | 1.0 |
| --- | --- |
| `BWBU_BW_CLIENTID`, `BWBU_BW_CLIENTSECRET`, `BWBU_BW_MASTERPASSWORD`, `BWBU_PASSPHRASE` | the credentials file (step 1) |
| `BWBU_BW_SESSION` / `--bwSession` | removed. Every run logs in and syncs by itself, so it never works from a stale copy of the vault |
| `BWBU_ENCRYPT`, and `BWBU_ARCHIVE` as a debugging switch | one switch, `BWBU_ARCHIVE` (default `true`): create the encrypted file. Turn it off only together with a second vault, see step 7 |
| `BWBU_INCLUDE_PERSONAL`, `BWBU_INCLUDE_ORG`, `BWBU_INCLUDE_FILES`, `BWBU_SOURCE_FILE`, `BWBU_BACKUP_DIR`, `BWBU_UNPACK_DIR`, `LOG_LEVEL` | unchanged |

## 4. Unpacking

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v /path/to/credentials.json:/run/secrets/bwbu.json:ro \
  -v /tmp/backup:/backup:ro \
  -v /tmp/unpack:/unpack \
  -e BWBU_SOURCE_FILE=/backup/bw-backup-<time>.7z \
  johnlindahl/bitwarden-backup unpack
```
The files end up in `/tmp/unpack/bw-backup-<time>/`. The credentials file only needs the `passphrase` for this. Any 7-Zip can open the file as well, you do not need the tool: `7z x bw-backup-<time>.7z`.

## 5. What a backup looks like now

```
personal/    export.json  items.json  folders.json  attachments/...
org/         list.json  skipped.json
  <org name>/<org id>/   export.json  items.json  collections.json  attachments/...
```
If a script of yours reads these files, update the organization path (it has one more level, the id) and expect the personal folder to hold personal items only.

## 6. Your old backup files

Old `bw-backup-<time>.tar.gz.7z` files still open:

```bash
7z x bw-backup-2024-01-01T00-00-00-000Z.tar.gz.7z      # asks for the passphrase, gives a .tar.gz
tar -xzf bw-backup-2024-01-01T00-00-00-000Z.tar.gz
```
The new `unpack` command also opens them, and prints this hint when what it finds is a `.tar.gz`. Inside, organizations are under `org/<name>/` and the personal folder also contains items and attachments of your organizations (that was the old behavior). Nothing needs converting, and new and old backups can sit in the same folder.

## 7. Optional: also keep a copy in a second vault

Add the credentials of the second account as another file, and give it to the run:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:size=1g,mode=1777 \
  -v /path/to/credentials.json:/run/secrets/bwbu.json:ro \
  -v /path/to/target-credentials.json:/run/secrets/target.json:ro \
  -v /tmp/backup:/backup \
  -e BWBU_TARGET_CREDENTIALS_FILE=/run/secrets/target.json \
  johnlindahl/bitwarden-backup
```
Add `-e BWBU_ARCHIVE=false` to skip the file and only keep the copy. Treat the second vault as a read-only replica. See the [full documentation](https://github.com/JohnLindahlTech/bitwarden-backup#restore-mirror) for organizations, the `restore` command for copying an existing backup file into a vault, and all other options.

## Checklist

1. Credentials file created, `chmod 600`.
2. `docker run` has `--user`, the credentials mount, and no `--env-file` with secrets.
3. A first run produced a `bw-backup-<time>.7z` and you opened it once with `unpack` or 7-Zip.
4. Cron or compose updated, and `.env.docker` deleted.
