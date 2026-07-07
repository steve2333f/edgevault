import { json } from '../_shared/firebaseAuth.js';
import { getAccountBySyncToken, getUserSyncToken, getUserPlanStatus } from '../_shared/firestore.js';
import { supabaseAdmin } from '../_shared/supabase.js';

// No Firebase login here on purpose — MT5 can't hold a Firebase session.
// The EA instead proves identity with a per-account sync token, stored
// under users/{uid}/accounts/{accountId}.syncToken.
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const {
    uid, syncToken, symbol, type, volume, open_price, close_price,
    open_time, close_time, sl, tp, commission, swap, profit,
  } = body;

  if (!uid || !syncToken) return json({ error: 'Missing uid or syncToken' }, 400);

  let accountId;
  try {
    const account = await getAccountBySyncToken(env, uid, syncToken);
    if (account) {
      accountId = account.accountId;
    } else {
      // Fallback for users who haven't migrated to the accounts
      // subcollection yet — check the old single-account token.
      const legacyToken = await getUserSyncToken(env, uid);
      if (legacyToken && legacyToken === syncToken) accountId = 'account-1';
    }
  } catch (e) {
    // TEMP DEBUG: return the real error so we can see why the Firestore/
    // Google auth call is throwing. Remove `detail` once fixed.
    return json({ error: 'Auth check failed', detail: e.message }, 500);
  }

  if (!accountId) return json({ error: 'Invalid sync token' }, 401);

  // Plan gate — mirrors window._evHasPaid client-side exactly: `plan` is
  // only ever set by paystack-webhook.js after a real charge, and
  // planExpiresAt already includes PLAN_GRACE_DAYS, so once it's in the
  // past the subscription is genuinely lapsed, not just mid-grace-period.
  // Without this, a canceled/lapsed EA keeps writing trades for free
  // forever, since the EA itself has no awareness of billing status.
  let planStatus;
  try {
    planStatus = await getUserPlanStatus(env, uid);
  } catch (e) {
    return json({ error: 'Plan check failed', detail: e.message }, 500);
  }

  const { plan, planExpiresAt } = planStatus;
  const everPaid = plan === 'pro' || plan === 'basic';
  let lapsed = false;
  if (everPaid && planExpiresAt) {
    const expiry = new Date(planExpiresAt + 'T00:00:00Z');
    if (!isNaN(expiry.getTime()) && expiry.getTime() < Date.now()) lapsed = true;
  }

  if (!everPaid || lapsed) {
    return json({ error: 'Subscription inactive' }, 402);
  }

  const supabase = supabaseAdmin(env);
  const { error } = await supabase.from('ea_trades').insert({
    user_id: uid, account_id: accountId, symbol, type, volume, open_price, close_price,
    open_time, close_time, sl, tp, commission, swap, profit,
  });

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, accountId }, 201);
}
