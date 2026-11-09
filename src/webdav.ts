import { b64encode, te } from "./util";

export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}
export interface HttpResponse {
  status: number;
  /** lower-cased header names */
  headers: Record<string, string>;
  body: ArrayBuffer;
}
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export class PreconditionFailed extends HttpError {
  constructor(message: string) {
    super(412, message);
  }
}

export interface DavEntry {
  name: string;
  isDir: boolean;
  etag?: string;
  modified?: number;
  size?: number;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:getetag/><d:resourcetype/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>";

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i").exec(block);
  const v = m?.[1].trim();
  return v ? decodeXml(v) : undefined;
}

export function parseMultistatus(xml: string): Array<DavEntry & { pathname: string }> {
  const out: Array<DavEntry & { pathname: string }> = [];
  const re = /<(?:[\w-]+:)?response[\s>][\s\S]*?<\/(?:[\w-]+:)?response>/gi;
  for (const m of xml.matchAll(re)) {
    const block = m[0];
    const href = tag(block, "href");
    if (!href) continue;
    let pathname = href;
    try {
      pathname = new URL(href, "http://x/").pathname;
      pathname = decodeURIComponent(pathname);
    } catch {
      /* keep raw */
    }
    pathname = pathname.replace(/\/+$/, "");
    const isDir = /<(?:[\w-]+:)?resourcetype(?:\s[^>]*)?>[\s\S]*?<(?:[\w-]+:)?collection/i.test(block);
    const lm = tag(block, "getlastmodified");
    const len = tag(block, "getcontentlength");
    out.push({
      name: pathname.split("/").pop() ?? "",
      pathname,
      isDir,
      etag: tag(block, "getetag"),
      modified: lm ? Date.parse(lm) || undefined : undefined,
      size: len ? Number(len) : undefined,
    });
  }
  return out;
}

export class WebDAV {
  private base: string;
  private rootSegs: string[];
  private auth: string;
  private dirs = new Set<string>();

  constructor(base: string, user: string, pass: string, private http: HttpFn, root = "") {
    this.base = base.trim().replace(/\/+$/, "");
    this.rootSegs = root.split("/").filter(Boolean);
    this.auth = user || pass ? "Basic " + b64encode(te.encode(`${user}:${pass}`)) : "";
  }

  private segs(path: string): string[] {
    return [...this.rootSegs, ...path.split("/").filter(Boolean)];
  }
  private url(path: string, dir = false): string {
    const s = this.segs(path);
    return this.base + "/" + s.map(encodeURIComponent).join("/") + (dir && s.length ? "/" : "");
  }

  private req(
    method: string,
    path: string,
    o: { headers?: Record<string, string>; body?: Uint8Array | string; dir?: boolean } = {}
  ) {
    return this.http({
      url: this.url(path, o.dir),
      method,
      headers: { ...(this.auth ? { Authorization: this.auth } : {}), ...o.headers },
      body: o.body,
    });
  }

  private fail(r: HttpResponse, what: string): never {
    if (r.status === 401 || r.status === 403) throw new HttpError(r.status, `${what}: authentication failed (HTTP ${r.status})`);
    throw new HttpError(r.status, `${what}: HTTP ${r.status}`);
  }

  /** Lists children of a collection. Returns null if it does not exist. */
  async list(path: string): Promise<DavEntry[] | null> {
    const r = await this.req("PROPFIND", path, {
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
      dir: true,
    });
    if (r.status === 404) return null;
    if (r.status !== 207 && r.status !== 200) this.fail(r, `PROPFIND ${path}`);
    const self = decodeURIComponent(new URL(this.url(path)).pathname).replace(/\/+$/, "");
    return parseMultistatus(new TextDecoder().decode(r.body))
      .filter((e) => e.pathname !== self)
      .map(({ pathname: _p, ...e }) => e);
  }

  /**
   * ETag as the server compares it for If-Match. Read it via PROPFIND: a GET may carry a
   * transformed validator (Apache mod_deflate appends "-gzip"), which If-Match then rejects.
   */
  async etag(path: string): Promise<string | undefined | null> {
    const r = await this.req("PROPFIND", path, {
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (r.status === 404) return null;
    if (r.status !== 207 && r.status !== 200) this.fail(r, `PROPFIND ${path}`);
    return parseMultistatus(new TextDecoder().decode(r.body))[0]?.etag;
  }

  /** Checks connectivity + credentials against the server root. */
  async test(): Promise<void> {
    const r = await this.http({
      url: this.base + "/",
      method: "PROPFIND",
      headers: { ...(this.auth ? { Authorization: this.auth } : {}), Depth: "0", "Content-Type": "application/xml" },
      body: PROPFIND_BODY,
    });
    if (r.status !== 207 && r.status !== 200) this.fail(r, "Connection test");
  }

  async get(path: string): Promise<{ data: Uint8Array; etag?: string } | null> {
    const r = await this.req("GET", path);
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) this.fail(r, `GET ${path}`);
    return { data: new Uint8Array(r.body), etag: r.headers["etag"] };
  }

  async put(path: string, data: Uint8Array, o: { ifMatch?: string; ifNoneMatch?: boolean } = {}): Promise<string | undefined> {
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (o.ifMatch) headers["If-Match"] = o.ifMatch;
    if (o.ifNoneMatch) headers["If-None-Match"] = "*";
    let r = await this.req("PUT", path, { headers, body: data });
    if ([403, 404, 405, 409].includes(r.status)) {
      // parent collection probably missing (servers differ: 409 per RFC, but some answer 403/404/405)
      const parent = path.split("/").slice(0, -1).join("/");
      await this.ensureDir(parent);
      r = await this.req("PUT", path, { headers, body: data });
    }
    if (r.status === 412) throw new PreconditionFailed(`PUT ${path}: precondition failed`);
    if (r.status < 200 || r.status >= 300) this.fail(r, `PUT ${path}`);
    return r.headers["etag"];
  }

  /** Stat one file/collection via PROPFIND (the ETag here is the one If-Match compares against). */
  async stat(path: string): Promise<DavEntry | null> {
    const r = await this.req("PROPFIND", path, {
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (r.status === 404) return null;
    if (r.status !== 207 && r.status !== 200) this.fail(r, `PROPFIND ${path}`);
    const e = parseMultistatus(new TextDecoder().decode(r.body))[0];
    if (!e) return null;
    const { pathname: _p, ...rest } = e;
    return rest;
  }

  async delete(path: string, o: { ifMatch?: string } = {}): Promise<void> {
    const r = await this.req("DELETE", path, { headers: o.ifMatch ? { "If-Match": o.ifMatch } : undefined });
    if (r.status === 412) throw new PreconditionFailed(`DELETE ${path}: precondition failed`);
    if (r.status !== 404 && (r.status < 200 || r.status >= 300)) this.fail(r, `DELETE ${path}`);
  }

  private dirJobs = new Map<string, Promise<void>>();

  /** mkdir -p (relative to the configured root, which is created as well). Safe to call concurrently. */
  async ensureDir(path: string): Promise<void> {
    const all = this.segs(path);
    for (let i = 1; i <= all.length; i++) {
      const key = all.slice(0, i).join("/");
      if (this.dirs.has(key)) continue;
      // one MKCOL per directory at a time: concurrent uploads into a new folder share the same job
      let job = this.dirJobs.get(key);
      if (!job) {
        job = this.makeDir(all.slice(0, i)).finally(() => this.dirJobs.delete(key));
        this.dirJobs.set(key, job);
      }
      await job;
      this.dirs.add(key);
    }
  }

  private async makeDir(segs: string[]): Promise<void> {
    const url = this.base + "/" + segs.map(encodeURIComponent).join("/") + "/";
    const headers: Record<string, string> = this.auth ? { Authorization: this.auth } : {};
    const r = await this.http({ url, method: "MKCOL", headers });
    // 201 created; 405 already exists; 301 some servers redirect to the slash form
    if ([201, 405, 301, 200].includes(r.status)) return;
    // Servers disagree on what "already exists" looks like, and some answer 403 to a MKCOL that raced
    // with another MKCOL of the same folder (seen on a real Apache-based service). Believe PROPFIND,
    // and give a concurrent creator a moment to finish.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((res) => setTimeout(res, 200 * attempt));
      const p = await this.http({
        url,
        method: "PROPFIND",
        headers: { ...headers, Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
        body: PROPFIND_BODY,
      });
      if ((p.status === 207 || p.status === 200) && /collection/i.test(new TextDecoder().decode(p.body))) return;
    }
    this.fail(r, `MKCOL ${segs.join("/")}`);
  }
}
