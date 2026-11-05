import { b64decode, b64encode, concat, sha256Hex, td, te, toHex } from "./util";

/**
 * Crypto layer (Web Crypto only, works on desktop and mobile).
 *
 *  password --PBKDF2-SHA256(600k, random salt)--> 512 bits
 *      ├─ first 256 bits  : AES-256-GCM key  (encrypt chunks + index)
 *      └─ last  256 bits  : HMAC-SHA256 key  (chunk IDs; hides plaintext hashes from the server)
 *
 * Blob format: [version=1][12-byte random IV][ciphertext || 16-byte GCM tag].
 * The AAD binds a blob to its role/location (chunk id, "index", "check"), so a
 * malicious server cannot swap one blob for another undetected.
 */
export interface Cipher {
  readonly encrypted: boolean;
  encrypt(data: Uint8Array, aad: string): Promise<Uint8Array>;
  decrypt(data: Uint8Array, aad: string): Promise<Uint8Array>;
  /** Content-addressed id of a plaintext chunk. */
  chunkId(data: Uint8Array): Promise<string>;
}

export const plainCipher: Cipher = {
  encrypted: false,
  encrypt: async (d) => d,
  decrypt: async (d) => d,
  chunkId: (d) => sha256Hex(d),
};

export const PBKDF2_ITERATIONS = 600_000;
const BLOB_VERSION = 1;
const CHECK_PLAINTEXT = "webdav-e2ee-sync:ok";

export class AesCipher implements Cipher {
  readonly encrypted = true;
  private constructor(private aes: CryptoKey, private mac: CryptoKey) {}

  static async derive(password: string, salt: Uint8Array, iterations: number): Promise<AesCipher> {
    const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, 512)
    );
    const aes = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
    const mac = await crypto.subtle.importKey("raw", bits.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new AesCipher(aes, mac);
  }

  async encrypt(data: Uint8Array, aad: string): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, this.aes, data)
    );
    return concat([Uint8Array.of(BLOB_VERSION), iv, ct]);
  }

  async decrypt(data: Uint8Array, aad: string): Promise<Uint8Array> {
    if (data.length < 1 + 12 + 16 || data[0] !== BLOB_VERSION) throw new Error("Invalid encrypted blob");
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: data.subarray(1, 13), additionalData: te.encode(aad) },
          this.aes,
          data.subarray(13)
        )
      );
    } catch {
      throw new Error("Decryption failed (wrong password or corrupted data)");
    }
  }

  async chunkId(data: Uint8Array): Promise<string> {
    return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", this.mac, data)));
  }
}

/** Stored unencrypted at <remote>/meta.json. Contains no secrets (salt + a password check blob). */
export interface RemoteMeta {
  v: 1;
  encrypted: boolean;
  kdf?: { salt: string; iterations: number };
  check?: string;
}

export async function newMeta(password: string | null): Promise<{ meta: RemoteMeta; cipher: Cipher }> {
  if (password === null) return { meta: { v: 1, encrypted: false }, cipher: plainCipher };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cipher = await AesCipher.derive(password, salt, PBKDF2_ITERATIONS);
  const check = b64encode(await cipher.encrypt(te.encode(CHECK_PLAINTEXT), "check"));
  return {
    meta: { v: 1, encrypted: true, kdf: { salt: b64encode(salt), iterations: PBKDF2_ITERATIONS }, check },
    cipher,
  };
}

export async function unlock(meta: RemoteMeta, password: string): Promise<Cipher> {
  if (!meta.kdf || !meta.check) throw new Error("Corrupted remote meta.json");
  const cipher = await AesCipher.derive(password, b64decode(meta.kdf.salt), meta.kdf.iterations);
  try {
    const ok = td.decode(await cipher.decrypt(b64decode(meta.check), "check"));
    if (ok !== CHECK_PLAINTEXT) throw new Error();
  } catch {
    throw new Error("Wrong encryption password");
  }
  return cipher;
}
