import { randomBytes, randomUUID } from 'node:crypto'

// Ephemeral values for mock/loopback servers only. No account credentials are stored in source.
export function syntheticCredentials() {
  return { username: `fixture-${randomUUID()}`, password: syntheticToken() }
}

export function syntheticToken() {
  return randomBytes(24).toString('base64url')
}
