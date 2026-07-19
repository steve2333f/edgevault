import { verifyFirebaseIdToken, getBearerToken, json } from '../_shared/firebaseAuth.js';
import { supabaseAdmin } from '../_shared/supabase.js';

// Deletes a single row from ea_trades. Requires a valid Firebase login
// (this is called from the app itself, not the EA - the EA only ever
// inserts). Ownership is enforced by filtering on user_id so one user
// can never delete another user's synced trade even if they guessed
// an id.
export async function onRequestPost({ request, env }) {
  const idToken = getBearerToken(request);
  if (!idToken) return json({ error: 'Missing auth token' }, 401);

  let uid;
  try {
    uid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch (e) {
    return json({ error: 'Invalid auth token', detail: e.message }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const { tradeId } = body;
  if (!tradeId) return json({ error: 'Missing tradeId' }, 400);

  const supabase = supabaseAdmin(env);
  const { data, error } = await supabase
    .from('ea_trades')
    .delete()
    .eq('id', tradeId)
    .eq('user_id', uid)
    .select('id');

  if (error) return json({ error: error.message }, 500);
  if (!data || data.length === 0) {
    // Either it never existed or it belonged to a different user_id -
    // either way, nothing was deleted.
    return json({ error: 'Trade not found' }, 404);
  }

  return json({ ok: true, deletedId: tradeId }, 200);
}
