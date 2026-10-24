# syntax=docker/dockerfile:1

# --- build: install production deps and fetch the pinned, statically linked 7-Zip ---
# Runs on the builder's own CPU even for multi-arch builds (no QEMU emulation): npm ci output is
# pure JS (no native modules, keep it that way) and the 7-Zip binary is only unpacked here, not run.
FROM --platform=$BUILDPLATFORM node:24 AS build
ARG TARGETARCH
# Official build from https://github.com/ip7z/7zip/releases, checksums verified below.
# To upgrade, bump the version AND both checksums (sha256 of 7z<version>-linux-<arch>.tar.xz).
ARG SEVENZIP_VERSION=26.01
ARG SEVENZIP_SHA256_AMD64=8ea0fc8a135e7b848e80a4116fe22dff56c8c4518dde1f43cce67f4e340b437a
ARG SEVENZIP_SHA256_ARM64=39f8c9070c300a63c7484d9a983119ef3edf841e1ddf69f1affae29fdec5f612

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) arch=x64;   sha="$SEVENZIP_SHA256_AMD64" ;; \
      arm64) arch=arm64; sha="$SEVENZIP_SHA256_ARM64" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    file="7z$(echo "$SEVENZIP_VERSION" | tr -d .)-linux-$arch.tar.xz"; \
    curl -fsSL -o "/tmp/$file" "https://github.com/ip7z/7zip/releases/download/$SEVENZIP_VERSION/$file"; \
    echo "$sha  /tmp/$file" | sha256sum -c -; \
    tar -xJf "/tmp/$file" -C /tmp 7zzs

# --- runtime: distroless, no shell, no package manager. Just node, the app and 7z ---
FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=build --chmod=755 /tmp/7zzs /usr/local/bin/7z

# Path (inside the container) to the credentials JSON, mount it read-only, e.g.
#   -v /path/on/host/creds.json:/run/secrets/bwbu.json:ro
# Schema: {"clientId": "", "clientSecret": "", "masterPassword": "", "passphrase": ""}
ENV BWBU_CREDENTIALS_FILE="/run/secrets/bwbu.json"

# For unpack set BWBU_SOURCE_FILE, probably something like /backup/bw-backup-XXXX.7z

ENV BWBU_TEMP_DIR="/tmp/bwbu"
ENV BWBU_BACKUP_DIR="/backup"
ENV BWBU_UNPACK_DIR="/unpack"

# Mount real directories here, the container normally runs as a non-root uid (see compose.example.yaml)
VOLUME "/backup"
VOLUME "/unpack"

# Sane defaults, mostly used for debugging
ENV LOG_LEVEL="INFO"
ENV BWBU_ENSURE_FRESH="true"
ENV BWBU_INCLUDE_PERSONAL="true"
ENV BWBU_INCLUDE_ORG="true"
ENV BWBU_INCLUDE_FILES="true"
ENV BWBU_ENCRYPT="true"
ENV BWBU_CLEAN_UP="true"

ENTRYPOINT ["/nodejs/bin/node", "/app/src/index.mjs"]
CMD ["backup"]
