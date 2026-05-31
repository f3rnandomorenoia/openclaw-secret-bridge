#!/usr/bin/env node
const args = parseArgs(process.argv.slice(2));

const serverUrl = (args.server || process.env.SECRET_BRIDGE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const adminToken = args.adminToken || process.env.SECRET_BRIDGE_ADMIN_TOKEN || '';
const cdpHttp = (args.cdpHttp || process.env.SECRET_BRIDGE_CDP_HTTP || 'http://127.0.0.1:3344').replace(/\/$/, '');

if (!adminToken) {
  console.error('Missing SECRET_BRIDGE_ADMIN_TOKEN.');
  process.exit(1);
}

const targets = await listCdpTargets(cdpHttp);
const page = pickTarget(targets, {
  targetId: args.targetId,
  targetUrl: args.targetUrl
});

const cdp = await openCdp(page.webSocketDebuggerUrl);
let info;
let screenshotDataUrl;
try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.bringToFront');
  info = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `({ url: location.href, title: document.title })`
  });
  if (!args.noScreenshot) {
    try {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: args.jpeg ? 'jpeg' : 'png',
        captureBeyondViewport: false
      });
      screenshotDataUrl = `data:image/${args.jpeg ? 'jpeg' : 'png'};base64,${shot.data}`;
    } catch (err) {
      console.error(`warning: could not capture screenshot: ${err.message}`);
    }
  }
} finally {
  cdp.close();
}

const pageInfo = info.result?.value || {};
const target = {
  kind: 'cdp',
  cdpHttp,
  targetId: page.id,
  selector: args.selector || '#password',
  clearFirst: args.clearFirst !== 'false'
};

if (args.submitAfter) target.submitAfter = true;
if (args.submitSelector) target.submitSelector = args.submitSelector;
if (args.targetUrl) target.targetUrl = args.targetUrl;

const payload = {
  title: args.title || pageInfo.title || 'Solicitud de contrasena',
  url: args.url || pageInfo.url || page.url || '',
  reason: args.reason || '',
  fieldLabel: args.fieldLabel || 'Contrasena',
  ttlSeconds: args.ttl ? Number(args.ttl) : undefined,
  screenshotDataUrl,
  target
};

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
  target,
  url: payload.url,
  expiresAt: data.job.expiresAt
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

async function listCdpTargets(cdpHttp) {
  const res = await fetch(`${cdpHttp}/json/list`);
  if (!res.ok) throw new Error(`Cannot list CDP targets: HTTP ${res.status}`);
  return res.json();
}

function pickTarget(targets, target) {
  if (target.targetId) {
    const exact = targets.find(item => item.id === target.targetId || item.targetId === target.targetId);
    if (exact) return exact;
  }
  if (target.targetUrl) {
    const byUrl = targets.find(item => (item.url || '').includes(target.targetUrl));
    if (byUrl) return byUrl;
  }
  const page = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (page) return page;
  throw new Error('No matching CDP page target');
}

async function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 1;

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
    else resolve(msg.result);
  });

  function send(method, params = {}) {
    const id = seq++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
    });
  }

  return {
    send,
    close: () => ws.close()
  };
}
