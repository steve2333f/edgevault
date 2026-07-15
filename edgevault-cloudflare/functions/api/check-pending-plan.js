// functions/api/check-pending-plan.js
//
// Cloudflare Pages Function — PUBLIC, no auth required (called from the
// auth screen before the user has an account or is logged in).
//
// Tells the app whether an email has a paid, unclaimed plan sitting in
// pendingPlans/{email} (written by gumroad-webhook.js when a Gumroad sale
// comes in with no uid attached, i.e. bought before the buyer ever had an
// app account).
//
// Deliberately returns ONLY a boolean - never the plan tier, dates, or
// anything else from the pending doc. This endpoint is unauthenticated by
// necessity (the whole point is to check before an account exists), so it
// should leak as little as possible: just "does this email have something
// to claim," not what it is.
//
// REQUIRED ENV VARS: same Firestore service-account vars as
// gumroad-webhook.js (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
// FIREBASE_PRIVATE_KEY).

import { SignJWT, importPKCS8 } from 'jose';

// ---- duplicated from gumroad-webhook.js on purpose - no shared module
// system between these Functions (same convention as that file). ----
async function getFirestoreAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(
    env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    'RS256'
  );

  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/datastore',
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(env.FIREBASE_CLIENT_EMAIL)
    .setSubject(env.FIREBASE_CLIENT_EMAIL)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to get Firestore access token: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function docExists(env, path) {
  const accessToken = await getFirestoreAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Firestore get failed: ${res.status} ${await res.text()}`);
  return true;
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const email = (body.email || '').trim().toLowerCase();
    if (!email) {
      return new Response(JSON.stringify({ error: 'email required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const exists = await docExists(env, `pendingPlans/${encodeURIComponent(email)}`);
    return new Response(JSON.stringify({ exists }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('check-pending-plan: error', e);
    // Fail closed - if we can't confirm a pending plan exists, tell the
    // app it doesn't, rather than accidentally letting account creation
    // through for an unverified email.
    return new Response(JSON.stringify({ exists: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
