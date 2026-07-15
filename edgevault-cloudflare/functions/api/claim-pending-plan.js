// functions/api/claim-pending-plan.js
//
// Cloudflare Pages Function — requires a valid Firebase ID token
// (Authorization: Bearer <idToken>), called once right after the app
// creates a Firebase account for an email that check-pending-plan.js
// already confirmed has a paid, unclaimed plan waiting.
//
// What it does:
//   1. Verifies the ID token against Firebase's own accounts:lookup
//      endpoint - this confirms the token is real and tells us the uid +
//      email it belongs to (so the caller can't claim a plan for an email
//      that isn't actually theirs).
//   2. Reads pendingPlans/{that email}. If nothing's there -> no-op, this
//      account has nothing to claim (shouldn't normally happen, since the
//      app only calls this right after check-pending-plan.js said yes,
//      but sales can race with account creation, so we don't error hard).
//   3. Copies plan/planStartDate/planInterval/planExpiresAt onto
//      users/{uid}.
//   4. Deletes pendingPlans/{email} so it can't be claimed twice.
//
// REQUIRED ENV VARS: same as gumroad-webhook.js (FIREBASE_PROJECT_ID,
// FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY). No new secrets needed -
// the Identity Toolkit lookup below uses the same public Web API key
// that's already embedded in index.html's firebaseConfig (Firebase web
// API keys identify the project, they aren't secret; access is enforced
// by Firestore/Auth rules, not by hiding this key).

import { SignJWT, importPKCS8 } from 'jose';

const FIREBASE_WEB_API_KEY = 'AIzaSyBFlL6ncVF0-pDU-uHQ7Q7Z61dOAjm5dNE';

// ---- duplicated from gumroad-webhook.js on purpose - see that file's
// header comment for why there's no shared module between Functions. ----
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

function toFirestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') out[key] = { stringValue: value };
    else if (typeof value === 'number') out[key] = { doubleValue: value };
    else if (typeof value === 'boolean') out[key] = { booleanValue: value };
    else if (value === null) out[key] = { nullValue: null };
  }
  return out;
}

async function patchDoc(env, path, fields) {
  const accessToken = await getFirestoreAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const maskParams = Object.keys(fields)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?${maskParams}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: toFirestoreFields(fields) }),
  });

  if (!res.ok) {
    throw new Error(`Firestore patch failed: ${res.status} ${await res.text()}`);
  }
}

async function getDoc(env, path) {
  const accessToken = await getFirestoreAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const out = {};
  for (const [k, v] of Object.entries(data.fields || {})) {
    out[k] = v.stringValue ?? v.doubleValue ?? v.booleanValue ?? null;
  }
  return out;
}

async function deleteDoc(env, path) {
  const accessToken = await getFirestoreAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Firestore delete failed: ${res.status} ${await res.text()}`);
  }
}

// Verifies the caller's Firebase ID token via Identity Toolkit and returns
// { uid, email }, or null if the token is missing/invalid.
async function verifyIdToken(idToken) {
  if (!idToken) return null;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user = data.users && data.users[0];
  if (!user || !user.localId) return null;
  return { uid: user.localId, email: (user.email || '').toLowerCase() };
}

export async function onRequestPost({ request, env }) {
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    const verified = await verifyIdToken(idToken);
    if (!verified) {
      return new Response(JSON.stringify({ error: 'invalid or missing auth token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { uid, email } = verified;
    if (!email) {
      return new Response(JSON.stringify({ claimed: false, reason: 'account has no email' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const pendingPath = `pendingPlans/${encodeURIComponent(email)}`;
    const pending = await getDoc(env, pendingPath);
    if (!pending || !pending.plan) {
      return new Response(JSON.stringify({ claimed: false, reason: 'no pending plan for this email' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await patchDoc(env, `users/${uid}`, {
      plan: pending.plan,
      planStartDate: pending.planStartDate,
      planInterval: pending.planInterval,
      planExpiresAt: pending.planExpiresAt,
    });
    await deleteDoc(env, pendingPath);

    return new Response(JSON.stringify({ claimed: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('claim-pending-plan: error', e);
    return new Response(JSON.stringify({ error: 'internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
