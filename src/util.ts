export const te = new TextEncoder();
export const td = new TextDecoder();

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function b64encode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/** Run fn over items with bounded concurrency; rejects with the first error. */
export async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  let failed = false;
  let error: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (e) {
        if (!failed) {
          failed = true;
          error = e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw error;
}

export const hasGzip = typeof CompressionStream !== "undefined";

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(t as unknown as ReadableWritablePair);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export const gzip = (d: Uint8Array) => pipe(d, new CompressionStream("gzip"));
export const gunzip = (d: Uint8Array) => pipe(d, new DecompressionStream("gzip"));

/** Convert a glob list into regexps. `*` = within a segment, `**` = across segments. */
export function compileIgnore(lines: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (let raw of lines) {
    raw = raw.trim();
    if (!raw || raw.startsWith("#")) continue;
    const anchored = raw.includes("/");
    raw = raw.replace(/^\/+/, "").replace(/\/+$/, "");
    let re = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === "*") {
        if (raw[i + 1] === "*") {
          re += ".*";
          i++;
        } else re += "[^/]*";
      } else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    out.push(new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}(?:/.*)?$`));
  }
  return out;
}
