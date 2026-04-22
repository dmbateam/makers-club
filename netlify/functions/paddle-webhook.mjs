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

function verifySignature(params, publicKey) {
  const { p_signature, ...rest } = params;
  if (!p_signature) return false;
  const serialized = phpSerialize(rest);
  const verifier = crypto.createVerify('sha1');
  verifier.update(serialized);
  verifier.end();
  try {
    return verifier.verify(publicKey, p_signature, 'base64');
  } catch {
    return false;
  }
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const publicKey = process.env.PADDLE_PUBLIC_KEY;
  if (!publicKey) {
    console.error('paddle-webhook: PADDLE_PUBLIC_KEY env var is missing');
    return new Response('server misconfigured', { status: 500 });
  }

  const body = await req.text();
  const params = Object.fromEntries(new URLSearchParams(body));

  if (!verifySignature(params, publicKey)) {
    const diag = {
      error: 'invalid signature',
      alert_name: params.alert_name || null,
      key_length: publicKey.length,
      key_lines: publicKey.split('\n').length,
      key_has_begin: publicKey.includes('-----BEGIN PUBLIC KEY-----'),
      key_has_end: publicKey.includes('-----END PUBLIC KEY-----'),
      key_head: publicKey.slice(0, 40).replace(/\n/g, '\\n'),
      key_tail: publicKey.slice(-40).replace(/\n/g, '\\n'),
      sig_present: Boolean(params.p_signature),
      sig_prefix: (params.p_signature || '').slice(0, 20),
    };
    return new Response(JSON.stringify(diag, null, 2), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  const store = getStore('paddle-counter');
  const current = parseInt((await store.get('sold')) || '0', 10);

  let next = current;
  switch (params.alert_name) {
    case 'subscription_created':
      next = current + 1;
      break;
    case 'subscription_cancelled':
      next = Math.max(0, current - 1);
      break;
  }

  if (next !== current) {
    await store.set('sold', String(next));
  }

  return new Response('ok', { status: 200 });
};

export const config = { path: '/api/paddle-webhook' };
