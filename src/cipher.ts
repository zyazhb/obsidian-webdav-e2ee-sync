import { Cipher, decryptedSize } from "@fyears/rclone-crypt";

/**
 * Storage format = rclone "crypt" (filename_encryption=standard, directory_name_encryption=true,
 * filename_encoding=base32). A vault stored this way can be read/written by stock rclone at any
 * time, so you are never locked in to this plugin:
 *
 *   rclone config  -> type: crypt, remote: <webdav remote>:<folder>, same password / password2
 *
 * Content: NaCl secretbox (XSalsa20-Poly1305) in 64 KiB blocks. Names: AES-EME, base32.
 * Keys: scrypt (N=16384, r=8, p=1). No custom cryptography lives in this plugin.
 */
export interface FileCipher {
  readonly encrypted: boolean;
  /** vault path -> server path */
  encName(path: string): Promise<string>;
  /** server path -> vault path; throws if the name is not valid ciphertext for this key */
  decName(serverPath: string): Promise<string>;
  encData(data: Uint8Array): Promise<Uint8Array>;
  decData(data: Uint8Array): Promise<Uint8Array>;
  /** size of the plaintext for a given stored size; throws when the stored size is impossible */
  plainSize(storedSize: number): number;
}

export const plainFileCipher: FileCipher = {
  encrypted: false,
  encName: async (p) => p,
  decName: async (p) => p,
  encData: async (d) => d,
  decData: async (d) => d,
  plainSize: (n) => n,
};

export async function makeRcloneCipher(password: string, salt: string): Promise<FileCipher> {
  const c = new Cipher("base32");
  await c.key(password, salt); // empty salt = rclone's built-in default salt
  return {
    encrypted: true,
    encName: (p) => c.encryptFileName(p),
    decName: (p) => c.decryptFileName(p),
    encData: (d) => c.encryptData(d, undefined),
    decData: (d) => c.decryptData(d),
    plainSize: (n) => decryptedSize(n),
  };
}

/** Typical servers cap one path segment at 255 bytes; base32 + padding makes names ~1.7x longer. */
export const MAX_SEGMENT = 255;
