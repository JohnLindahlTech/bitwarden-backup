FROM node:lts-alpine AS base
RUN apk add --no-cache libc6-compat gcompat tar p7zip
# RUN adduser -D node
RUN corepack enable pnpm
USER node
WORKDIR /app
COPY pnpm-lock.yaml ./
RUN pnpm fetch

COPY package.json ./
RUN pnpm install --offline

COPY . ./

# Backup & Restore
ENV BWBU_PASSPHRASE ""
ENV BWBU_BW_MASTERPASSWORD ""
ENV BWBU_BW_CLIENTID ""
ENV BWBU_BW_CLIENTSECRET ""

# Unpack
# "BWBU_SOURCE_FILE would probably be something like /backup/bw-backup-XXXX.tar.gz.7z"
ENV BWBU_SOURCE_FILE ""

ENV BWBU_TEMP_DIR "/tmp/bwbu"
ENV BWBU_BACKUP_DIR "/backup"
ENV BWBU_UNPACK_DIR "/unpack"

# VOLUME "/tmp/bwbu"
VOLUME "/backup"
VOLUME "/unpack"

# Sane defaults, mostly used for debugging
ENV LOG_LEVEL "INFO"
ENV BWBU_ENSURE_FRESH "true"
ENV BWBU_INCLUDE_PERSONAL "true"
ENV BWBU_INCLUDE_ORG "true"
ENV BWBU_INCLUDE_FILES "true"
ENV BWBU_ARCHIVE "true"
ENV BWBU_ENCRYPT "true"
ENV BWBU_CLEAN_UP "true"


ENTRYPOINT ["/app/src/index.mjs"]
CMD ["backup"]