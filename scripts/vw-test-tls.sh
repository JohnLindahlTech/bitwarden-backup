#!/bin/sh
# Creates a throwaway CA and a server certificate for the local Vaultwarden playground (tmp/vw-tls/).
# Bitwarden clients refuse plain http server URLs, so the playground needs https.
# Valid names: localhost, vaultwarden (the compose service name), 127.0.0.1. Test use only.
set -eu
dir="${1:-tmp/vw-tls}"
mkdir -p "$dir"
cd "$dir"
openssl genrsa -out ca.key 2048 2>/dev/null
openssl req -x509 -new -key ca.key -sha256 -days 825 -subj "/CN=bwbu local test CA" -out ca.crt
openssl genrsa -out vw.key 2048 2>/dev/null
openssl req -new -key vw.key -subj "/CN=localhost" -out vw.csr
cat > ext.cnf <<EOF
subjectAltName=DNS:localhost,DNS:vaultwarden,IP:127.0.0.1
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in vw.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out vw.crt -days 365 -sha256 -extfile ext.cnf 2>/dev/null
rm -f vw.csr ext.cnf ca.srl
chmod 644 ca.crt vw.crt vw.key # the container reads vw.key as another uid; this is a throwaway test key
echo "created $dir/ca.crt (trust this) and $dir/vw.crt + vw.key (server)"
