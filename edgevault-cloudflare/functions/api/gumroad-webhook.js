// functions/api/gumroad-webhook.js
//
// Cloudflare Pages Function — receives Gumroad Ping events and keeps
// the app's subscription fields (plan, planStartDate, planInterval,
// planExpiresAt) in sync on each user's Firestore doc at users/{uid}.
//
// Mirrors paystack-webhook.js field-for-field so nothing on the client
// needs to change. Two events are handled:
//   resource_name === 'sale'         -> upgrade/renew
//   resource_name === 'cancellation' -> stop future renewal (see below -
//                                       this does NOT downgrade plan)
//
// ---------------------------------------------------------------------
// IMPORTANT DIFFERENCE FROM PAYSTACK: Gumroad's Ping is NOT signed.
// There is no HMAC header to check like x-paystack-signature. Anyone who
// finds this URL could POST fake form data claiming a sale happened.
// To compensate, every 'sale' ping is re-verified server-side against
// Gumroad's own API (GET /v2/sales/{sale_id}) before we trust it and
// write anything to Firestore. A forged POST can invent a sale_id, but
// it won't match a real sale on your account, so the re-fetch fails and
// the event is dropped.
// ---------------------------------------------------------------------
//
// REQUIRED ENV VARS (Cloudflare Pages -> Settings -> Environment variables)
//   GUMROAD_ACCESS_TOKEN   OAuth access token for YOUR Gumroad account.
//                          Create it at gumroad.com/settings/advanced ->
//                          "Applications" -> create an application ->
//                          generate an access token for yourself. Used
//                          only to re-verify sales, never to charge.
//   GUMROAD_PRODUCT_ID     Your EdgeVault product's id (not permalink).
//                          Find it in the URL of the product edit page,
//                          or in any Ping payload's "product_id" field.
//   FIREBASE_PROJECT_ID    same as paystack-webhook.js
//   FIREBASE_CLIENT_EMAIL  same as paystack-webhook.js
//   FIREBASE_PRIVATE_KEY   same as paystack-webhook.js
//   PLAN_GRACE_DAYS        optional, defaults to 2, same purpose as
//                          paystack-webhook.js (covers renewal timing).
//
// ---------------------------------------------------------------------
// HOW uid GETS ATTACHED TO A SALE
// ---------------------------------------------------------------------
// Gumroad has no "metadata" field like Paystack. Instead, any extra query
// param on the checkout link shows up in the ping as url_params[key].
// So links opened FROM INSIDE THE APP (a logged-in user upgrading) should
// include the Firebase uid:
//
//   https://novatrio.gumroad.com/l/edgevault?option=<OPTION_ID>&wanted=true&uid=<firebaseUid>
//
// -> arrives in the ping as the form field "url_params[uid]".
//
// Sales from the LANDING PAGE won't have a uid yet (visitor hasn't signed
// up). For those, we stash the plan under pendingPlans/{email} instead,
// keyed by lowercased email. When that person eventually signs up/logs
// in, the app should check pendingPlans/{their email} once and copy it
// onto their new users/{uid} doc, then delete the pending doc. That claim
// step needs a small addition in index.html's post-login flow — flag if
// you want that written too.
//
// ---------------------------------------------------------------------
// HOW BASIC VS PRO VS ELITE IS DECIDED
// ---------------------------------------------------------------------
// We read it from the ping's own "variants" field (e.g. {"Tier":"Pro"}),
// not from anything the buyer or the URL supplied — this comes from
// Gumroad's sale record itself, so it can't be spoofed by a crafted link.
// Elite is just a third variant option on the same product (same
// GUMROAD_PRODUCT_ID) - planFromVariants() checks for "elite" before
// "pro" so it doesn't get miscategorized.
//
// ---------------------------------------------------------------------
// CANCELLATIONS: NO IMMEDIATE DOWNGRADE
// ---------------------------------------------------------------------
// A cancellation just means "won't renew" - the buyer already paid
// through their current billing period, and that period is enforced by
// planExpiresAt (set with a grace period on every 'sale' ping below).
// We deliberately do NOT overwrite `plan` here. An earlier version of
// this handler force-set plan to 'basic' on cancellation, which stripped
// Pro subscribers of Pro access the instant they hit cancel - even
// though they'd already paid for the rest of that period.
//
// Instead: index.html's own plan-resolution logic (everPaid + a lapsed
// check against planExpiresAt) already drops a user into the 14-day free
// trial automatically once planExpiresAt actually passes, regardless of
// what `plan` still says in Firestore. So nothing needs to happen here
// beyond leaving a record of the cancellation.
//
// CANCELLATIONS ALSO NEED A SEPARATE ONE-TIME SETUP
// ---------------------------------------------------------------------
// The basic account-level "Ping" (Settings -> Advanced) only ever fires
// 'sale' events. To also get 'cancellation' events at this same URL, you
// must register a resource subscription once via the API:
//
//   curl https://api.gumroad.com/v2/resource_subscriptions \
//     -d "access_token=YOUR_ACCESS_TOKEN" \
//     -d "resource_name=cancellation" \
//     -d "post_url=https://<your-worker-domain>/api/gumroad-webhook"
//
// Do this once from your machine (or Postman) after deploying. Nothing
// else needs to change on this file for that to start arriving.

const VALID_INTERVALS = ['weekly', 'monthly', 'yearly'];

// Gumroad's "recurrence" values: monthly, quarterly, biannually, yearly.
// We only support weekly/monthly/yearly today, so quarterly/biannually
// fall back to monthly rather than failing the whole webhook.
function mapGumroadRecurrence(recurrence) {
  switch (recurrence) {
    case 'monthly': return 'monthly';
    case 'yearly': return 'yearly';
    default: return 'monthly';
  }
}

// Identical to paystack-webhook.js - kept duplicated intentionally, no
// shared module system between the two Functions.
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
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay)));
}

function toISODateString(d) {
  return d.toISOString().slice(0, 10);
}

// Figures out 'basic' vs 'pro' vs 'elite' from the ping's own variants
// field, e.g. { "Tier": "Pro" } or { "Tier": "Elite" }. Checked in order
// elite -> pro -> basic, since "Elite" doesn't contain "pro" but we still
// want it caught before falling through to the basic default. Falls back
// to 'basic' if we can't find either word anywhere in the variant values.
function planFromVariants(variantsRaw) {
  if (!variantsRaw) return 'basic';
  let variants = variantsRaw;
  if (typeof variantsRaw === 'string') {
    try { variants = JSON.parse(variantsRaw); } catch (e) { return 'basic'; }
  }
  const joined = Object.values(variants).join(' ').toLowerCase();
  if (joined.includes('elite')) return 'elite';
  if (joined.includes('pro')) return 'pro';
  return 'basic';
}

// ---- Re-verify a sale against Gumroad's own API before trusting it ----
// This is our substitute for Paystack's HMAC signature check.
async function verifySaleWithGumroad(saleId, env) {
  const res = await fetch(`https://api.gumroad.com/v2/sales/${saleId}`, {
    headers: { Authorization: `Bearer ${env.GUMROAD_ACCESS_TOKEN}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.success || !data.sale) return null;
  return data.sale;
}

// ---- Firestore REST write via a Google service account JWT ----
// Identical approach to paystack-webhook.js.
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

// ---- Main handler ----
export async function onRequestPost({ request, env }) {
  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);

  // Gumroad flattens url_params as "url_params[uid]" style keys.
  const uidFromUrl = params.get('url_params[uid]');
  const resourceName = params.get('resource_name') || 'sale';
  const gracePeriodDays = Number(env.PLAN_GRACE_DAYS) || 2;

  try {
    if (resourceName === 'sale') {
      const productId = params.get('product_id');
      if (productId !== env.GUMROAD_PRODUCT_ID) {
        // Ping for a different product on the same account - ignore.
        return new Response('OK', { status: 200 });
      }

      if (params.get('test') === 'true') {
        console.log('gumroad-webhook: test ping received, not writing to Firestore');
        return new Response('OK', { status: 200 });
      }

      const saleId = params.get('sale_id');
      const verifiedSale = await verifySaleWithGumroad(saleId, env);
      if (!verifiedSale) {
        console.warn('gumroad-webhook: could not verify sale_id against Gumroad API, dropping', saleId);
        return new Response('OK', { status: 200 }); // don't invite retries on a forged/bad event
      }

      const plan = planFromVariants(params.get('variants'));
      const interval = mapGumroadRecurrence(params.get('recurrence'));
      const planStartDate = params.get('sale_timestamp')
        ? toISODateString(new Date(params.get('sale_timestamp')))
        : toISODateString(new Date());
      const periodEnd = computePeriodEnd(planStartDate, interval);
      const expiresWithGrace = periodEnd
        ? new Date(periodEnd.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000)
        : null;

      const planFields = {
        plan,
        planStartDate,
        planInterval: interval,
        planExpiresAt: expiresWithGrace ? toISODateString(expiresWithGrace) : null,
      };

      const email = (params.get('email') || '').toLowerCase();
      const subscriptionId = params.get('subscription_id');

      if (uidFromUrl) {
        await patchDoc(env, `users/${uidFromUrl}`, planFields);
      } else if (email) {
        // No uid yet - buyer hasn't signed into the app. Stash it so the
        // app can claim it on first login (see note at top of file).
        await patchDoc(env, `pendingPlans/${encodeURIComponent(email)}`, planFields);
      } else {
        console.warn('gumroad-webhook: sale with no uid and no email, cannot attach', saleId);
      }

      // Remember which uid owns this subscription so a later cancellation
      // (which has no url_params of its own) can find them again.
      if (subscriptionId && uidFromUrl) {
        await patchDoc(env, `subscriptionOwners/${subscriptionId}`, { uid: uidFromUrl });
      }
    } else if (resourceName === 'cancellation') {
      // See the "CANCELLATIONS: NO IMMEDIATE DOWNGRADE" note at the top
      // of this file. We look the owner up (useful for logging / any
      // future use) but deliberately do NOT touch their `plan` field.
      // planExpiresAt - already set by the last 'sale' ping, grace days
      // included - is what actually governs when their access ends and
      // they fall through to the 14-day free trial on the client.
      const subscriptionId = params.get('subscription_id');
      if (!subscriptionId) {
        console.warn('gumroad-webhook: cancellation with no subscription_id, skipping');
        return new Response('OK', { status: 200 });
      }
      const owner = await getDoc(env, `subscriptionOwners/${subscriptionId}`);
      if (!owner || !owner.uid) {
        console.warn('gumroad-webhook: cancellation for unknown subscription_id', subscriptionId);
        return new Response('OK', { status: 200 });
      }
      console.log('gumroad-webhook: cancellation received for uid', owner.uid, '- no downgrade applied, access continues until planExpiresAt');
    }
    // Other resource_names (refund, dispute, etc.) intentionally ignored
    // for now - add cases here later if you register those subscriptions.
  } catch (e) {
    console.error('gumroad-webhook: error processing event', e);
    // Still return 200 - Gumroad retries hourly for 3 hours on non-2xx,
    // and an error here usually won't be fixed by a retry.
  }

  return new Response('OK', { status: 200 });
}
