// functions/api/paystack-webhook.js
//
// Cloudflare Pages Function — receives Paystack webhook events and keeps
// the app's subscription fields (plan, planStartDate, planInterval,
// planExpiresAt) in sync on each user's Firestore doc at users/{uid}.
//
// This mirrors the exact fields the app already reads in
// ensurePlanFromUrlOrAccount() in index.html — nothing on the client needs
// to change once this is wired up. The client-side expiry check will just
// start seeing real dates instead of the "?plan=pro" URL fallback.
//
// ---------------------------------------------------------------------
// REQUIRED ENV VARS (set in Cloudflare Pages → Settings → Environment
// variables). Use the TEST versions while Paystack is in test mode —
// swapping to live later is just swapping these values, no code changes.
// ---------------------------------------------------------------------
//   PAYSTACK_SECRET_KEY     e.g. sk_test_xxxxxxxx (or sk_live_xxxx later)
//   FIREBASE_PROJECT_ID     e.g. utumisgi
//   FIREBASE_CLIENT_EMAIL   service account email (from Firebase console →
//                           Project Settings → Service Accounts)
//   FIREBASE_PRIVATE_KEY    service account private key (paste with \n
//                           escaped, or use Cloudflare's multiline secret
//                           input if available)
//   PLAN_GRACE_DAYS         optional, defaults to 2 — extra days added
//                           after the computed period end before the app
//                           actually cuts a user off, to cover Paystack's
//                           automatic retries on a failed renewal charge.
//
// ---------------------------------------------------------------------
// IMPORTANT: how uid gets attached to a transaction
// ---------------------------------------------------------------------
// This webhook has no way to know WHICH app user a payment belongs to
// unless you attach it yourself when the payment is started. When you
// initialize the Paystack transaction/subscription (from your landing
// page or in-app upgrade flow), pass:
//
//   metadata: { uid: firebaseUid, interval: 'monthly' | 'weekly' | 'yearly' }
//
// `interval` here is YOUR app's own interval value, not Paystack's plan
// interval string — this avoids relying on Paystack's plan-interval
// naming (which uses 'annually', not 'yearly') matching your schema.
// If you'd rather infer it from Paystack's own subscription/plan object
// instead, see mapPaystackInterval() below — it's here as a fallback.
//
// ---------------------------------------------------------------------

const VALID_INTERVALS = ['weekly', 'monthly', 'yearly'];

// Fallback mapping only used if metadata.interval wasn't provided.
// Paystack plan intervals: hourly, daily, weekly, monthly, biannually,
// annually. We only support weekly/monthly/yearly today, so anything else
// (hourly, daily, biannually) falls back to 'monthly' rather than failing
// the whole webhook.
function mapPaystackInterval(paystackInterval) {
  switch (paystackInterval) {
    case 'weekly': return 'weekly';
    case 'monthly': return 'monthly';
    case 'annually': return 'yearly';
    default: return 'monthly';
  }
}

// Same period-end math as computePeriodEnd() in index.html — kept in sync
// intentionally as plain duplicated logic (this is a separate runtime, no
// shared module system between the Worker and the single-file app).
function computePeriodEnd(startDateStr, interval) {
  const start = new Date(startDateStr + 'T00:00:00Z');
  if (isNaN(start.getTime())) return null;

  if (interval === 'weekly') {
    return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  if (interval === 'yearly') {
    const year = start.getUTCFullYear() + 1;
    const month = start.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay)));
  }
  // monthly (default)
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay)));
}

function toISODateString(d) {
  return d.toISOString().slice(0, 10);
}

// ---- Signature verification ----
// Paystack signs the raw request body with HMAC-SHA512 using your secret
// key. We must verify against the RAW bytes before any JSON parsing —
// re-serializing JSON can change whitespace/key order and break the check.
async function verifyPaystackSignature(rawBody, signatureHeader, secretKey) {
  if (!signatureHeader || !secretKey) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const computedHex = [...new Uint8Array(sigBuffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time-ish comparison (good enough at this string length; a
  // true constant-time compare isn't critical here since this isn't a
  // password check, but avoids trivially obvious short-circuiting).
  if (computedHex.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

// ---- Firestore REST write via a Google service account JWT ----
// Cloudflare Workers can't run the firebase-admin SDK (same reason the app
// already moved to `jose` for ID token verification instead), so writes go
// through the Firestore REST API with a short-lived OAuth access token
// minted from the service account's private key using `jose`.
import { SignJWT, importPKCS8 } from 'jose';

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

// Merge-style PATCH on users/{uid} with only the fields we're touching,
// using Firestore's updateMask so we don't clobber other fields on the doc.
async function patchUserPlanFields(env, uid, fields) {
  const accessToken = await getFirestoreAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;

  const fieldKeys = Object.keys(fields);
  const maskParams = fieldKeys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?${maskParams}`;

  const firestoreFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') firestoreFields[key] = { stringValue: value };
    else if (typeof value === 'number') firestoreFields[key] = { doubleValue: value };
    else if (typeof value === 'boolean') firestoreFields[key] = { booleanValue: value };
    else if (value === null) firestoreFields[key] = { nullValue: null };
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: firestoreFields }),
  });

  if (!res.ok) {
    throw new Error(`Firestore patch failed: ${res.status} ${await res.text()}`);
  }
}

// ---- Main handler ----
export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-paystack-signature');

  const valid = await verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY);
  if (!valid) {
    // Don't leak details about why — just reject.
    return new Response('Invalid signature', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Bad JSON', { status: 400 });
  }

  const gracePeriodDays = Number(env.PLAN_GRACE_DAYS) || 2;

  try {
    switch (event.event) {
      // Fired for both a first payment and a successful subscription
      // renewal charge — the one event that actually means "money moved".
      case 'charge.success': {
        const data = event.data || {};
        const metadata = data.metadata || {};
        const uid = metadata.uid;

        if (!uid) {
          console.warn('paystack-webhook: charge.success with no metadata.uid, skipping', data.reference);
          break; // Still respond 200 below — nothing more we can do with this event.
        }

        const interval = VALID_INTERVALS.includes(metadata.interval)
          ? metadata.interval
          : mapPaystackInterval(data.plan_object?.interval || data.plan?.interval);

        const planStartDate = data.paid_at
          ? toISODateString(new Date(data.paid_at))
          : toISODateString(new Date());

        const periodEnd = computePeriodEnd(planStartDate, interval);
        const expiresWithGrace = periodEnd
          ? new Date(periodEnd.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000)
          : null;

        await patchUserPlanFields(env, uid, {
          plan: 'pro',
          planStartDate,
          planInterval: interval,
          planExpiresAt: expiresWithGrace ? toISODateString(expiresWithGrace) : null,
        });
        break;
      }

      // Subscription explicitly canceled — downgrade right away rather
      // than waiting for planExpiresAt to lapse naturally, since the
      // person (or Paystack, after repeated failed retries) has already
      // ended it.
      case 'subscription.disable': {
        const data = event.data || {};
        const uid = data.customer?.metadata?.uid || data.metadata?.uid;
        if (!uid) {
          console.warn('paystack-webhook: subscription.disable with no uid, skipping');
          break;
        }
        await patchUserPlanFields(env, uid, { plan: 'basic' });
        break;
      }

      // Failed renewal charge — deliberately NOT downgrading here.
      // Paystack automatically retries a failed renewal for a few days,
      // and planExpiresAt already has PLAN_GRACE_DAYS built in from the
      // last successful charge, so this just logs for visibility.
      case 'invoice.payment_failed': {
        console.warn('paystack-webhook: payment_failed', event.data?.subscription?.subscription_code);
        break;
      }

      default:
        // Unhandled event types are fine to ignore — Paystack sends many
        // events we don't act on.
        break;
    }
  } catch (e) {
    console.error('paystack-webhook: error processing event', e);
    // Still return 200 — Paystack will retry on non-2xx, and we don't want
    // retries hammering us for an error that a retry won't fix (e.g. a bad
    // metadata.uid). Errors here should be caught via logging/alerting,
    // not via Paystack's retry mechanism.
  }

  return new Response('OK', { status: 200 });
}
