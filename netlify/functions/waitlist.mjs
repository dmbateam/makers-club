// Waitlist signup — when AMC is sold out, the page form posts here.
// Creates-or-finds the subscriber in Kit (idempotent), then applies the
// "waitlist-makers-club" tag so we can email this segment when round 2 opens.
// Tagging-only fails with 404 for new emails, so the create step is required.
// After tagging succeeds, sends a confirmation email via Resend (Kit free plan
// has no automations, so we mail it ourselves).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from '@netlify/blobs';

const KIT_WAITLIST_TAG_ID = '19218441';
const RFC5322 = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Browser must POST from an allowlisted origin. Stops casual curl-loop abuse.
// (A determined attacker can forge the Origin header — the rate limit below
// is the second layer.)
const ALLOWED_ORIGINS = new Set([
  'https://ai-makers.club',
  'https://www.ai-makers.club',
  'http://localhost:8888',
  'http://127.0.0.1:8888',
]);

// Per-IP rate limit, sliding 1-hour window. 3 submissions max — legit users
// rarely re-submit; abusers churn through it fast.
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function clientIp(req) {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

async function checkRateLimit(ip) {
  const store = getStore('waitlist-rate-limit');
  const now = Date.now();
  const raw = await store.get(ip);
  let entry = { count: 0, windowStart: now };
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (now - parsed.windowStart < RATE_LIMIT_WINDOW_MS) entry = parsed;
    } catch {}
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil(
      (entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000
    );
    return { allowed: false, retryAfter };
  }
  entry.count += 1;
  await store.set(ip, JSON.stringify(entry));
  return { allowed: true };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAITLIST_HTML = readFileSync(
  path.join(HERE, 'emails', 'waitlist.html'),
  'utf-8'
);
const WAITLIST_SUBJECT = "You're on the ai makers club waitlist.";

async function sendWaitlistEmail(toEmail) {
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
      subject: WAITLIST_SUBJECT,
      html: WAITLIST_HTML,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const origin = req.headers.get('origin') || '';
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response('forbidden', { status: 403 });
  }

  let stage = 'init';
  try {
    stage = 'parse_body';
    let email;
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const json = await req.json().catch(() => ({}));
      email = json.email;
    } else {
      const text = await req.text();
      email = Object.fromEntries(new URLSearchParams(text)).email;
    }
    email = (email || '').trim().toLowerCase();

    stage = 'validate';
    if (!email || !RFC5322.test(email)) {
      return new Response(
        JSON.stringify({ error: 'invalid email' }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }

    // Consume the rate-limit slot only after we know we're about to make
    // external calls — bad-email rejections shouldn't lock out an IP.
    stage = 'rate_limit';
    const ip = clientIp(req);
    const rl = await checkRateLimit(ip);
    if (!rl.allowed) {
      return new Response(
        JSON.stringify({ error: 'rate limited' }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(rl.retryAfter),
          },
        }
      );
    }

    stage = 'read_env';
    const apiKey = process.env.KIT_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'server misconfigured: KIT_API_KEY missing' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    const headers = {
      'X-Kit-Api-Key': apiKey,
      'Content-Type': 'application/json',
    };

    stage = 'kit_create';
    const createRes = await fetch('https://api.kit.com/v4/subscribers', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email_address: email, state: 'active' }),
    });
    if (!createRes.ok) {
      const body = await createRes.json().catch(() => ({}));
      console.warn('waitlist: kit create failed', { status: createRes.status, body });
      return new Response(
        JSON.stringify({ error: 'upstream error' }),
        { status: 502, headers: { 'content-type': 'application/json' } }
      );
    }

    stage = 'kit_tag';
    const tagRes = await fetch(
      `https://api.kit.com/v4/tags/${KIT_WAITLIST_TAG_ID}/subscribers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ email_address: email }),
      }
    );
    if (!tagRes.ok) {
      const body = await tagRes.json().catch(() => ({}));
      console.warn('waitlist: kit tag failed', { status: tagRes.status, body });
      return new Response(
        JSON.stringify({ error: 'upstream error' }),
        { status: 502, headers: { 'content-type': 'application/json' } }
      );
    }

    // Confirmation email. Non-blocking: Resend failure shouldn't break
    // the user's flow — they're already in Kit, we'll backfill if needed.
    stage = 'send_confirmation';
    try {
      await sendWaitlistEmail(email);
    } catch (e) {
      console.warn('waitlist: resend send failed', { message: e?.message || String(e) });
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  } catch (err) {
    console.error('waitlist: unhandled exception', {
      stage,
      name: err?.name || null,
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
    return new Response('internal error', { status: 500 });
  }
};

export const config = { path: '/api/waitlist' };
