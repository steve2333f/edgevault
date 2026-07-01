import { verifyFirebaseIdToken, getBearerToken, json } from '../_shared/firebaseAuth.js';
import { supabaseAdmin } from '../_shared/supabase.js';

export async function onRequestGet({ request, env }) {
  const idToken = getBearerToken(request);
  if (!idToken) return json({ error: 'Missing auth token' }, 401);

  let uid;
  try {
    uid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch (e) {
    return json({ error: 'Invalid auth token' }, 401);
  }

  const supabase = supabaseAdmin(env);
  const { data, error } = await supabase
    .from('ea_trades')
    .select('*')
    .eq('user_id', uid)
    .order('inserted_at', { ascending: false });

  if (error) return json({ error: error.message }, 500);
  return json(data, 200);
}
