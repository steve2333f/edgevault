import { json } from '../_shared/firebaseAuth.js';
import { getUserSyncToken } from '../_shared/firestore.js';
import { supabaseAdmin } from '../_shared/supabase.js';

// No Firebase login here on purpose — MT5 can't hold a Firebase session.
// The EA instead proves identity with the per-user sync token that's
// generated client-side and stored in the user's Firestore doc.
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

  let storedToken;
  try {
    storedToken = await getUserSyncToken(env, uid);
  } catch (e) {
    return json({ error: 'Auth check failed' }, 500);
  }
  if (!storedToken || storedToken !== syncToken) {
    return json({ error: 'Invalid sync token' }, 401);
  }

  const supabase = supabaseAdmin(env);
  const { error } = await supabase.from('ea_trades').insert({
    user_id: uid, symbol, type, volume, open_price, close_price,
    open_time, close_time, sl, tp, commission, swap, profit,
  });

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true }, 201);
}
