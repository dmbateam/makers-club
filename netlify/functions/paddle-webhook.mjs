import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// Paddle Classic signs webhooks: PHP-serialize alphabetically-sorted params
// (minus p_signature), verify SHA1 with the vendor's RSA public key.
function phpSerialize(obj) {
  const keys = Object.keys(obj).sort();
  let out = `a:${keys.length}:{`;
  for (const k of keys) {
    const v = String(obj[k]);
    out += `s:${Buffer.byteLength(k)}:"${k}";s:${Buffer.byteLength(v)}:"${v}";`;
  }
  out += '}';
  return out;
}

// Some env-var UIs collapse PEM newlines into spaces. Reconstruct a
// well-formed PEM (BEGIN/END on their own lines, base64 wrapped to 64 chars).
function normalizePem(input) {
  if (!input) return input;
  if (input.split('\n').length > 3) return input;
  const m = input.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return input;
  const type = m[1];
  const body = m[2].replace(/\s+/g, '');
  const wrapped = body.match(/.{1,64}/g)?.join('\n') || body;
  return `-----BEGIN ${type}-----\n${wrapped}\n-----END ${type}-----\n`;
}

function verifySignature(params, publicKey) {
  const { p_signature, ...rest } = params;
  if (!p_signature) return false;
  const serialized = phpSerialize(rest);
  const verifier = crypto.createVerify('sha1');
  verifier.update(serialized);
  verifier.end();
  try {
    return verifier.verify(normalizePem(publicKey), p_signature, 'base64');
  } catch {
    return false;
  }
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  let stage = 'init';
  try {
    stage = 'read_env';
    const publicKey = process.env.PADDLE_PUBLIC_KEY;
    if (!publicKey) {
      return new Response(
        JSON.stringify({ error: 'missing PADDLE_PUBLIC_KEY env var', stage }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    stage = 'parse_body';
    const body = await req.text();
    const params = Object.fromEntries(new URLSearchParams(body));

    stage = 'verify_signature';
    if (!verifySignature(params, publicKey)) {
      const normalized = normalizePem(publicKey);
      const diag = {
        error: 'invalid signature',
        alert_name: params.alert_name || null,
        key_length: publicKey.length,
        key_lines: publicKey.split('\n').length,
        normalized_lines: normalized.split('\n').length,
        normalized_length: normalized.length,
        key_has_begin: publicKey.includes('-----BEGIN PUBLIC KEY-----'),
        key_has_end: publicKey.includes('-----END PUBLIC KEY-----'),
        sig_present: Boolean(params.p_signature),
        sig_prefix: (params.p_signature || '').slice(0, 20),
      };
      return new Response(JSON.stringify(diag, null, 2), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }

    stage = 'blobs_get';
    const store = getStore('paddle-counter');
    const current = parseInt((await store.get('sold')) || '0', 10);

    stage = 'decide_update';
    let next = current;
    switch (params.alert_name) {
      case 'subscription_created':
        next = current + 1;
        break;
      case 'subscription_cancelled':
        next = Math.max(0, current - 1);
        break;
    }

    stage = 'blobs_set';
    if (next !== current) {
      await store.set('sold', String(next));
    }

    return new Response(
      JSON.stringify({ ok: true, alert_name: params.alert_name, sold: next }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify(
        {
          error: 'unhandled exception',
          stage,
          message: err?.message || String(err),
          name: err?.name || null,
          stack: (err?.stack || '').split('\n').slice(0, 6).join('\n'),
        },
        null,
        2
      ),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
};

export const config = { path: '/api/paddle-webhook' };
