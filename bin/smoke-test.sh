#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT="${SECRET_BRIDGE_TEST_PORT:-18787}"
ADMIN_TOKEN="admin-test-token"
WORKER_TOKEN="worker-test-token"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$TMP/private.pem" >/dev/null 2>&1
openssl rsa -pubout -in "$TMP/private.pem" -out "$TMP/public.pem" >/dev/null 2>&1

SECRET_BRIDGE_BIND=127.0.0.1 \
SECRET_BRIDGE_PORT="$PORT" \
SECRET_BRIDGE_DATA_DIR="$TMP/data" \
SECRET_BRIDGE_PUBLIC_KEY="$TMP/public.pem" \
SECRET_BRIDGE_ADMIN_TOKEN="$ADMIN_TOKEN" \
SECRET_BRIDGE_WORKER_TOKEN="$WORKER_TOKEN" \
node "$ROOT/server.js" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

for _ in {1..30}; do
  if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

REQUEST_URL="$(
  SECRET_BRIDGE_URL="http://127.0.0.1:$PORT" \
  SECRET_BRIDGE_ADMIN_TOKEN="$ADMIN_TOKEN" \
  node "$ROOT/bin/create-request.js" \
    --url "https://example.test/login" \
    --title "Smoke test" \
    --reason "Verificar cifrado y entrega" \
    --target-json '{"kind":"noop"}' \
    2>"$TMP/create.log"
)"

node --input-type=module - "$REQUEST_URL" "$TMP/public.pem" <<'NODE'
import fs from 'node:fs';
const requestUrl = process.argv[2];
const publicKeyPem = fs.readFileSync(process.argv[3], 'utf8');
const html = await fetch(requestUrl).then(res => res.text());
if (!html.includes('Smoke test')) throw new Error('request page did not render');
const key = await crypto.subtle.importKey(
  'spki',
  Buffer.from(publicKeyPem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, ''), 'base64'),
  { name: 'RSA-OAEP', hash: 'SHA-256' },
  false,
  ['encrypt']
);
const ciphertext = Buffer.from(await crypto.subtle.encrypt(
  { name: 'RSA-OAEP' },
  key,
  new TextEncoder().encode('secret-value-never-logged')
)).toString('base64');
const submitUrl = requestUrl.replace('/r/', '/api/jobs/').replace(/\?token=/, '/submit?token=');
const res = await fetch(submitUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ alg: 'RSA-OAEP-SHA256', ciphertext })
});
if (!res.ok) throw new Error(`submit failed: ${res.status}`);
NODE

SECRET_BRIDGE_URL="http://127.0.0.1:$PORT" \
SECRET_BRIDGE_WORKER_TOKEN="$WORKER_TOKEN" \
SECRET_BRIDGE_PRIVATE_KEY="$TMP/private.pem" \
node "$ROOT/worker.js" --once >"$TMP/worker.log" 2>&1

if ! grep -q "completed job" "$TMP/worker.log"; then
  cat "$TMP/server.log"
  cat "$TMP/worker.log"
  exit 1
fi

echo "secret-bridge smoke test OK"
