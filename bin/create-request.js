#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const serverUrl = (args.server || process.env.SECRET_BRIDGE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const adminToken = args.adminToken || process.env.SECRET_BRIDGE_ADMIN_TOKEN || '';

if (!adminToken) {
  console.error('Missing SECRET_BRIDGE_ADMIN_TOKEN.');
  process.exit(1);
}

if (!args.url) {
  console.error('Usage: node bin/create-request.js --url URL [--title TITLE] [--screenshot FILE] [--target-json JSON]');
  process.exit(1);
}

const payload = {
  title: args.title || 'Solicitud de contrasena',
  url: args.url,
  reason: args.reason || '',
  fieldLabel: args.fieldLabel || 'Contrasena',
  ttlSeconds: args.ttl ? Number(args.ttl) : undefined,
  target: args.targetJson ? JSON.parse(args.targetJson) : {}
};

if (args.screenshot) {
  payload.screenshotDataUrl = fileToDataUrl(args.screenshot);
}

const res = await fetch(`${serverUrl}/api/jobs`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${adminToken}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify(payload)
});

const data = await res.json().catch(() => ({}));
if (!res.ok || !data.ok) {
  console.error(data.error || `HTTP ${res.status}`);
  process.exit(1);
}

console.log(data.job.secretUrl);
console.error(JSON.stringify({
  id: data.job.id,
  expiresAt: data.job.expiresAt,
  statusUrl: `${serverUrl}/api/jobs/${data.job.id}/status`
}, null, 2));

function parseArgs(list) {
  const parsed = {};
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

function fileToDataUrl(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg'
    ? 'image/jpeg'
    : ext === '.webp'
      ? 'image/webp'
      : 'image/png';
  const bytes = fs.readFileSync(file);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
