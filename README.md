# OpenClaw Secret Bridge

One-time encrypted password handoff for OpenClaw browser automation.

It lets an agent ask a user for a password without seeing the plaintext:

1. The agent creates a request with a destination URL, screenshot, and target field.
2. The user opens the request page and types the password.
3. The browser encrypts the password with RSA-OAEP-SHA256 before sending it.
4. The server stores only ciphertext, with a short TTL and single-use token.
5. A worker near the controlled browser decrypts in memory and pastes through CDP.

The repo is also an OpenClaw skill: `SKILL.md` describes when and how to use it.

## Install

```bash
git clone https://github.com/f3rnandomorenoia/openclaw-secret-bridge.git
cd openclaw-secret-bridge
npm run smoke
```

Copy this repo or its `SKILL.md` into your OpenClaw skills path if your installation does not install skills directly from GitHub.

## Security Notes

- Use HTTPS, Tailscale, WireGuard, or a trusted LAN.
- Keep the RSA private key only on the worker/browser machine.
- Put only the public key on the web server.
- Use long random admin and worker tokens.
- Do not commit `.env`, `.pem`, `.key`, `var/`, screenshots, or job state.
- Without TLS, a network attacker could modify the request page before it encrypts the secret.

## Quick Start

Generate keys on the worker machine:

```bash
mkdir -p ~/.config/secret-bridge
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 \
  -out ~/.config/secret-bridge/private.pem
openssl rsa -pubout \
  -in ~/.config/secret-bridge/private.pem \
  -out ~/.config/secret-bridge/public.pem
chmod 600 ~/.config/secret-bridge/private.pem
```

Start the server:

```bash
SECRET_BRIDGE_BIND=0.0.0.0 \
SECRET_BRIDGE_PORT=8787 \
SECRET_BRIDGE_DATA_DIR=./var \
SECRET_BRIDGE_PUBLIC_KEY="$HOME/.config/secret-bridge/public.pem" \
SECRET_BRIDGE_PUBLIC_BASE_URL=http://127.0.0.1:8787 \
SECRET_BRIDGE_ADMIN_TOKEN="$(openssl rand -base64 32)" \
SECRET_BRIDGE_WORKER_TOKEN="$(openssl rand -base64 32)" \
npm start
```

Start the worker in another shell, using the same worker token:

```bash
SECRET_BRIDGE_URL=http://127.0.0.1:8787 \
SECRET_BRIDGE_WORKER_TOKEN=... \
SECRET_BRIDGE_PRIVATE_KEY="$HOME/.config/secret-bridge/private.pem" \
SECRET_BRIDGE_CDP_HTTP=http://127.0.0.1:3344 \
npm run worker
```

Create a request from a CDP tab:

```bash
SECRET_BRIDGE_URL=http://127.0.0.1:8787 \
SECRET_BRIDGE_ADMIN_TOKEN=... \
npm run request-from-cdp -- \
  --target-url example.com \
  --selector '#password' \
  --submit-selector '#login' \
  --submit-after \
  --reason "Paste the password into the login field" \
  --field-label "Password"
```

More detail is in `references/setup.md`.
