import Stripe from 'stripe';

// Europe (continent) = EU 27 + EEA + UK + Switzerland + tiny states.
// Used to pick EUR pricing. Unknown country falls back to USD.
const EUROPEAN_COUNTRIES = new Set([
  // EU 27
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  // EEA + Switzerland
  'IS','LI','NO','CH',
  // UK
  'GB',
  // Smaller European states
  'MC','SM','VA','AD',
]);

function getCountryCode(req, context) {
  // Netlify injects geo from Cloudflare-style IP lookup.
  // Trust the function context first; fall back to the header.
  const fromContext = context?.geo?.country?.code;
  if (fromContext) return fromContext.toUpperCase();
  const fromHeader = req.headers.get?.('x-nf-geo-country');
  return fromHeader ? fromHeader.toUpperCase() : null;
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  let stage = 'init';
  try {
    stage = 'read_env';
    const secret = process.env.STRIPE_SECRET_KEY;
    const priceUsd = process.env.STRIPE_PRICE_ID_AMC_USD;
    const priceEur = process.env.STRIPE_PRICE_ID_AMC_EUR;
    if (!secret || !priceUsd || !priceEur) {
      return new Response(
        JSON.stringify({ error: 'missing stripe env vars', stage }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    stage = 'pick_currency';
    const country = getCountryCode(req, context);
    const isEurope = country && EUROPEAN_COUNTRIES.has(country);
    const priceId = isEurope ? priceEur : priceUsd;
    const currency = isEurope ? 'eur' : 'usd';

    stage = 'origin';
    const origin = new URL(req.url).origin;

    stage = 'create_session';
    // Pin API version: Managed Payments requires 2025-03-31.basil or greater.
    const stripe = new Stripe(secret, { apiVersion: '2025-03-31.basil' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Stripe Managed Payments = Stripe acts as merchant of record.
      // Tax, invoicing, dunning, disputes all handled by Stripe.
      managed_payments: { enabled: true },
      // Always collect billing address so MP can determine tax jurisdiction
      // (this is in addition to the geo-based currency choice above).
      billing_address_collection: 'required',
      // Capture metadata that the webhook will use to provision Circle access.
      // amc_subscriber is sticky on the Customer object even after cancellation
      // so we can still segment ex-members later.
      subscription_data: {
        metadata: {
          product: 'ai-makers-club',
          source_country_at_signup: country || 'unknown',
        },
      },
      // (In subscription mode, Stripe always creates a customer — no
      // customer_creation flag needed.)
      success_url: `${origin}/checkout/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout`,
      // Allow promo codes if we want to run promotions later.
      allow_promotion_codes: true,
    });

    return new Response(
      JSON.stringify({ url: session.url, currency, country }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  } catch (err) {
    console.error('create-checkout: unhandled exception', {
      stage,
      name: err?.name || null,
      message: err?.message || String(err),
    });
    return new Response(
      JSON.stringify({ error: 'internal error', stage }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
};

export const config = { path: '/api/create-checkout' };
