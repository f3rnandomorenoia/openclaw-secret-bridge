# Security Notes

Secret Bridge reduces how often an agent has to handle user secrets, but it is not a password manager or a hardware security boundary.

## Plaintext Lifetime

The worker decrypts the ciphertext into a `Buffer`, converts it to a JavaScript string only for the CDP `Input.insertText` call, then clears the reference and overwrites the buffer.

JavaScript strings are immutable and cannot be securely erased from V8 memory. The practical mitigations are:

- keep plaintext scope short
- never log plaintext
- do not store plaintext in job objects
- overwrite the decrypted buffer after use

## Server Handling

The server only receives and stores ciphertext. It does not have the private key and does not decrypt secrets.

On submit, the one-time token is invalidated synchronously before the request body is read. A malformed submit attempt consumes the token and marks the job failed. This favors one-use semantics over retry convenience.

Jobs have a TTL, defaulting to 15 minutes. Expired jobs have their submit token and ciphertext cleared during request cleanup.

## CDP Exposure

The main remaining exposure is the browser automation endpoint.

At paste time, the secret exists in the browser session. If the same agent or another process can read from that CDP endpoint, it may be able to observe the DOM, screenshots, network, or page state after insertion.

## Login Handoff Mode

Login handoff mode is the recommended flow when the agent should work inside the authenticated session but must not see the password.

It is enabled by creating a request with `--login-handoff`. The command captures the verification screenshot first, then installs a privacy overlay in the target tab. The worker enforces immediate submit, waits briefly for the login to settle, clears the password field if it is still present, removes the overlay, and then returns only a completion message.

This prevents accidental agent observation of the password through screenshots or normal tab inspection during the handoff. It does not make a malicious same-user process impossible: a process with unrestricted local CDP access could still connect directly. For a stronger boundary, run the worker against a CDP endpoint that the agent cannot access, for example a separate browser process/profile owned by another OS user or a private `--remote-debugging-pipe` wrapper.

For stronger isolation:

- run the worker against a CDP endpoint that the agent cannot read from
- use a separate browser profile/session for secret entry
- use login handoff mode for login forms
- avoid screenshots or DOM reads while handoff is pending
- prefer submitting immediately after insert when appropriate

## Recommended Deployment

- Use HTTPS, Tailscale, WireGuard, or another trusted transport.
- Put only the public RSA key on the bridge server.
- Keep the private RSA key on the worker machine.
- Use long random admin and worker tokens.
- Do not commit `.env`, `.pem`, `.key`, `var/`, screenshots, or job data.
