import { getGoogleAccessToken } from './googleAuth.js';

// Reads users/{uid}.syncToken via the Firestore REST API using an
// admin (service account) token — bypasses Firestore security rules,
// same as firebase-admin would on Netlify.
export async function getUserSyncToken(env, uid) {
  const accessToken = await getGoogleAccessToken(
    env.FIREBASE_SERVICE_ACCOUNT,
    'https://www.googleapis.com/auth/datastore.readonly'
  );

  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Firestore read failed: ' + res.status);

  const doc = await res.json();
  return doc.fields?.syncToken?.stringValue || null;
}
