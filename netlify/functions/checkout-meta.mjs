import Stripe from 'stripe';

// Same European list as create-checkout.mjs — keep in sync.
const EUROPEAN_COUNTRIES = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  'IS','LI','NO','CH','GB','MC','SM','VA','AD',
]);

const CURRENCY_SYMBOL = { eur: '€', usd: '$' };

function getCountryCode(req, context) {
  const fromContext = context?.geo?.country?.code;
  if (fromContext) return fromContext.toUpperCase();
  const fromHeader = req.headers.get?.('x-nf-geo-country');
  return fromHeader ? fromHeader.toUpperCase() : null;
}

export default async (req, context) => {
  let stage = 'init';
  try {
    stage = 'read_env';
    const secret = process.env.STRIPE_SECRET_KEY;
    const priceUsd = process.env.STRIPE_PRICE_ID_AMC_USD;
    const priceEur = process.env.STRIPE_PRICE_ID_AMC_EUR;
    if (!secret || !priceUsd || !priceEur) {
      return new Response(
        JSON.stringify({ error: 'missing stripe env vars' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    stage = 'pick';
    const country = getCountryCode(req, context);
    const isEurope = country && EUROPEAN_COUNTRIES.has(country);
    const priceId = isEurope ? priceEur : priceUsd;

    stage = 'fetch_price';
    const stripe = new Stripe(secret, { apiVersion: '2025-03-31.basil' });
    const price = await stripe.prices.retrieve(priceId);

    // Unit_amount is in the smallest currency unit (cents). Convert to whole.
    const amount = (price.unit_amount || 0) / 100;
    const currency = price.currency; // 'eur' | 'usd'
    const symbol = CURRENCY_SYMBOL[currency] || '';
    const display = `${symbol}${Math.round(amount)}`;

    return new Response(
      JSON.stringify({ country, currency, amount, display }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          // Short cache: same browser session won't refetch on every nav.
          'cache-control': 'public, max-age=300',
        },
      }
    );
  } catch (err) {
    console.error('checkout-meta: error', { stage, message: err?.message });
    return new Response(
      JSON.stringify({ error: 'internal', stage }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
};

export const config = { path: '/api/checkout-meta' };
