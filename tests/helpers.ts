import type { FileInfo, VaultIO } from "../src/engine";
import type { HttpFn, HttpRequest, HttpResponse } from "../src/webdav";

const te = new TextEncoder();
const buf = (s: string) => te.encode(s).buffer as ArrayBuffer;

/** Minimal in-memory WebDAV server: PROPFIND/GET/PUT/MKCOL/DELETE with ETag + If-Match/If-None-Match. */
export class FakeDavServer {
  files = new Map<string, { data: Uint8Array; etag: string; modified: number }>();
  dirs = new Set<string>([""]);
  log: string[] = [];
  private counter = 0;
  base = "http://dav.test/root";
  /** emulate Apache mod_deflate: GET ETags get a "-gzip" suffix that If-Match won't accept */
  gzipEtagOnGet = false;
  /** emulate a server whose If-Match never matches */
  ifMatchAlwaysFails = false;

  http: HttpFn = async (r: HttpRequest): Promise<HttpResponse> => {
    const u = new URL(r.url);
    const path = decodeURIComponent(u.pathname).replace(/^\/root\/?/, "").replace(/\/+$/, "");
    this.log.push(`${r.method} ${path}`);
    const res = (status: number, body = "", headers: Record<string, string> = {}): HttpResponse => ({
      status,
      headers,
      body: buf(body),
    });
    const parent = path.split("/").slice(0, -1).join("/");
    switch (r.method) {
      case "PROPFIND": {
        const isDir = this.dirs.has(path);
        if (!isDir && !this.files.has(path)) return res(404);
        const entry = (p: string, dir: boolean) => {
          const f = this.files.get(p);
          return (
            `<d:response><d:href>/root/${p.split("/").map(encodeURIComponent).join("/")}${dir ? "/" : ""}</d:href><d:propstat><d:prop>` +
            (dir ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getetag>&quot;${f!.etag}&quot;</d:getetag><d:getcontentlength>${f!.data.length}</d:getcontentlength><d:getlastmodified>${new Date(f!.modified).toUTCString()}</d:getlastmodified>`) +
            `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
          );
        };
        let xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entry(path, isDir)}`;
        if (isDir && r.headers?.Depth === "1") {
          const pre = path ? path + "/" : "";
          for (const d of this.dirs) if (d && d.startsWith(pre) && !d.slice(pre.length).includes("/") && d !== path) xml += entry(d, true);
          for (const f of this.files.keys()) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) xml += entry(f, false);
        }
        return res(207, xml + "</d:multistatus>");
      }
      case "MKCOL":
        if (this.dirs.has(path) || this.files.has(path)) return res(405);
        if (!this.dirs.has(parent)) return res(409);
        this.dirs.add(path);
        return res(201);
      case "GET": {
        const f = this.files.get(path);
        return f ? { status: 200, headers: { etag: `"${f.etag}${this.gzipEtagOnGet ? "-gzip" : ""}"` }, body: f.data.slice().buffer as ArrayBuffer } : res(404);
      }
      case "PUT": {
        if (!this.dirs.has(parent)) return res(409);
        const cur = this.files.get(path);
        if (r.headers?.["If-None-Match"] === "*" && cur) return res(412);
        if (r.headers?.["If-Match"] && (this.ifMatchAlwaysFails || !cur || `"${cur.etag}"` !== r.headers["If-Match"])) return res(412);
        const etag = `e${++this.counter}`;
        this.files.set(path, { data: new Uint8Array(r.body as Uint8Array), etag, modified: Date.now() });
        return res(cur ? 204 : 201, "", { etag: `"${etag}"` });
      }
      case "DELETE":
        return this.files.delete(path) ? res(204) : res(404);
    }
    return res(405);
  };

  count(method: string, prefix = ""): number {
    return this.log.filter((l) => l.startsWith(`${method} ${prefix}`)).length;
  }
  resetLog() {
    this.log = [];
  }
  /** Everything the server can see: paths and bytes. */
  dump(): { paths: string[]; blobs: Uint8Array[] } {
    return { paths: [...this.files.keys(), ...this.dirs], blobs: [...this.files.values()].map((f) => f.data) };
  }
}

export class MemoryVault implements VaultIO {
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  private clock = 1_700_000_000_000;

  put(path: string, content: string | Uint8Array, mtime?: number) {
    this.files.set(path, {
      data: typeof content === "string" ? te.encode(content) : content,
      mtime: mtime ?? (this.clock += 1000),
    });
  }
  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f && new TextDecoder().decode(f.data);
  }
  async list(skip: (p: string, d: boolean) => boolean): Promise<FileInfo[]> {
    const out: FileInfo[] = [];
    outer: for (const [path, f] of this.files) {
      const segs = path.split("/");
      for (let i = 1; i < segs.length; i++) if (skip(segs.slice(0, i).join("/"), true)) continue outer;
      if (!skip(path, false)) out.push({ path, size: f.data.length, mtime: f.mtime });
    }
    return out;
  }
  async read(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error("ENOENT " + path);
    return f.data;
  }
  async write(path: string, data: Uint8Array, mtime: number) {
    this.files.set(path, { data, mtime });
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
}

export function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed | 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}
