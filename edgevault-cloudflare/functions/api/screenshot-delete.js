import { verifyFirebaseIdToken, getBearerToken, json } from '../_shared/firebaseAuth.js';
import { supabaseAdmin } from '../_shared/supabase.js';

const BUCKET = 'Edge vault';

export async function onRequestPost({ request, env }) {
  const idToken = getBearerToken(request);
  if (!idToken) return json({ error: 'Missing auth token' }, 401);

  let uid;
  try {
    uid = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch {
    return json({ error: 'Invalid auth token' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { path } = body;
  if (!path) return json({ error: 'Missing path' }, 400);

  // Only allow a user to delete files inside their own uid folder.
  if (!path.startsWith(`${uid}/`)) {
    return json({ error: 'Forbidden' }, 403);
  }

  const supabase = supabaseAdmin(env);
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true }, 200);
}
