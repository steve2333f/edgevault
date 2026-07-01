# Edge Vault — Cloudflare Pages migration

## What changed
- `index.html` — the 4 backend calls now hit `/api/...` instead of `/.netlify/functions/...`
- `functions/api/*.js` — rewritten versions of your 4 backend endpoints, built for
  Cloudflare's Workers runtime (no Node.js, so no `firebase-admin`; Firebase ID
  tokens are verified with the `jose` library against Google's public keys instead)
- `functions/_shared/*.js` — shared helpers (Firebase token check, Google service-account
  auth for Firestore, Supabase admin client)

## 1. Deploy
Easiest path is the Cloudflare dashboard, no local build needed:

1. Push this folder to a GitHub repo (or drag-and-drop deploy with Wrangler — see below)
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → connect the repo
3. Build settings:
   - Build command: `npm install` (Cloudflare needs this to fetch `jose` and `@supabase/supabase-js`)
   - Build output directory: `/`
4. Deploy. Cloudflare auto-detects `functions/` and wires up `/api/*` routes.

Or via Wrangler CLI, from this folder:
```
npm install
npx wrangler pages deploy . --project-name=edge-vault
```

## 2. Set environment variables
Cloudflare dashboard → your Pages project → **Settings → Environment variables**
(set these for both Production and Preview):

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → **service_role** key (secret, not anon) |
| `FIREBASE_PROJECT_ID` | `utumisgi` (from your firebaseConfig in index.html) |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project Settings → Service Accounts → **Generate new private key** → paste the entire downloaded JSON file as one string |

Mark `SUPABASE_SERVICE_ROLE_KEY` and `FIREBASE_SERVICE_ACCOUNT` as **secret/encrypted** — never expose these client-side.

## 3. Point the EA at your new domain
In the app's MT5 Auto Sync tab, tap **Copy EA** again and re-paste it into MetaEditor —
the URL now points at `/api/ea-insert` on whatever domain Cloudflare gives your Pages
project (or your custom domain once attached).

## 4. Supabase Storage bucket
Screenshot uploads now write to `{uid}/{tradeId}_{stage}_{timestamp}.{ext}` inside your
existing `Edge vault` bucket (previously the path scheme was inside the old Netlify
function, which wasn't available to port exactly — but it's the same bucket, so old
screenshot URLs already saved in Firestore keep working; only new uploads use this path).
Make sure the bucket is still set to public read (same as before) so `getPublicUrl` works.

## Notes on what's NOT ported automatically
- DNS / custom domain: attach it in Cloudflare Pages → Custom domains
- Any Netlify-side redirects, headers, or `netlify.toml` rules — none were found
  referenced in your HTML, but if you had a separate `netlify.toml` file, it wasn't
  uploaded, so re-check for any redirect/header rules you relied on
