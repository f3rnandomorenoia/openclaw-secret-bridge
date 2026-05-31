#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bind = process.env.SECRET_BRIDGE_BIND || '127.0.0.1';
const port = Number(process.env.SECRET_BRIDGE_PORT || 8787);
const publicBaseUrl = (process.env.SECRET_BRIDGE_PUBLIC_BASE_URL || '').replace(/\/$/, '');
const adminToken = process.env.SECRET_BRIDGE_ADMIN_TOKEN || '';
const workerToken = process.env.SECRET_BRIDGE_WORKER_TOKEN || '';
const dataDir = process.env.SECRET_BRIDGE_DATA_DIR || path.join(__dirname, 'var');
const publicKeyPath = process.env.SECRET_BRIDGE_PUBLIC_KEY || path.join(dataDir, 'public.pem');
const jobsPath = path.join(dataDir, 'jobs.json');
const screenshotDir = path.join(dataDir, 'screenshots');
const defaultTtlMs = Number(process.env.SECRET_BRIDGE_TTL_SECONDS || 900) * 1000;
const bodyLimitBytes = Number(process.env.SECRET_BRIDGE_BODY_LIMIT_BYTES || 6 * 1024 * 1024);

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });

if (!fs.existsSync(publicKeyPath)) {
  console.error(`Missing public key: ${publicKeyPath}`);
  console.error('Generate keys first; see README.md.');
  process.exit(1);
}

if (!adminToken || !workerToken) {
  console.error('SECRET_BRIDGE_ADMIN_TOKEN and SECRET_BRIDGE_WORKER_TOKEN are required.');
  process.exit(1);
}

const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8');
const publicKeyFingerprint = crypto
  .createHash('sha256')
  .update(publicKeyPem)
  .digest('hex')
  .match(/.{1,8}/g)
  .join(':');

function loadJobs() {
  if (!fs.existsSync(jobsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveJobs(jobs) {
  const tmp = `${jobsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, jobsPath);
}

let jobs = loadJobs();

function now() {
  return Date.now();
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function cleanupExpired() {
  const ts = now();
  let changed = false;
  for (const job of Object.values(jobs)) {
    if (job.status !== 'completed' && job.status !== 'failed' && ts > job.expiresAt) {
      job.status = 'expired';
      job.submitToken = null;
      job.encryptedSecret = null;
      changed = true;
    }
  }
  if (changed) saveJobs(jobs);
}

function auth(req, expected) {
  const header = req.headers.authorization || '';
  return header === `Bearer ${expected}`;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, value, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  res.end(value);
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: 'not_found' });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > bodyLimitBytes) {
      const err = new Error('body_too_large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('bad_json');
    err.statusCode = 400;
    throw err;
  }
}

function baseUrl(req) {
  if (publicBaseUrl) return publicBaseUrl;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${port}`;
  return `${proto}://${host}`;
}

function validateSubmitToken(job, token) {
  if (!job || !job.submitToken || !token) return false;
  const expected = Buffer.from(job.submitToken);
  const actual = Buffer.from(token);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function writeScreenshot(id, screenshotDataUrl) {
  if (!screenshotDataUrl) return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(screenshotDataUrl);
  if (!match) {
    const err = new Error('bad_screenshot_data_url');
    err.statusCode = 400;
    throw err;
  }
  const mime = match[1];
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > bodyLimitBytes) {
    const err = new Error('screenshot_too_large');
    err.statusCode = 413;
    throw err;
  }
  const file = path.join(screenshotDir, `${id}.${ext}`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { file, mime };
}

function publicJob(job, req) {
  return {
    id: job.id,
    title: job.title,
    url: job.url,
    reason: job.reason,
    fieldLabel: job.fieldLabel,
    status: job.status,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    secretUrl: `${baseUrl(req)}/r/${job.id}?token=${job.submitToken}`,
    hasScreenshot: Boolean(job.screenshot),
    publicKeyFingerprint
  };
}

function renderRequestPage(job, token) {
  const screenshot = job.screenshot ? `<img class="shot" src="/shot/${job.id}?token=${encodeURIComponent(token)}" alt="Captura de la pagina destino">` : '<div class="empty-shot">Sin captura adjunta</div>';
  const publicKeyJson = JSON.stringify(publicKeyPem);
  const safeJob = JSON.stringify({
    id: job.id,
    token,
    title: job.title,
    url: job.url,
    reason: job.reason,
    fieldLabel: job.fieldLabel,
    expiresAt: job.expiresAt,
    publicKeyFingerprint
  });

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Puente seguro</title>
  <style>
    :root { color-scheme: light dark; --bg:#f5f7fb; --panel:#fff; --text:#17202a; --muted:#64748b; --line:#d9e1ec; --accent:#0f766e; --danger:#b91c1c; }
    @media (prefers-color-scheme: dark) { :root { --bg:#111827; --panel:#182235; --text:#f8fafc; --muted:#a7b2c5; --line:#324155; --accent:#2dd4bf; --danger:#fca5a5; } }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width: 980px; margin: 0 auto; padding: 24px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns: minmax(0, 1fr) 340px; gap:16px; align-items:start; }
    .shot { width:100%; max-height: 540px; object-fit:contain; background:#000; border:1px solid var(--line); border-radius:6px; }
    .empty-shot { min-height:240px; display:grid; place-items:center; color:var(--muted); border:1px dashed var(--line); border-radius:6px; }
    dl { margin: 12px 0 0; }
    dt { font-weight:700; margin-top: 12px; }
    dd { margin: 3px 0 0; overflow-wrap:anywhere; color:var(--muted); }
    label { display:block; font-weight:700; margin: 18px 0 6px; }
    input[type=password] { width:100%; font:inherit; padding:13px; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--text); }
    button { width:100%; margin-top:12px; border:0; border-radius:6px; padding:13px 16px; font:inherit; font-weight:800; background:var(--accent); color:#fff; cursor:pointer; }
    button:disabled { opacity:.6; cursor:not-allowed; }
    .status { min-height:24px; margin-top:12px; font-weight:700; }
    .danger { color:var(--danger); }
    .small { font-size:12px; line-height:1.45; }
    @media (max-width: 860px) { main { padding:14px; } .grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="grid">
      <section class="panel">
        <h1>Solicitud de contrasena</h1>
        <p class="muted">Comprueba que la URL y la captura corresponden a donde quieres pegarla.</p>
        ${screenshot}
      </section>
      <aside class="panel">
        <dl>
          <dt>Destino</dt>
          <dd><a href="${escapeHtml(job.url)}" rel="noreferrer noopener">${escapeHtml(job.url)}</a></dd>
          <dt>Campo</dt>
          <dd>${escapeHtml(job.fieldLabel || 'Contrasena')}</dd>
          <dt>Motivo</dt>
          <dd>${escapeHtml(job.reason || 'Pegar una contrasena en el navegador controlado')}</dd>
          <dt>Huella de clave</dt>
          <dd class="small">${escapeHtml(publicKeyFingerprint)}</dd>
        </dl>
        <form id="secret-form" autocomplete="off">
          <label for="secret">Contrasena</label>
          <input id="secret" type="password" autocomplete="current-password" autofocus required>
          <button id="submit" type="submit">Enviar y pegar</button>
          <div id="status" class="status"></div>
        </form>
        <p class="muted small">El navegador cifra la contrasena antes de enviarla. El servidor solo guarda texto cifrado de un solo uso.</p>
      </aside>
    </div>
  </main>
  <script>
    const PUBLIC_KEY_PEM = ${publicKeyJson};
    const JOB = ${safeJob};

    function pemToBuffer(pem) {
      const base64 = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\\s/g, '');
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    function toBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }

    const SHA256_K = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];

    function rightRotate(value, bits) {
      return (value >>> bits) | (value << (32 - bits));
    }

    function sha256(bytes) {
      const h = [
        0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
        0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
      ];
      const bitLength = bytes.length * 8;
      const padLength = (64 - ((bytes.length + 1 + 8) % 64)) % 64;
      const message = new Uint8Array(bytes.length + 1 + padLength + 8);
      message.set(bytes);
      message[bytes.length] = 0x80;
      const high = Math.floor(bitLength / 0x100000000);
      const low = bitLength >>> 0;
      message[message.length - 8] = high >>> 24;
      message[message.length - 7] = high >>> 16;
      message[message.length - 6] = high >>> 8;
      message[message.length - 5] = high;
      message[message.length - 4] = low >>> 24;
      message[message.length - 3] = low >>> 16;
      message[message.length - 2] = low >>> 8;
      message[message.length - 1] = low;

      const w = new Uint32Array(64);
      for (let offset = 0; offset < message.length; offset += 64) {
        for (let i = 0; i < 16; i++) {
          const j = offset + i * 4;
          w[i] = ((message[j] << 24) | (message[j + 1] << 16) | (message[j + 2] << 8) | message[j + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
          const s0 = (rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
          const s1 = (rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
          w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
          const s1 = (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) >>> 0;
          const ch = ((e & f) ^ (~e & g)) >>> 0;
          const temp1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
          const s0 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) >>> 0;
          const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
          const temp2 = (s0 + maj) >>> 0;
          hh = g;
          g = f;
          f = e;
          e = (d + temp1) >>> 0;
          d = c;
          c = b;
          b = a;
          a = (temp1 + temp2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0;
        h[5] = (h[5] + f) >>> 0;
        h[6] = (h[6] + g) >>> 0;
        h[7] = (h[7] + hh) >>> 0;
      }

      const out = new Uint8Array(32);
      for (let i = 0; i < h.length; i++) {
        out[i * 4] = h[i] >>> 24;
        out[i * 4 + 1] = h[i] >>> 16;
        out[i * 4 + 2] = h[i] >>> 8;
        out[i * 4 + 3] = h[i];
      }
      return out;
    }

    function readDerLength(bytes, offset) {
      const first = bytes[offset++];
      if (first < 0x80) return { length: first, offset };
      const count = first & 0x7f;
      if (!count || count > 4) throw new Error('Clave publica no compatible');
      let length = 0;
      for (let i = 0; i < count; i++) length = (length << 8) | bytes[offset++];
      return { length, offset };
    }

    function readDerElement(bytes, offset) {
      const tag = bytes[offset++];
      const len = readDerLength(bytes, offset);
      const start = len.offset;
      const end = start + len.length;
      if (end > bytes.length) throw new Error('Clave publica truncada');
      return { tag, start, end, value: bytes.slice(start, end), next: end };
    }

    function stripIntegerPadding(bytes) {
      let start = 0;
      while (start < bytes.length - 1 && bytes[start] === 0) start++;
      return bytes.slice(start);
    }

    function parseRsaPublicKey(spkiBytes) {
      const top = readDerElement(spkiBytes, 0);
      if (top.tag !== 0x30) throw new Error('Clave publica invalida');
      const algorithm = readDerElement(spkiBytes, top.start);
      const bitString = readDerElement(spkiBytes, algorithm.next);
      if (bitString.tag !== 0x03 || bitString.value[0] !== 0) throw new Error('Clave publica RSA invalida');
      const rsaBytes = bitString.value.slice(1);
      const rsa = readDerElement(rsaBytes, 0);
      if (rsa.tag !== 0x30) throw new Error('Clave RSA invalida');
      const modulus = readDerElement(rsaBytes, rsa.start);
      const exponent = readDerElement(rsaBytes, modulus.next);
      if (modulus.tag !== 0x02 || exponent.tag !== 0x02) throw new Error('Clave RSA incompleta');
      return {
        modulus: stripIntegerPadding(modulus.value),
        exponent: stripIntegerPadding(exponent.value)
      };
    }

    function bytesToBigInt(bytes) {
      let hex = '';
      for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
      return BigInt('0x' + (hex || '0'));
    }

    function bigIntToBytes(value, length) {
      const hex = value.toString(16).padStart(length * 2, '0');
      if (hex.length > length * 2) throw new Error('Resultado RSA demasiado largo');
      const out = new Uint8Array(length);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }

    function modPow(base, exponent, modulus) {
      let result = 1n;
      let current = base % modulus;
      let exp = exponent;
      while (exp > 0n) {
        if (exp & 1n) result = (result * current) % modulus;
        exp >>= 1n;
        current = (current * current) % modulus;
      }
      return result;
    }

    function randomBytes(length) {
      if (!globalThis.crypto?.getRandomValues) {
        throw new Error('Este navegador no permite generar aleatorio seguro en esta pagina');
      }
      const out = new Uint8Array(length);
      globalThis.crypto.getRandomValues(out);
      return out;
    }

    function concatBytes(a, b) {
      const out = new Uint8Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    }

    function xorBytes(a, b) {
      const out = new Uint8Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
      return out;
    }

    function mgf1(seed, length) {
      const out = new Uint8Array(length);
      let generated = 0;
      for (let counter = 0; generated < length; counter++) {
        const c = new Uint8Array([
          (counter >>> 24) & 255,
          (counter >>> 16) & 255,
          (counter >>> 8) & 255,
          counter & 255
        ]);
        const digest = sha256(concatBytes(seed, c));
        const chunk = digest.slice(0, Math.min(digest.length, length - generated));
        out.set(chunk, generated);
        generated += chunk.length;
      }
      return out;
    }

    function oaepEncode(message, keyLength) {
      const hashLength = 32;
      if (message.length > keyLength - 2 * hashLength - 2) {
        throw new Error('Texto demasiado largo para esta clave');
      }
      const labelHash = sha256(new Uint8Array(0));
      const dataBlock = new Uint8Array(keyLength - hashLength - 1);
      dataBlock.set(labelHash);
      dataBlock[dataBlock.length - message.length - 1] = 1;
      dataBlock.set(message, dataBlock.length - message.length);
      const seed = randomBytes(hashLength);
      const maskedDataBlock = xorBytes(dataBlock, mgf1(seed, dataBlock.length));
      const maskedSeed = xorBytes(seed, mgf1(maskedDataBlock, hashLength));
      const encoded = new Uint8Array(keyLength);
      encoded[0] = 0;
      encoded.set(maskedSeed, 1);
      encoded.set(maskedDataBlock, 1 + hashLength);
      return encoded;
    }

    function encryptSecretWithJs(value) {
      const publicKey = parseRsaPublicKey(new Uint8Array(pemToBuffer(PUBLIC_KEY_PEM)));
      const encoded = oaepEncode(new TextEncoder().encode(value), publicKey.modulus.length);
      const message = bytesToBigInt(encoded);
      const modulus = bytesToBigInt(publicKey.modulus);
      const exponent = bytesToBigInt(publicKey.exponent);
      if (message >= modulus) throw new Error('Mensaje RSA invalido');
      const ciphertext = modPow(message, exponent, modulus);
      return toBase64(bigIntToBytes(ciphertext, publicKey.modulus.length));
    }

    async function encryptSecret(value) {
      if (globalThis.crypto?.subtle) {
        try {
          const key = await globalThis.crypto.subtle.importKey(
        'spki',
        pemToBuffer(PUBLIC_KEY_PEM),
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['encrypt']
          );
          const ciphertext = await globalThis.crypto.subtle.encrypt(
            { name: 'RSA-OAEP' },
            key,
            new TextEncoder().encode(value)
          );
          return toBase64(ciphertext);
        } catch {
          // Fall through to the pure JS path for browsers that expose partial WebCrypto.
        }
      }
      return encryptSecretWithJs(value);
    }

    document.getElementById('secret-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = document.getElementById('secret');
      const button = document.getElementById('submit');
      const status = document.getElementById('status');
      button.disabled = true;
      status.textContent = 'Cifrando...';
      try {
        const ciphertext = await encryptSecret(input.value);
        input.value = '';
        status.textContent = 'Enviando...';
        const res = await fetch('/api/jobs/' + encodeURIComponent(JOB.id) + '/submit?token=' + encodeURIComponent(JOB.token), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ alg: 'RSA-OAEP-SHA256', ciphertext })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'No se pudo enviar');
        status.textContent = 'Recibida. La pegare en el navegador.';
      } catch (err) {
        status.textContent = err.message || 'Error';
        status.classList.add('danger');
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function handle(req, res) {
  cleanupExpired();
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { ok: true, jobs: Object.keys(jobs).length });
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    if (!auth(req, adminToken)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const body = await readJson(req);
    const id = randomToken(12);
    const ttlMs = Math.min(Math.max(Number(body.ttlSeconds || defaultTtlMs / 1000), 60), 3600) * 1000;
    const screenshot = writeScreenshot(id, body.screenshotDataUrl);
    const job = {
      id,
      submitToken: randomToken(24),
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: now() + ttlMs,
      title: String(body.title || 'Solicitud de contrasena').slice(0, 160),
      url: String(body.url || '').slice(0, 2048),
      reason: String(body.reason || '').slice(0, 500),
      fieldLabel: String(body.fieldLabel || 'Contrasena').slice(0, 120),
      target: body.target && typeof body.target === 'object' ? body.target : {},
      screenshot,
      encryptedSecret: null,
      result: null
    };
    jobs[id] = job;
    saveJobs(jobs);
    return sendJson(res, 201, { ok: true, job: publicJob(job, req) });
  }

  const requestMatch = /^\/r\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (req.method === 'GET' && requestMatch) {
    const job = jobs[requestMatch[1]];
    const token = url.searchParams.get('token') || '';
    if (!validateSubmitToken(job, token)) return sendText(res, 403, 'Enlace invalido o caducado');
    if (job.status !== 'pending') return sendText(res, 410, 'Esta solicitud ya no esta pendiente');
    return sendText(res, 200, renderRequestPage(job, token), 'text/html; charset=utf-8');
  }

  const screenshotMatch = /^\/shot\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (req.method === 'GET' && screenshotMatch) {
    const job = jobs[screenshotMatch[1]];
    const token = url.searchParams.get('token') || '';
    if (!validateSubmitToken(job, token) || !job.screenshot) return notFound(res);
    res.writeHead(200, { 'content-type': job.screenshot.mime, 'cache-control': 'no-store' });
    return fs.createReadStream(job.screenshot.file).pipe(res);
  }

  const submitMatch = /^\/api\/jobs\/([A-Za-z0-9_-]+)\/submit$/.exec(pathname);
  if (req.method === 'POST' && submitMatch) {
    const job = jobs[submitMatch[1]];
    const token = url.searchParams.get('token') || '';
    if (!validateSubmitToken(job, token)) return sendJson(res, 403, { ok: false, error: 'invalid_or_expired_token' });
    if (job.status !== 'pending') return sendJson(res, 409, { ok: false, error: 'job_not_pending' });
    const body = await readJson(req);
    if (body.alg !== 'RSA-OAEP-SHA256' || typeof body.ciphertext !== 'string') {
      return sendJson(res, 400, { ok: false, error: 'bad_ciphertext' });
    }
    job.encryptedSecret = {
      alg: body.alg,
      ciphertext: body.ciphertext,
      submittedAt: new Date().toISOString()
    };
    job.status = 'submitted';
    job.submitToken = null;
    saveJobs(jobs);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/jobs/claim') {
    if (!auth(req, workerToken)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const job = Object.values(jobs).find(item => item.status === 'submitted' && item.encryptedSecret);
    if (!job) {
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    job.status = 'claimed';
    job.claimedAt = new Date().toISOString();
    saveJobs(jobs);
    return sendJson(res, 200, {
      ok: true,
      job: {
        id: job.id,
        title: job.title,
        url: job.url,
        fieldLabel: job.fieldLabel,
        target: job.target,
        encryptedSecret: job.encryptedSecret
      }
    });
  }

  const completeMatch = /^\/api\/jobs\/([A-Za-z0-9_-]+)\/complete$/.exec(pathname);
  if (req.method === 'POST' && completeMatch) {
    if (!auth(req, workerToken)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const job = jobs[completeMatch[1]];
    if (!job) return notFound(res);
    const body = await readJson(req);
    job.status = body.ok ? 'completed' : 'failed';
    job.completedAt = new Date().toISOString();
    job.result = { ok: Boolean(body.ok), message: String(body.message || '').slice(0, 500) };
    job.encryptedSecret = null;
    saveJobs(jobs);
    return sendJson(res, 200, { ok: true });
  }

  const statusMatch = /^\/api\/jobs\/([A-Za-z0-9_-]+)\/status$/.exec(pathname);
  if (req.method === 'GET' && statusMatch) {
    const job = jobs[statusMatch[1]];
    if (!job) return notFound(res);
    return sendJson(res, 200, { ok: true, status: job.status, result: job.result });
  }

  return notFound(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err.statusCode || 500;
    sendJson(res, status, { ok: false, error: err.message || 'server_error' });
  });
});

server.listen(port, bind, () => {
  console.log(`secret-bridge listening on http://${bind}:${port}`);
  console.log(`public key sha256 ${publicKeyFingerprint}`);
});
