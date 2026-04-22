import { getStore } from '@netlify/blobs';

const TOTAL_SEATS = 50;

export default async () => {
  const store = getStore('paddle-counter');
  const sold = parseInt((await store.get('sold')) || '0', 10);

  return new Response(JSON.stringify({ sold, total: TOTAL_SEATS }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30, s-maxage=30',
    },
  });
};

export const config = { path: '/api/spots-sold' };
