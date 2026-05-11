import Stripe from 'stripe';

const CIRCLE_API_BASE = 'https://app.circle.so';
const UA = 'Mozilla/5.0 (compatible; AMC-Fulfillment/1.0)';

// Circle Admin v2 helpers --------------------------------------------------
// Cloudflare in front of Circle's API rejects requests with python-like
// user agents, so we always send a browser-ish UA.
async function circleInvite({ token, email, name, spaceIds }) {
  const res = await fetch(`${CIRCLE_API_BASE}/api/admin/v2/community_members`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      email,
      name,
      space_ids: spaceIds,
      skip_invitation: false, // let Circle send the welcome email
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function circleDelete({ token, memberId }) {
  const res = await fetch(
    `${CIRCLE_API_BASE}/api/admin/v2/community_members/${memberId}/delete_member`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Token ${token}`,
        Accept: 'application/json',
        'User-Agent': UA,
      },
    }
  );
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Kit tagging (reuses the same pattern paddle-webhook.mjs uses) ------------
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
  if (!createRes.ok) {
    const body = await createRes.json().catch(() => ({}));
    return { stage: 'create', status: createRes.status, body };
  }
  const tagRes = await fetch(
    `https://api.kit.com/v4/tags/${KIT_AMC_TAG_ID}/subscribers`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ email_address: toEmail }),
    }
  );
  const body = await tagRes.json().catch(() => ({}));
  return { stage: 'tag', tag_status: tagRes.status, body };
}

// Event handlers ----------------------------------------------------------
// Provision: signup → invite to Circle, store circle_member_id on the Stripe
// customer so cancellation can find the right person.
async function handleCheckoutCompleted(stripe, session) {
  const token = process.env.CIRCLE_API_TOKEN;
  // Prefer the full AMC space list; fall back to just Orientation if not set.
  const spaceIds = (process.env.CIRCLE_AMC_SPACE_IDS || process.env.CIRCLE_SPACE_ID_ORIENTATION || '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(Boolean);
  const email = session.customer_details?.email || session.customer_email;
  const name = session.customer_details?.name || email;
  if (!email) return { skipped: 'no_email' };
  if (spaceIds.length === 0) return { skipped: 'no_space_ids_configured' };

  const invite = await circleInvite({ token, email, name, spaceIds });

  let memberId = null;
  if (invite.ok) {
    memberId = invite.body?.community_member?.id || null;
  } else if (invite.status === 422) {
    // Likely already a member. Treat as success but flag.
    // (We don't have search-by-email reliably for + aliases, but real signups
    // don't use + aliases. Future: search and adopt existing member_id.)
    return { ok: true, already_member: true, status: invite.status };
  } else {
    return { ok: false, status: invite.status, body: invite.body };
  }

  // Stamp the Stripe customer with metadata so cancellation can find the
  // Circle member without a database. amc_subscriber stays "true" even
  // after cancellation so we can still segment ex-members.
  if (session.customer && memberId) {
    await stripe.customers.update(session.customer, {
      metadata: {
        circle_member_id: String(memberId),
        amc_subscriber: 'true',
        amc_signup_date: new Date().toISOString().slice(0, 10),
      },
    });
  }

  // Tag in Kit so the customer flips into the paying-customer audience.
  let kit_result = null;
  try { kit_result = await tagInKit(email); }
  catch (e) { kit_result = { error: e?.message || String(e) }; }

  return { ok: true, member_id: memberId, kit_result };
}

// Revoke: subscription canceled or charge refunded → remove Circle member.
async function handleSubscriptionEnded(stripe, customerId) {
  if (!customerId) return { skipped: 'no_customer' };
  const customer = await stripe.customers.retrieve(customerId);
  const memberId = customer?.metadata?.circle_member_id;
  if (!memberId) return { skipped: 'no_circle_member_id' };

  const token = process.env.CIRCLE_API_TOKEN;
  const del = await circleDelete({ token, memberId });

  // Idempotent: a 404 means the member is already gone (fine).
  if (del.ok || del.status === 404) {
    // Clear circle_member_id but keep amc_subscriber stamp for segmentation.
    await stripe.customers.update(customerId, {
      metadata: {
        circle_member_id: '',
        amc_subscriber: 'true',
        amc_canceled_date: new Date().toISOString().slice(0, 10),
      },
    });
    return { ok: true, status: del.status };
  }
  return { ok: false, status: del.status, body: del.body };
}

// Main handler ------------------------------------------------------------
export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  let stage = 'init';
  try {
    stage = 'read_env';
    const secret = process.env.STRIPE_SECRET_KEY;
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !whSecret) {
      return new Response('missing stripe env', { status: 500 });
    }

    stage = 'verify_signature';
    // Pin API version: Managed Payments requires 2025-03-31.basil or greater.
    const stripe = new Stripe(secret, { apiVersion: '2025-03-31.basil' });
    const sig = req.headers.get('stripe-signature');
    const raw = await req.text();
    let event;
    try {
      event = stripe.webhooks.constructEvent(raw, sig, whSecret);
    } catch (err) {
      console.warn('stripe-webhook: signature verification failed', err?.message);
      return new Response('invalid signature', { status: 400 });
    }

    stage = `dispatch:${event.type}`;
    let result = null;

    switch (event.type) {
      case 'checkout.session.completed':
        result = await handleCheckoutCompleted(stripe, event.data.object);
        break;

      case 'customer.subscription.deleted':
        // Final cancellation (period_end reached or admin canceled now).
        result = await handleSubscriptionEnded(stripe, event.data.object.customer);
        break;

      case 'charge.refunded':
        result = await handleSubscriptionEnded(stripe, event.data.object.customer);
        break;

      case 'invoice.payment_failed': {
        // Stripe retries the payment per its smart-retry settings. We only
        // revoke access when the subscription itself transitions to canceled
        // (i.e. customer.subscription.deleted fires). Just log here.
        const sub = event.data.object.subscription;
        result = { ack: 'payment_failed', subscription: sub };
        break;
      }

      case 'customer.subscription.updated':
        // Could be a cancel_at_period_end flip. We don't act now; the
        // subsequent customer.subscription.deleted at period_end is what
        // actually revokes access.
        result = { ack: 'subscription_updated' };
        break;

      default:
        result = { ignored: event.type };
    }

    return new Response(
      JSON.stringify({ ok: true, event: event.type, result }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  } catch (err) {
    console.error('stripe-webhook: unhandled exception', {
      stage,
      name: err?.name || null,
      message: err?.message || String(err),
    });
    return new Response('internal error', { status: 500 });
  }
};

export const config = { path: '/api/stripe-webhook' };
