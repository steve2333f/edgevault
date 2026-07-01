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

  const { tradeId, stage, base64, contentType } = body;
  if (!tradeId || !base64) return json({ error: 'Missing tradeId or image data' }, 400);

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const ext = (contentType || 'image/jpeg').split('/')[1] || 'jpg';
  // Every screenshot lives under the owner's uid folder — this is what
  // screenshot-delete checks against so users can't delete each other's files.
  const path = `${uid}/${tradeId}_${stage || 'screenshot'}_${Date.now()}.${ext}`;

  const supabase = supabaseAdmin(env);
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: contentType || 'image/jpeg',
    upsert: true,
  });
  if (error) return json({ error: error.message }, 500);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return json({ url: data.publicUrl }, 200);
}
