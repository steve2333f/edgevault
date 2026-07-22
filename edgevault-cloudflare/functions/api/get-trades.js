import { verifyFirebaseIdToken, getBearerToken, json } from '../_shared/firebaseAuth.js';
import { supabaseAdmin } from '../_shared/supabase.js';
import { SignJWT, importPKCS8 } from 'jose';

// ---------------------------------------------------------------------
// PLAN CHECK - EA sync (MT4/MT5/cTrader) is a Basic+ feature. The client
// already hides the Sync tab from Free users, but that's UI only - this
// endpoint is what actually hands back EA-synced trade data, so it needs
// its own check. Otherwise anyone with a valid Firebase ID token (e.g. a
// lapsed Free user whose EA is still quietly pushing trades in the
// background) could call this URL directly and pull data they're not
// entitled to, bypassing the UI entirely.
//
// Mirrors the everPaid/lapsed logic in index.html's
// ensurePlanFromUrlOrAccount exactly, so "who's allowed to sync" never
// drifts between the client and this endpoint:
//   everPaid = plan is 'basic' | 'pro' | 'elite'
//   lapsed   = everPaid && planExpiresAt has passed
//   allowed  = everPaid && !lapsed
// ---------------------------------------------------------------------

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

async function getUserPlanFields(env, uid) {
  const accessToken = await getFirestoreAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return { plan: null, planExpiresAt: null };
  if (!res.ok) throw new Error(`Firestore get failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const fields = data.fields || {};
  return {
    plan: fields.plan?.stringValue ?? null,
    planExpiresAt: fields.planExpiresAt?.stringValue ?? null,
  };
}

async function isEaSyncAllowed(env, uid) {
  const { plan, planExpiresAt } = await getUserPlanFields(env, uid);
  const everPaid = plan === 'basic' || plan === 'pro' || plan === 'elite';
  if (!everPaid) return false;

  if (planExpiresAt) {
    const expiry = new Date(planExpiresAt + 'T00:00:00Z');
    if (!isNaN(expiry.getTime()) && expiry.getTime() < Date.now()) {
      return false; // lapsed - same as everPaid && !lapsed being false client-side
    }
  }
  return true;
}

export async function onRequestGet({ request, env }) {
  const idToken = getBearerToken(request);
  if (!idToken) return json({ error: 'Missing auth token' }, 401);

  let uid;
  try {
    uid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch (e) {
    // TEMP DEBUG: return the real error so we can see why token
    // verification is failing/hanging. Remove `detail` once fixed.
    return json({ error: 'Invalid auth token', detail: e.message }, 401);
  }

  try {
    const allowed = await isEaSyncAllowed(env, uid);
    if (!allowed) {
      return json({ error: 'EA sync requires a paid plan (Basic, Pro, or Elite).' }, 403);
    }
  } catch (e) {
    // If the plan check itself fails (Firestore hiccup, etc.) fail closed
    // rather than silently letting an unverified request through.
    return json({ error: 'Could not verify plan', detail: e.message }, 500);
  }

  const url = new URL(request.url);
  const accountId = url.searchParams.get('accountId') || 'account-1';

  const supabase = supabaseAdmin(env);
  const { data, error } = await supabase
    .from('ea_trades')
    .select('*')
    .eq('user_id', uid)
    .eq('account_id', accountId)
    .order('inserted_at', { ascending: false });

  if (error) return json({ error: error.message }, 500);
  return json(data, 200);
}
