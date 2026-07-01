// Exchanges a Firebase/GCP service account key for a short-lived Google
// OAuth2 access token, so we can call the Firestore REST API server-side
// (needed to check the EA sync token, since the EA has no Firebase login).
import { SignJWT, importPKCS8 } from 'jose';

export async function getGoogleAccessToken(serviceAccountJsonString, scope) {
  const sa = JSON.parse(serviceAccountJsonString);
  const privateKey = await importPKCS8(sa.private_key, 'RS256');
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error('Google auth failed: ' + JSON.stringify(data));
  return data.access_token;
}
