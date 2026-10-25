# Bitwarden Backup

Makes an **encrypted backup of your Bitwarden vault**: your personal vault, your organizations and all file attachments, in one password-protected file. Optionally it also keeps a copy in a second vault, for example your own Vaultwarden.

- Works with bitwarden.com and with self-hosted Bitwarden or Vaultwarden servers.
- One file per backup, encrypted with a passphrase of your choice (7-Zip, AES-256). Even the file names inside are hidden.
- Open it with any 7-Zip, you do not need this tool or Bitwarden to read it.
- Runs on Intel/AMD and 64-bit ARM machines (Apple Silicon, recent Raspberry Pis).

Source code and full documentation: **https://github.com/JohnLindahlTech/bitwarden-backup**

## 1. Create a credentials file

The backup needs a small JSON file with four values. Create it with a text editor and make it readable by you only (`chmod 600 credentials.json`):

```json
{
  "clientId": "user.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "clientSecret": "your API key secret",
  "masterPassword": "your Bitwarden master password",
  "passphrase": "a long random phrase that protects the backup file"
}
```

| Value | Where it comes from |
| --- | --- |
| `clientId`, `clientSecret` | Bitwarden web vault, **Settings, Security, Keys, View API key**. This is the personal API key, it also works when you use two-step login. |
| `masterPassword` | Your normal master password. Bitwarden requires it to export. |
| `passphrase` | You choose it. Make it long, and keep a copy somewhere other than next to the backups. **Without it a backup cannot be opened.** |

Using a self-hosted server? Add `"serverUrl": "https://vault.example.com"`.

## 2. Run a backup

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:size=1g,mode=1777 \
  -v /path/to/credentials.json:/run/secrets/bwbu.json:ro \
  -v /path/to/backups:/backup \
  johnlindahl/bitwarden-backup
```

You get `bw-backup-<date and time>.7z` in `/path/to/backups`. A run takes a few minutes, most of it is downloading attachments.

Tips:
- `--tmpfs /tmp` keeps the unencrypted working files in memory only, they are never written to disk. Raise `size=1g` if you have very large attachments.
- `--user` makes the container run as you, so it can read your private credentials file and write the backup.
- Only want part of it? Add `-e BWBU_INCLUDE_ORG=false`, `-e BWBU_INCLUDE_PERSONAL=false` or `-e BWBU_INCLUDE_FILES=false`.
- Organizations are only included if you are their owner or admin. Others are skipped, with a warning in the log.

## 3. Run it every night

Add a line to your crontab (`crontab -e`), for example every night at 03:15:

```
15 3 * * * docker run --rm --user "$(id -u):$(id -g)" --tmpfs /tmp:size=1g,mode=1777 -v /path/to/credentials.json:/run/secrets/bwbu.json:ro -v /path/to/backups:/backup johnlindahl/bitwarden-backup
```
A failed backup exits with an error, so cron can tell you about it. Old backups are not removed, delete them yourself when you no longer need them.

## 4. Open a backup

On any computer with 7-Zip (`7z`, or `7zz` on macOS with `brew install sevenzip`):

```bash
7z x bw-backup-2026-01-01T03-15-00-000Z.7z      # asks for the passphrase
```
Or let the container do it:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v /path/to/credentials.json:/run/secrets/bwbu.json:ro \
  -v /path/to/backups:/backup:ro \
  -v /path/to/unpacked:/unpack \
  -e BWBU_SOURCE_FILE=/backup/bw-backup-2026-01-01T03-15-00-000Z.7z \
  johnlindahl/bitwarden-backup unpack
```
Inside you find `personal/` and `org/`, each with `export.json` (your items as plain JSON, importable into Bitwarden or Vaultwarden) and an `attachments/` folder with every file. **The unpacked files are not encrypted**, delete them when you are done.

## Also keep a copy in a second vault (optional)

The same run can copy everything into another account, for example a Vaultwarden you host. Create a second credentials file for that account (same format, with its `serverUrl`) and mount it:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:size=1g,mode=1777 \
  -v /path/to/credentials.json:/run/secrets/bwbu.json:ro \
  -v /path/to/target-credentials.json:/run/secrets/target.json:ro \
  -v /path/to/backups:/backup \
  -e BWBU_TARGET_CREDENTIALS_FILE=/run/secrets/target.json \
  johnlindahl/bitwarden-backup
```
- It is a one-way copy: your Bitwarden account is only read, never changed. The second vault is kept up to date on every run, adding new items, updating changed ones and moving removed ones to its trash.
- Treat that second vault as a read-only replica, and do not edit it by hand.
- Add `-e BWBU_ARCHIVE=false` to skip the backup file and only keep the copy. Nothing is then written to disk, and no passphrase is needed.
- Organizations must already exist in the second vault. If an organization cannot be matched safely (for example two with the same name), it is skipped with a clear warning and the exact setting to add.

## Updating from version 1

Version 2 no longer takes passwords from environment variables (`BWBU_PASSPHRASE`, `BWBU_BW_MASTERPASSWORD`, `BWBU_BW_CLIENTID`, `BWBU_BW_CLIENTSECRET`). Put those four values in the credentials file from step 1 instead. Backups are now named `bw-backup-<time>.7z` and are a single 7-Zip file; organizations are stored in `org/<name>/<id>/`.

## Good to know

- **Protect the credentials file.** It holds your master password. Keep it out of backups, repositories and shared folders.
- The backup contains your whole vault, protected only by the passphrase. Store backups on an encrypted disk if you can.
- Attachments are downloaded one at a time, roughly 4 seconds each.
- Organization members, roles and permissions are not part of a backup.

## Tags

`latest`, the exact version number, and the shorter `major.minor` and `major` forms. Pin a version in scripts you depend on, so an update never surprises you.
