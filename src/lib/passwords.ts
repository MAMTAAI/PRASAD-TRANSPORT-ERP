// 🔐 Password hashing — PBKDF2-HMAC-SHA256 via Web Crypto.
// Interim measure until Firebase Auth migration (Phase 1): passwords are never
// stored or compared in plaintext. Node's crypto.pbkdf2Sync produces identical
// output, so the migration script (scripts/migrate-passwords.cjs) matches this.

export const PASSWORD_ITERATIONS = 100000;
export const PASSWORD_ALGO = 'PBKDF2-SHA256-100000';

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function derive(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: PASSWORD_ITERATIONS },
    key,
    256
  );
  return toHex(bits);
}

export async function hashPassword(password: string): Promise<{ saltHex: string; hashHex: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = toHex(salt.buffer);
  return { saltHex, hashHex: await derive(password, saltHex) };
}

export async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  if (!saltHex || !hashHex) return false;
  return (await derive(password, saltHex)) === hashHex;
}
