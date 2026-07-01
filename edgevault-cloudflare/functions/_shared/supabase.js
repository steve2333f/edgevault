import { createClient } from '@supabase/supabase-js';

// Service-role key = full access, bypasses Row Level Security.
// Never send this key to the browser — it only ever lives in
// Cloudflare's server-side environment variables.
export function supabaseAdmin(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}
