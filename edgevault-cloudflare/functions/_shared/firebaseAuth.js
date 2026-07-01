// Verifies Firebase Auth ID tokens WITHOUT the firebase-admin SDK, because
// firebase-admin depends on Node.js APIs that don't exist in Cloudflare's
// Workers runtime. `jose` runs on WebCrypto so it works here.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let jwks; // cached across requests within the same isolate

export async function verifyFirebaseIdToken(idToken, projectId) {
  if (!idToken) throw new Error('Missing ID token');
  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URL));

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });

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
