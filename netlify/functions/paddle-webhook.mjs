import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load welcome email template once, at module init.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WELCOME_HTML = readFileSync(
  path.join(HERE, 'emails', 'welcome.html'),
  'utf-8'
);
const WELCOME_SUBJECT = "Welcome to ai makers club.";

async function sendWelcomeEmail(toEmail) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'alen@d.mba';
  if (!apiKey || !toEmail) return { skipped: true };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Alen · ai makers club <${from}>`,
      to: toEmail,
      subject: WELCOME_SUBJECT,
      html: WELCOME_HTML,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// Kit ("customer-makers-club" tag) — applied on subscription_created so the
// buyer flips from waitlist/lead segment into the paying-customer audience.
// Tagging-only fails with 404 if the email isn't yet a Kit subscriber, so we
// always create-or-find first via /v4/subscribers (idempotent: 201 new, 200
// existing) and only then apply the tag.
const KIT_AMC_TAG_ID = '19209626';

async function tagInKit(toEmail) {
  const apiKey = process.env.KIT_API_KEY;
  if (!apiKey || !toEmail) return { skipped: true };

  const headers = {
    'X-Kit-Api-Key': apiKey,
    'Content-Type': 'application/json',
  };

  const createRes = await fetch('https://api.kit.com/v4/subscribers', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email_address: toEmail, state: 'active' }),
  });
  const createBody = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    return { stage: 'create', status: createRes.status, body: createBody };
  }

  const tagRes = await fetch(
    `https://api.kit.com/v4/tags/${KIT_AMC_TAG_ID}/subscribers`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ email_address: toEmail }),
    }
  );
  const tagBody = await tagRes.json().catch(() => ({}));
  return {
    stage: 'tag',
    create_status: createRes.status,
    tag_status: tagRes.status,
    body: tagBody,
  };
}

// AI Makers Club subscription plan ID. Paddle webhooks are vendor-wide
// (every plan fires to every endpoint), so we filter on this to avoid
// counting/emailing buyers of d.MBA Coaching, Academy, or Newsletter.
const AMC_PLAN_ID = '924249';

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
      console.warn('paddle-webhook: invalid signature', {
        alert_name: params.alert_name || null,
        key_length: publicKey.length,
        key_lines: publicKey.split('\n').length,
        normalized_lines: normalized.split('\n').length,
        normalized_length: normalized.length,
        key_has_begin: publicKey.includes('-----BEGIN PUBLIC KEY-----'),
        key_has_end: publicKey.includes('-----END PUBLIC KEY-----'),
        sig_present: Boolean(params.p_signature),
      });
      return new Response('forbidden', { status: 403 });
    }

    stage = 'plan_filter';
    if (String(params.subscription_plan_id) !== AMC_PLAN_ID) {
      return new Response(
        JSON.stringify({
          ok: true,
          ignored: true,
          reason: 'plan_mismatch',
          plan_id: params.subscription_plan_id,
          alert_name: params.alert_name,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
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

    // Send welcome email + tag in Kit on new subscription. Non-blocking:
    // failures here must not cause a non-2xx response (Paddle would retry
    // and we'd double-count / double-send / double-tag).
    stage = 'send_welcome';
    let email_result = null;
    let kit_result = null;
    if (params.alert_name === 'subscription_created') {
      try {
        email_result = await sendWelcomeEmail(params.email);
      } catch (e) {
        email_result = { error: e?.message || String(e) };
      }
      try {
        kit_result = await tagInKit(params.email);
      } catch (e) {
        kit_result = { error: e?.message || String(e) };
      }
    }

    return new Response(
      JSON.stringify({ ok: true, alert_name: params.alert_name, sold: next, email_result, kit_result }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  } catch (err) {
    console.error('paddle-webhook: unhandled exception', {
      stage,
      name: err?.name || null,
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
    return new Response('internal error', { status: 500 });
  }
};

export const config = { path: '/api/paddle-webhook' };
