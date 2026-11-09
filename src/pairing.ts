import { b64decode, b64encode, td, te } from "./util";

/**
 * Pairing code = what the QR code carries: the E2EE key (password) and, optionally, the
 * WebDAV connection. Format:  OBSYNC1:<base64url(JSON)>
 *
 * It contains secrets in the clear, so the QR code must only be shown to your own device.
 */
export const PAIR_PREFIX = "OBSYNC1:";

export interface Pairing {
  /** end-to-end encryption password */
  key: string;
  /** rclone crypt "password2" (salt); omitted/empty = rclone's default salt */
  salt?: string;
  server?: { url: string; user: string; pass: string; dir: string };
}

const MAX = 512;

const toUrl = (b: Uint8Array) => b64encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrl = (s: string) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64decode(t + "=".repeat((4 - (t.length % 4)) % 4));
};

export function encodePairing(p: Pairing): string {
  const o: Record<string, unknown> = { v: 1, k: p.key };
  if (p.salt) o.s = p.salt;
  if (p.server) Object.assign(o, { u: p.server.url, n: p.server.user, p: p.server.pass, d: p.server.dir });
  return PAIR_PREFIX + toUrl(te.encode(JSON.stringify(o)));
}

/** Parses and validates scanned/pasted text. Throws an Error with a user-readable message. */
export function decodePairing(text: string): Pairing {
  const t = text.trim();
  if (t.slice(0, PAIR_PREFIX.length).toUpperCase() !== PAIR_PREFIX) throw new Error("This is not a WebDAV E2EE Sync pairing code.");
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(td.decode(fromUrl(t.slice(PAIR_PREFIX.length))));
  } catch {
    throw new Error("The pairing code is damaged (scan again or copy the full code).");
  }
  const str = (v: unknown, name: string, allowEmpty = false): string => {
    if (typeof v !== "string" || v.length > MAX || (!allowEmpty && !v)) throw new Error(`Invalid pairing code: bad "${name}".`);
    return v;
  };
  if (!o || typeof o !== "object" || o.v !== 1) throw new Error("Unsupported pairing code version. Update the plugin on both devices.");
  const out: Pairing = { key: str(o.k, "key") };
  if ("s" in o) out.salt = str(o.s, "salt", true);
  if ("u" in o) {
    const url = str(o.u, "url");
    if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error("Invalid pairing code: the server URL must start with http:// or https://");
    out.server = { url, user: str(o.n, "user", true), pass: str(o.p, "password", true), dir: str(o.d, "folder", true) };
  }
  return out;
}
