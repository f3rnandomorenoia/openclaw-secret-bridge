# Systemd Notes

The unit files in `systemd/` are templates.

## Server

1. Copy the repo to `/opt/secret-bridge`.
2. Create a system user:

```bash
sudo useradd --system --home /var/lib/secret-bridge --shell /usr/sbin/nologin secret-bridge
```

3. Put the public key at `/etc/secret-bridge/public.pem`.
4. Put server env in `/etc/secret-bridge.env`.
5. Install `systemd/secret-bridge.service` into `/etc/systemd/system/`.

Example `/etc/secret-bridge.env`:

```env
SECRET_BRIDGE_BIND=0.0.0.0
SECRET_BRIDGE_PORT=8787
SECRET_BRIDGE_DATA_DIR=/var/lib/secret-bridge
SECRET_BRIDGE_PUBLIC_KEY=/etc/secret-bridge/public.pem
SECRET_BRIDGE_PUBLIC_BASE_URL=https://bridge.example.com
SECRET_BRIDGE_ADMIN_TOKEN=replace-with-random-token
SECRET_BRIDGE_WORKER_TOKEN=replace-with-random-token
```

## Worker

Install `systemd/secret-bridge-worker.service` as a user service, or adapt the paths.

Example `~/.config/secret-bridge/worker.env`:

```env
SECRET_BRIDGE_URL=https://bridge.example.com
SECRET_BRIDGE_WORKER_TOKEN=replace-with-worker-token
SECRET_BRIDGE_PRIVATE_KEY=/home/you/.config/secret-bridge/private.pem
SECRET_BRIDGE_CDP_HTTP=http://127.0.0.1:3344
```
