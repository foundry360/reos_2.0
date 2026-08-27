import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const SALT = "reos-platform-secrets-v1";

function getEncryptionKey(): Buffer | null {
  const raw = process.env.PLATFORM_SECRETS_ENCRYPTION_KEY?.trim();
  if (!raw) return null;

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  return scryptSync(raw, SALT, 32);
}

export function canEncryptPlatformSecrets(): boolean {
  return getEncryptionKey() !== null;
}

export function encryptPlatformSecret(plaintext: string): {
  ciphertext: string;
  iv: string;
  authTag: string;
} {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error(
      "PLATFORM_SECRETS_ENCRYPTION_KEY is not configured. Add a 32-byte hex key to enable encrypted storage.",
    );
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptPlatformSecret(payload: {
  ciphertext: string;
  iv: string;
  authTag: string;
}): string {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error("PLATFORM_SECRETS_ENCRYPTION_KEY is not configured.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export function secretHint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}
