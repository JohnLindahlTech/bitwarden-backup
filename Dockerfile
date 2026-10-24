FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat gcompat tar p7zip
# RUN adduser -D node
USER node
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . ./

# Path (inside the container) to the credentials JSON, mount it read-only, e.g.
#   -v /path/on/host/creds.json:/run/secrets/bwbu.json:ro
# Schema: {"clientId": "", "clientSecret": "", "masterPassword": "", "passphrase": ""}
ENV BWBU_CREDENTIALS_FILE="/run/secrets/bwbu.json"

# "BWBU_SOURCE_FILE would probably be something like /backup/bw-backup-XXXX.tar.gz.7z"
ENV BWBU_SOURCE_FILE=""

ENV BWBU_TEMP_DIR="/tmp/bwbu"
ENV BWBU_BACKUP_DIR="/backup"
ENV BWBU_UNPACK_DIR="/unpack"

# VOLUME "/tmp/bwbu"
VOLUME "/backup"
VOLUME "/unpack"

# Sane defaults, mostly used for debugging
ENV LOG_LEVEL="INFO"
ENV BWBU_ENSURE_FRESH="true"
ENV BWBU_INCLUDE_PERSONAL="true"
ENV BWBU_INCLUDE_ORG="true"
ENV BWBU_INCLUDE_FILES="true"
ENV BWBU_ARCHIVE="true"
ENV BWBU_ENCRYPT="true"
ENV BWBU_CLEAN_UP="true"


ENTRYPOINT ["/app/src/index.mjs"]
CMD ["backup"]