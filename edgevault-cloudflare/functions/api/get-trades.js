import { verifyFirebaseIdToken, getBearerToken, json } from '../_shared/firebaseAuth.js';
import { supabaseAdmin } from '../_shared/supabase.js';

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
