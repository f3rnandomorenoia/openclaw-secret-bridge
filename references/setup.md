# Secret Bridge Setup

Secret Bridge separates the password request page from the agent:

- The server hosts a one-time page and stores only ciphertext.
- The user types the secret in their browser.
- The browser encrypts the secret with RSA-OAEP-SHA256 before submitting it.
- The worker, running near the controlled browser, decrypts in memory and pastes via CDP.

## Generate Keys

On the browser/worker machine:

```bash
mkdir -p ~/.config/secret-bridge
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out ~/.config/secret-bridge/private.pem
openssl rsa -pubout \
  -in ~/.config/secret-bridge/private.pem \
  -out ~/.config/secret-bridge/public.pem
chmod 600 ~/.config/secret-bridge/private.pem
```

Copy only `public.pem` to the server host.

## Run Server

```bash
export SECRET_BRIDGE_BIND=0.0.0.0
export SECRET_BRIDGE_PORT=8787
export SECRET_BRIDGE_DATA_DIR=/var/lib/secret-bridge
export SECRET_BRIDGE_PUBLIC_KEY=/etc/secret-bridge/public.pem
export SECRET_BRIDGE_PUBLIC_BASE_URL=https://bridge.example.com
export SECRET_BRIDGE_ADMIN_TOKEN="$(openssl rand -base64 32)"
export SECRET_BRIDGE_WORKER_TOKEN="$(openssl rand -base64 32)"
node server.js
```

Use `systemd/secret-bridge.service` as a hardening template.

## Run Worker

```bash
export SECRET_BRIDGE_URL=https://bridge.example.com
export SECRET_BRIDGE_WORKER_TOKEN=the-same-worker-token
export SECRET_BRIDGE_PRIVATE_KEY="$HOME/.config/secret-bridge/private.pem"
export SECRET_BRIDGE_CDP_HTTP=http://127.0.0.1:3344
node worker.js
```

Use `systemd/secret-bridge-worker.service` as a user-service template and replace paths before installing.

## Create A Request Manually

```bash
SECRET_BRIDGE_URL=https://bridge.example.com \
SECRET_BRIDGE_ADMIN_TOKEN=... \
node bin/create-request.js \
  --title "Example login" \
  --url "https://example.com/login" \
  --reason "Paste the password into the login field" \
  --field-label "Password" \
  --target-json '{"kind":"cdp","cdpHttp":"http://127.0.0.1:3344","targetUrl":"example.com","selector":"#password","submitSelector":"#login","submitAfter":true}'
```

## Create A Request From The Current Browser Tab

```bash
SECRET_BRIDGE_URL=https://bridge.example.com \
SECRET_BRIDGE_ADMIN_TOKEN=... \
node bin/request-from-cdp.js \
  --target-url example.com \
  --selector '#password' \
  --submit-selector '#login' \
  --submit-after \
  --login-handoff \
  --reason "Paste the password into the login field" \
  --field-label "Password"
```

The command prints a one-time request URL.

`--login-handoff` is recommended for login forms. It captures the screenshot, covers the target tab with a privacy overlay, forces immediate submit, and lets the worker clear the password field before the agent resumes automation in the logged-in session.

## Test

```bash
npm run smoke
```
