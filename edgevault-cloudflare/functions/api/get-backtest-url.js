// functions/get-backtest-url.js
//
// Called by the Replay tab when a user taps a currency pair. Verifies the
// user's Firebase ID token (same pattern as get-trades / screenshot-upload),
// then asks Supabase for a short-lived signed URL to that pair's zip in the
// private "bactests" bucket. The client fetches that URL, unzips in-browser,
// and loads the chart — the file itself is never made public and never
// duplicated per user.

import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // ---- 1. Verify the user is logged in (mirrors your other /api/* functions) ----
    const authHeader = request.headers.get('Authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return json({ error: 'Missing auth token' }, 401);

    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
    });
    const uid = payload.sub || payload.user_id;
    if (!uid) return json({ error: 'Invalid token' }, 401);

    // No plan-tier check here on purpose — the whole app is payment-gated at
    // signup, so a valid token already implies a paying user.

    // ---- 2. Find the file for this symbol by listing the bucket and matching ----
    // No hardcoded filename map — whatever's actually sitting in the bucket right
    // now is what gets matched, so renaming files or keeping a list in sync is
    // never required. If a file gets added/renamed later, this just picks it up.
    const { symbol } = await request.json();
    const key = String(symbol || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) return json({ error: 'Missing symbol' }, 400);

    const listRes = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/bactests`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefix: '', limit: 200 }),
    });
    if (!listRes.ok) return json({ error: 'Could not list bucket', detail: await listRes.text() }, 500);

    const files = await listRes.json();
    const match = files.find(f => f.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(key));
    if (!match) return json({ error: `No file found matching symbol: ${symbol}` }, 404);

    // ---- 3. Ask Supabase to sign a short-lived URL for that file ----
    const signRes = await fetch(
      `${env.SUPABASE_URL}/storage/v1/object/sign/bactests/${encodeURIComponent(match.name)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 300 }), // 5 minutes — plenty for an immediate fetch
      }
    );

    if (!signRes.ok) {
      const detail = await signRes.text();
      return json({ error: 'Could not sign URL', detail }, 500);
    }

    const { signedURL } = await signRes.json();
    const fullUrl = `${env.SUPABASE_URL}/storage/v1${signedURL}`;

    return json({ url: fullUrl, matchedFile: match.name });
  } catch (err) {
    return json({ error: err.message || 'Unauthorized' }, 401);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
