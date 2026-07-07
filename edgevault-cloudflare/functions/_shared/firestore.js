import { getGoogleAccessToken } from './googleAuth.js';

// Reads users/{uid}.syncToken via the Firestore REST API using an
// admin (service account) token — bypasses Firestore security rules,
// same as firebase-admin would on Netlify.
export async function getUserSyncToken(env, uid) {
  const accessToken = await getGoogleAccessToken(
    env.FIREBASE_SERVICE_ACCOUNT,
    'https://www.googleapis.com/auth/datastore'
  );

  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore read failed: ' + res.status);

  const doc = await res.json();
  return doc.fields?.syncToken?.stringValue || null;
}

// Looks through users/{uid}/accounts/* to find which account a given
// syncToken belongs to. Returns { accountId, name } or null if no match.
export async function getAccountBySyncToken(env, uid, syncToken) {
  const accessToken = await getGoogleAccessToken(
    env.FIREBASE_SERVICE_ACCOUNT,
    'https://www.googleapis.com/auth/datastore'
  );

  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}/accounts`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore read failed: ' + res.status);

  const data = await res.json();
  const docs = data.documents || [];

  for (const doc of docs) {
    const token = doc.fields?.syncToken?.stringValue;
    if (token && token === syncToken) {
      const parts = doc.name.split('/');
      return { accountId: parts[parts.length - 1], name: doc.fields?.name?.stringValue || parts[parts.length - 1] };
    }
  }
  return null;
}

// Reads users/{uid}.plan and .planExpiresAt — the same fields the client
// reads via metaDocRef(uid) to compute window._evHasPaid. `plan` is only
// ever written by paystack-webhook.js after a real signature-verified
// charge, and planExpiresAt already has PLAN_GRACE_DAYS baked in, so a
// straight "is it in the future" check here mirrors the client exactly.
// Returns { plan, planExpiresAt } — both null if the doc/fields don't exist.
export async function getUserPlanStatus(env, uid) {
  const accessToken = await getGoogleAccessToken(
    env.FIREBASE_SERVICE_ACCOUNT,
    'https://www.googleapis.com/auth/datastore'
  );

  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (res.status === 404) return { plan: null, planExpiresAt: null };
  if (!res.ok) throw new Error('Firestore read failed: ' + res.status);

  const doc = await res.json();
  return {
    plan: doc.fields?.plan?.stringValue || null,
    planExpiresAt: doc.fields?.planExpiresAt?.stringValue || null,
  };
}
