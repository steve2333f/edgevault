// Verifies Firebase Auth ID tokens WITHOUT the firebase-admin SDK, because
// firebase-admin depends on Node.js APIs that don't exist in Cloudflare's
// Workers runtime. `jose` runs on WebCrypto so it works here.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let jwks; // cached across requests within the same isolate

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)
    ),
  ]);
}

export async function verifyFirebaseIdToken(idToken, projectId) {
  if (!idToken) throw new Error('Missing ID token');
  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URL));

  // TEMP DEBUG: wrap in a timeout so a stalled JWKS fetch fails fast and
  // visibly instead of hanging the request indefinitely.
  const { payload } = await withTimeout(
    jwtVerify(idToken, jwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    }),
    8000,
    'jwtVerify/JWKS fetch'
  );

  if (!payload.sub) throw new Error('Token missing subject');
  return payload.sub; // this is the Firebase uid
}

export function getBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
