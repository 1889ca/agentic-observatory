# WebAuthn/Passkey Authentication

> Challenge-response passkey flow with session tokens, credential storage, and automatic expiry.

## Problem

Traditional password authentication is vulnerable to phishing, credential stuffing, and brute force attacks. For an agentic system that manages sensitive operations, authentication must be both strong and frictionless -- users should be able to authenticate without typing passwords while maintaining high security guarantees.

## Context

Riley needs secure user authentication for its web interface and API. The system is single-tenant (one user) but still requires proper authentication to prevent unauthorized access. WebAuthn/passkeys provide hardware-backed authentication that resists phishing and replay attacks.

## Solution

The authentication flow uses the WebAuthn standard with three key components:

1. **Registration** -- generates a challenge, the client creates a credential using a platform authenticator (Touch ID, Windows Hello, security key), and the server stores the credential public key
2. **Authentication** -- generates a new challenge, the client signs it with the stored credential, and the server verifies the signature against the stored public key
3. **Session management** -- on successful authentication, a session token is issued with a 24-hour TTL, stored server-side, and sent as a cookie or bearer token

```js
// Registration: generate challenge and store credential
async function beginRegistration(userId) {
  const challenge = crypto.randomBytes(32);
  await storeChallenge(userId, challenge);
  return { challenge, rp: { name: 'Riley' }, user: { id: userId } };
}

async function completeRegistration(userId, credential) {
  const challenge = await getChallenge(userId);
  verifyRegistration(credential, challenge);
  await storeCredential(userId, credential.id, credential.publicKey);
}

// Authentication: verify signature, issue session
async function completeAuthentication(userId, assertion) {
  const challenge = await getChallenge(userId);
  const credential = await getCredential(userId, assertion.id);
  verifyAssertion(assertion, challenge, credential.publicKey);
  const token = crypto.randomBytes(32).toString('hex');
  await storeSession(token, userId, { expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return token;
}
```

## Implications

- **No passwords to steal** -- credentials are hardware-bound and never leave the device
- **Session tokens expire after 24 hours** -- forces re-authentication daily, limiting the window if a token is compromised
- **Single-tenant simplification** -- the credential store is minimal since there is only one user
- **Device dependency** -- losing access to the authenticator device requires a recovery flow

## Related Patterns

- [Rate Limiting and API Protection](./rate-limiting-and-api-protection.md)
- [Audit Trail with PII Sanitization](./audit-trail-with-pii-sanitization.md)
