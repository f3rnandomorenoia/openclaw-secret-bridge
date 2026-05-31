---
name: secret-bridge
description: "Request one-time encrypted passwords from a user and paste them into a browser field without exposing the plaintext to the agent."
metadata:
  openclaw:
    requires:
      bins:
        - node
        - openssl
allowed-tools:
  - browser
  - bash
license: MIT
---

# Secret Bridge

Use when a login or form needs a secret that the agent must not see.

The flow:

1. Confirm the target page is the right page and the password field exists.
2. Create a Secret Bridge request with the page URL, reason, screenshot, selector, and optional submit selector.
3. Send the one-time request URL to the user.
4. Wait for the worker to claim the encrypted secret and paste it through CDP.
5. Verify that the page advanced, without asking for or logging the plaintext.

## Setup

Run a bridge server somewhere the user can open, such as a LAN host, tunnel, or small VPS. The server only needs the public RSA key.

Run the worker on the machine that can reach the browser CDP endpoint. The worker needs the private RSA key and the worker token.

Read `references/setup.md` for installation details.

## Create A Request From CDP

```bash
SECRET_BRIDGE_URL=http://bridge-host:8787 \
SECRET_BRIDGE_ADMIN_TOKEN=... \
node bin/request-from-cdp.js \
  --target-url example.com \
  --selector '#password' \
  --submit-selector '#login-button' \
  --submit-after \
  --reason "Paste the password into the login form" \
  --field-label "Account password"
```

Only send the printed `/r/...` URL to the user. Do not print or request the secret itself.

## Safety Rules

- Do not store private keys, tokens, screenshots, or generated job data in git.
- Prefer HTTPS, Tailscale, WireGuard, or a trusted LAN. Without TLS, a local network attacker could modify the page before encryption.
- Keep the private key only on the worker/browser machine.
- Use long random `SECRET_BRIDGE_ADMIN_TOKEN` and `SECRET_BRIDGE_WORKER_TOKEN` values.
- Use short TTLs. Requests are one-use and default to 15 minutes.
- Verify the target URL and screenshot before asking the user to type a secret.
- Treat CDP as the remaining sensitive boundary. Once pasted, the secret is in the browser session; avoid DOM/screenshot reads after paste and prefer a worker CDP endpoint the agent cannot inspect.
