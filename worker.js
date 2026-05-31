#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';

const serverUrl = (process.env.SECRET_BRIDGE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const workerToken = process.env.SECRET_BRIDGE_WORKER_TOKEN || '';
const privateKeyPath = process.env.SECRET_BRIDGE_PRIVATE_KEY || '';
const pollMs = Number(process.env.SECRET_BRIDGE_POLL_MS || 2000);
const once = process.argv.includes('--once') || process.env.SECRET_BRIDGE_ONCE === '1';

if (!workerToken || !privateKeyPath) {
  console.error('SECRET_BRIDGE_WORKER_TOKEN and SECRET_BRIDGE_PRIVATE_KEY are required.');
  process.exit(1);
}

const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const res = await fetch(`${serverUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${workerToken}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function decryptSecretToBuffer(encryptedSecret) {
  if (!encryptedSecret || encryptedSecret.alg !== 'RSA-OAEP-SHA256') {
    throw new Error('unsupported encrypted secret');
  }
  return crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(encryptedSecret.ciphertext, 'base64')
  );
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

async function listCdpTargets(cdpHttp) {
  const res = await fetch(`${cdpHttp.replace(/\/$/, '')}/json/list`);
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

async function insertSecretText(cdp, secretBuffer) {
  let secret = secretBuffer.toString('utf8');
  try {
    await cdp.send('Input.insertText', { text: secret });
  } finally {
    secret = '';
  }
}

async function getPageInfo(cdp) {
  const result = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `({
      url: location.href,
      title: document.title,
      readyState: document.readyState
    })`
  });
  return result.result?.value || {};
}

async function clearSecretField(cdp, selector) {
  if (!selector) return;
  const quoted = JSON.stringify(selector);
  await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(() => {
      const el = document.querySelector(${quoted});
      if (!el) return false;
      if ('value' in el) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.blur();
      return true;
    })()`
  }).catch(() => null);
}

async function removePrivacyOverlay(cdp) {
  await cdp.send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `document.getElementById('secret-bridge-privacy-overlay')?.remove()`
  }).catch(() => null);
}

async function waitForLoginHandoff(cdp, target, originalUrl) {
  const configured = target.handoffWaitMs ?? process.env.SECRET_BRIDGE_HANDOFF_WAIT_MS ?? 5000;
  const timeoutMs = Math.max(0, Math.min(Number(configured) || 0, 30000));
  const start = Date.now();
  let lastInfo = await getPageInfo(cdp).catch(() => ({}));

  while (Date.now() - start < timeoutMs) {
    await sleep(250);
    lastInfo = await getPageInfo(cdp).catch(() => lastInfo);
    if (target.successSelector) {
      const selector = JSON.stringify(target.successSelector);
      const success = await cdp.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `Boolean(document.querySelector(${selector}))`
      }).catch(() => null);
      if (success?.result?.value) return lastInfo;
    }
    if (originalUrl && lastInfo.url && lastInfo.url !== originalUrl && lastInfo.readyState === 'complete') {
      return lastInfo;
    }
  }

  return lastInfo;
}

async function pasteViaCdp(secretBuffer, target) {
  const loginHandoff = target.privacyMode === 'login-handoff';
  if (loginHandoff && !target.selector) {
    throw new Error('login handoff requires a password selector');
  }
  if (loginHandoff && !target.submitAfter) {
    throw new Error('login handoff requires submitAfter');
  }

  const cdpHttp = target.cdpHttp || process.env.SECRET_BRIDGE_CDP_HTTP || 'http://127.0.0.1:3344';
  const targets = await listCdpTargets(cdpHttp);
  const page = pickTarget(targets, target);
  const cdp = await openCdp(page.webSocketDebuggerUrl);
  let originalInfo = {};
  let finalInfo = {};
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.bringToFront');
    originalInfo = await getPageInfo(cdp).catch(() => ({}));
    if (target.selector) {
      const selector = JSON.stringify(target.selector);
      const clearFirst = target.clearFirst !== false;
      const clear = clearFirst ? "if ('value' in el) el.value = '';" : '';
      const result = await cdp.send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(() => {
          const el = document.querySelector(${selector});
          if (!el) return { ok: false, reason: 'selector not found' };
          el.focus();
          ${clear}
          return { ok: true };
        })()`
      });
      if (!result.result?.value?.ok) {
        throw new Error(result.result?.value?.reason || 'Could not focus selector');
      }
    }
    await insertSecretText(cdp, secretBuffer);
    if (target.submitAfter) {
      if (target.submitSelector) {
        const submitSelector = JSON.stringify(target.submitSelector);
        const result = await cdp.send('Runtime.evaluate', {
          awaitPromise: true,
          returnByValue: true,
          expression: `(() => {
            const el = document.querySelector(${submitSelector});
            if (!el) return { ok: false, reason: 'submit selector not found' };
            el.click();
            return { ok: true };
          })()`
        });
        if (!result.result?.value?.ok) {
          throw new Error(result.result?.value?.reason || 'Could not click submit selector');
        }
      } else {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      }
    }
    if (loginHandoff) {
      finalInfo = await waitForLoginHandoff(cdp, target, originalInfo.url);
    } else {
      finalInfo = await getPageInfo(cdp).catch(() => ({}));
    }
    return { loginHandoff, finalInfo };
  } finally {
    if (loginHandoff) {
      await clearSecretField(cdp, target.selector);
      await removePrivacyOverlay(cdp);
    }
    cdp.close();
  }
}

async function handleJob(job) {
  const secretBuffer = decryptSecretToBuffer(job.encryptedSecret);
  try {
    const target = job.target || {};
    if (target.kind === 'noop') {
      return 'noop target completed';
    }
    const result = await pasteViaCdp(secretBuffer, target);
    if (result.loginHandoff) {
      return `login handoff completed: ${result.finalInfo?.url || 'unknown url'}`;
    }
    return 'pasted via cdp';
  } finally {
    secretBuffer.fill(0);
  }
}

async function complete(jobId, ok, message) {
  await api(`/api/jobs/${encodeURIComponent(jobId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ ok, message })
  });
}

async function loop() {
  while (true) {
    try {
      const data = await api('/api/jobs/claim', { method: 'POST' });
      if (!data?.job) {
        if (once) return;
        await sleep(pollMs);
        continue;
      }
      try {
        const message = await handleJob(data.job);
        await complete(data.job.id, true, message);
        console.log(`completed job ${data.job.id}: ${message}`);
      } catch (err) {
        await complete(data.job.id, false, err.message || 'worker_error');
        console.error(`failed job ${data.job.id}: ${err.message}`);
      }
    } catch (err) {
      console.error(`worker loop error: ${err.message}`);
      if (once) process.exitCode = 1;
      if (once) return;
      await sleep(pollMs);
    }
  }
}

loop();
