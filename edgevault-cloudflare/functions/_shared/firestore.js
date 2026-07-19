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
// Reads users/{uid}.plan / .planExpiresAt and mirrors the same
// everPaid + lapse check the frontend does in index.html
// (onAuthStateChanged): plan is only ever 'pro' or 'basic' once
// gumroad-webhook.js has recorded a real, verified sale, and
// planExpiresAt already includes the grace period. No doc / no plan
// field / plan not in ('pro','basic') = never paid = not active.
// Returns { active: boolean, plan: string|null, reason: string }.
export async function getUserPlanStatus(env, uid) {
  const accessToken = await getGoogleAccessToken(
    env.FIREBASE_SERVICE_ACCOUNT,
    'https://www.googleapis.com/auth/datastore'
  );
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return { active: false, plan: null, reason: 'no_account' };
  if (!res.ok) throw new Error('Firestore read failed: ' + res.status);
  const doc = await res.json();
  const plan = doc.fields?.plan?.stringValue || null;
  const planExpiresAt = doc.fields?.planExpiresAt?.stringValue || null;

  const everPaid = plan === 'pro' || plan === 'basic';
  if (!everPaid) return { active: false, plan, reason: 'no_active_plan' };

  if (planExpiresAt) {
    const expiry = new Date(planExpiresAt + 'T00:00:00Z');
    if (!isNaN(expiry.getTime()) && expiry.getTime() < Date.now()) {
      return { active: false, plan, reason: 'plan_expired' };
    }
  }

  return { active: true, plan, reason: 'ok' };
}
