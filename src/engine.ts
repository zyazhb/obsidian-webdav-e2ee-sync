import { chunkRanges, ChunkOptions, DEFAULT_CHUNK } from "./chunker";
import { Cipher, newMeta, plainCipher, RemoteMeta, unlock } from "./crypto";
import { compileIgnore, concat, gunzip, gzip, hasGzip, pool, sha256Hex, td, te } from "./util";
import { PreconditionFailed, WebDAV } from "./webdav";

/*
 * Remote layout (all under the configured folder):
 *   meta.json            plaintext: E2EE flag, KDF salt, password-check blob
 *   index.bin            gzip(JSON) -> AES-GCM : path -> {hash,size,mtime,chunks[],tombstone}
 *   chunks/ab/<id>       AES-GCM(chunk), id = HMAC-SHA256(key, chunk)   (content-addressed)
 *
 * File names, directory structure and sizes live only inside the encrypted index.
 * Delta sync = FastCDC chunks; only chunks whose id is not already referenced by
 * the index are uploaded, and on download only chunks missing locally are fetched.
 *
 * Change detection is 3-way: local state vs. remote index vs. the "base" (what both
 * sides agreed on at the last successful sync).
 */

export interface FileInfo {
  path: string;
  size: number;
  mtime: number;
}
export interface VaultIO {
  /** List all files; `skip` is consulted for every directory and file so excluded trees are not walked. */
  list(skip: (path: string, isDir: boolean) => boolean): Promise<FileInfo[]>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, mtime: number): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface BaseEntry {
  h: string;
  s: number;
  m: number;
}
export interface LocalState {
  remoteId: string;
  files: Record<string, BaseEntry>;
}
export interface RemoteEntry {
  h: string; // sha256 of whole file
  s: number;
  m: number; // mtime of the writer
  c: string[]; // chunk ids
  d?: boolean; // tombstone
  r: number; // time of this change
}
export interface RemoteIndex {
  v: 1;
  rev: number;
  files: Record<string, RemoteEntry>;
}

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  chunksUp: number;
  chunksDown: number;
  bytesUp: number;
  bytesDown: number;
  /** files whose transfer failed (they are retried on the next sync) */
  errors: Array<{ path: string; message: string }>;
}

export type FileAction = "upload" | "download" | "delete-local" | "delete-remote" | "conflict";
export type FileStatus = "pending" | "active" | "done" | "error";
export interface FileEvent {
  path: string;
  action: FileAction;
  status: FileStatus;
  detail?: string;
}

export interface EngineOptions {
  io: VaultIO;
  dav: WebDAV;
  state: LocalState;
  saveState: () => Promise<void>;
  /** null => no end-to-end encryption */
  password: string | null;
  ignore?: string[];
  includeConfig?: boolean;
  configDir: string;
  pluginDir: string;
  deviceName: string;
  chunk?: ChunkOptions;
  concurrency?: number;
  log?: (msg: string) => void;
  /** per-file progress */
  onEvent?: (e: FileEvent) => void;
  /** human-readable phase of the current sync ("Scanning local files…") */
  onPhase?: (text: string) => void;
}

const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000;
const chunkPath = (id: string) => `chunks/${id.slice(0, 2)}/${id}`;
const emptyStats = (): SyncStats => ({
  uploaded: 0,
  downloaded: 0,
  deletedLocal: 0,
  deletedRemote: 0,
  conflicts: 0,
  chunksUp: 0,
  chunksDown: 0,
  bytesUp: 0,
  bytesDown: 0,
  errors: [],
});

type PassResult = "done" | "again" | "retry";

export class SyncEngine {
  private cipher: Cipher = plainCipher;
  private unlocked = false;
  private ignoreRes: RegExp[];
  private chunkOpts: ChunkOptions;
  private conc: number;
  private stats = emptyStats();
  private errors = new Map<string, string>();

  private emit(path: string, action: FileAction, status: FileStatus, detail?: string) {
    this.o.onEvent?.({ path, action, status, detail });
  }
  private phase(text: string) {
    this.o.onPhase?.(text);
  }

  /** Runs one file operation; a failure is recorded for that file and does not abort the sync. */
  private async run(path: string, action: FileAction, fn: () => Promise<string | void>): Promise<void> {
    this.emit(path, action, "active");
    try {
      const detail = await fn();
      this.errors.delete(path);
      this.emit(path, action, "done", detail || undefined);
    } catch (e) {
      const message = (e as Error).message || String(e);
      this.errors.set(path, message);
      this.emit(path, action, "error", message);
      this.log(`${action} ${path} failed: ${message}`);
    }
  }

  constructor(private o: EngineOptions) {
    this.ignoreRes = compileIgnore(o.ignore ?? []);
    this.chunkOpts = o.chunk ?? DEFAULT_CHUNK;
    this.conc = o.concurrency ?? 4;
  }

  private log(m: string) {
    this.o.log?.(m);
  }

  // ───────────────────────── remote bootstrap ─────────────────────────

  private async unlockRemote(depth = 0): Promise<void> {
    if (this.unlocked) return;
    const got = await this.o.dav.get("meta.json");
    if (!got) {
      await this.o.dav.ensureDir("");
      const created = await newMeta(this.o.password);
      try {
        await this.o.dav.put("meta.json", te.encode(JSON.stringify(created.meta)), { ifNoneMatch: true });
      } catch (e) {
        // another device initialised the folder first -> adopt its meta
        if (e instanceof PreconditionFailed && depth < 2) return this.unlockRemote(depth + 1);
        throw e;
      }
      this.cipher = created.cipher;
      this.unlocked = true;
      return;
    }
    const meta = JSON.parse(td.decode(got.data)) as RemoteMeta;
    if (meta.encrypted && this.o.password === null)
      throw new Error("The remote folder is end-to-end encrypted: enable E2EE and enter the password.");
    if (!meta.encrypted && this.o.password !== null)
      throw new Error("The remote folder is NOT encrypted but E2EE is enabled locally. Use a new/empty remote folder or disable E2EE.");
    this.cipher = meta.encrypted ? await unlock(meta, this.o.password as string) : plainCipher;
    this.unlocked = true;
  }

  private ifMatchBroken = false;

  private async loadIndex(): Promise<{ index: RemoteIndex; etag?: string; blob: Uint8Array } | null> {
    // ETag first, data second: if the index changes in between we hold an older ETag than the
    // data, so our conditional PUT fails safely (and we retry) instead of overwriting.
    const etag = await this.o.dav.etag("index.bin");
    if (etag === null) return null;
    const got = await this.o.dav.get("index.bin");
    if (!got) return null;
    const raw = await this.cipher.decrypt(got.data, "index");
    const json = raw[0] === 1 ? await gunzip(raw.subarray(1)) : raw.subarray(1);
    return { index: JSON.parse(td.decode(json)) as RemoteIndex, etag: etag ?? got.etag, blob: got.data };
  }

  private async saveIndex(index: RemoteIndex, loaded: { etag?: string; blob: Uint8Array } | null): Promise<void> {
    const json = te.encode(JSON.stringify(index));
    const body = hasGzip ? concat([Uint8Array.of(1), await gzip(json)]) : concat([Uint8Array.of(0), json]);
    const blob = await this.cipher.encrypt(body, "index");
    // Optimistic concurrency: never overwrite an index that changed since we read it.
    const etag = loaded?.etag;
    if (!loaded) return void (await this.o.dav.put("index.bin", blob, { ifNoneMatch: true }));
    if (!etag || etag.startsWith("W/") || this.ifMatchBroken) return void (await this.o.dav.put("index.bin", blob));
    try {
      await this.o.dav.put("index.bin", blob, { ifMatch: etag });
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e;
      // Distinguish a real concurrent change from a server whose ETags don't round-trip:
      // if the stored index is byte-identical to what we read, nobody else wrote.
      const cur = await this.o.dav.get("index.bin");
      if (cur && cur.data.length === loaded.blob.length && cur.data.every((v, i) => v === loaded.blob[i])) {
        this.log("server rejected If-Match although the index is unchanged; disabling If-Match");
        this.ifMatchBroken = true;
        await this.o.dav.put("index.bin", blob);
      } else throw e;
    }
  }

  // ───────────────────────── exclusion rules ─────────────────────────

  isExcluded(path: string): boolean {
    const { pluginDir, configDir } = this.o;
    if (path === pluginDir || path.startsWith(pluginDir + "/")) return true; // holds credentials!
    const segs = path.split("/");
    if (segs.includes(".git") || segs.includes(".trash") || segs[segs.length - 1] === ".DS_Store") return true;
    if (segs[0] === configDir) {
      if (!this.o.includeConfig) return true;
      const rest = segs.slice(1).join("/");
      if (rest === "workspace.json" || rest === "workspace-mobile.json" || rest === "cache" || rest.startsWith("cache/"))
        return true;
    }
    return this.ignoreRes.some((re) => re.test(path));
  }

  // ───────────────────────── chunk transfer ─────────────────────────

  private uploading = new Map<string, Promise<void>>();
  private known = new Set<string>(); // chunk ids known to exist remotely

  private uploadChunk(id: string, part: Uint8Array): Promise<void> {
    if (this.known.has(id)) return Promise.resolve();
    let p = this.uploading.get(id);
    if (!p) {
      p = (async () => {
        const blob = await this.cipher.encrypt(part, id);
        await this.o.dav.put(chunkPath(id), blob);
        this.stats.chunksUp++;
        this.stats.bytesUp += blob.length;
        this.known.add(id);
      })().finally(() => this.uploading.delete(id));
      this.uploading.set(id, p);
    }
    return p;
  }

  private async fetchChunk(id: string): Promise<Uint8Array> {
    const got = await this.o.dav.get(chunkPath(id));
    if (!got) throw new Error(`Remote chunk ${id.slice(0, 8)}… is missing`);
    const data = await this.cipher.decrypt(got.data, id);
    if ((await this.cipher.chunkId(data)) !== id) throw new Error("Chunk integrity check failed");
    this.stats.chunksDown++;
    this.stats.bytesDown += got.data.length;
    return data;
  }

  /** Rebuild a remote file, fetching only chunks that are not in `reuse`. */
  private async assemble(re: RemoteEntry, reuse?: Map<string, Uint8Array>): Promise<Uint8Array> {
    const parts: Array<Uint8Array | undefined> = re.c.map((id) => reuse?.get(id));
    const missing: number[] = [];
    parts.forEach((p, i) => {
      if (!p) missing.push(i);
    });
    await pool(missing, this.conc, async (i) => {
      parts[i] = await this.fetchChunk(re.c[i]);
    });
    const data = concat(parts as Uint8Array[]);
    if (data.length !== re.s || (await sha256Hex(data)) !== re.h) throw new Error("File integrity check failed");
    return data;
  }

  private async localChunks(path: string): Promise<Map<string, Uint8Array>> {
    const data = await this.o.io.read(path);
    const map = new Map<string, Uint8Array>();
    for (const [s, e] of chunkRanges(data, this.chunkOpts)) {
      const part = data.subarray(s, e);
      map.set(await this.cipher.chunkId(part), part);
    }
    return map;
  }

  // ───────────────────────── sync ─────────────────────────

  async sync(): Promise<SyncStats> {
    this.stats = emptyStats();
    this.errors.clear();
    this.phase("Connecting…");
    await this.unlockRemote();
    let result: PassResult = "retry";
    let again = 0;
    for (let i = 0; i < 6 && result !== "done"; i++) {
      result = await this.pass();
      if (result === "again" && ++again >= 2) result = "done";
    }
    if (result === "retry") throw new Error("The remote index kept changing during sync; try again.");
    this.stats.errors = [...this.errors].map(([path, message]) => ({ path, message }));
    this.phase(this.stats.errors.length ? `Finished with ${this.stats.errors.length} error(s)` : "Up to date");
    return this.stats;
  }

  private async pass(): Promise<PassResult> {
    const { io, state } = this.o;
    this.phase("Reading remote index…");
    const loaded = await this.loadIndex();
    // Remote index vanished (new/empty folder): don't mass-delete local files, re-upload instead.
    if (!loaded && Object.keys(state.files).length) {
      this.log("remote index missing: resetting local base");
      state.files = {};
    }
    const index: RemoteIndex = loaded?.index ?? { v: 1, rev: 0, files: {} };
    for (const e of Object.values(index.files)) if (!e.d) for (const id of e.c) this.known.add(id);

    // 1. scan local files, hashing only those whose size/mtime changed since the base
    this.phase("Scanning local files…");
    const files = await io.list((p) => this.isExcluded(p));
    const local = new Map(files.map((f) => [f.path, f]));
    const lh = new Map<string, string>();
    const toHash: FileInfo[] = [];
    for (const f of files) {
      const b = state.files[f.path];
      if (b && b.s === f.size && b.m === f.mtime) lh.set(f.path, b.h);
      else toHash.push(f);
    }
    this.phase(`Checking ${toHash.length} changed file(s) of ${files.length}…`);
    await pool(toHash, this.conc, async (f) => {
      lh.set(f.path, await sha256Hex(await io.read(f.path)));
    });

    // 2. plan (3-way compare)
    const pull: Array<{ p: string; reuse: boolean }> = [];
    const push: string[] = [];
    const delLocal: string[] = [];
    const delRemote: string[] = [];
    const conflicts: string[] = [];
    const paths = new Set([...local.keys(), ...Object.keys(index.files), ...Object.keys(state.files)]);
    for (const p of paths) {
      if (this.isExcluded(p)) continue;
      const L = lh.get(p) ?? null;
      const re = index.files[p];
      const R = re && !re.d ? re.h : null;
      if (L === R) {
        if (L === null) delete state.files[p];
        else {
          const f = local.get(p)!;
          state.files[p] = { h: L, s: f.size, m: f.mtime };
        }
        continue;
      }
      const hasBase = p in state.files;
      if (!hasBase) {
        if (L && !R) push.push(p);
        else if (!L && R) pull.push({ p, reuse: false });
        else conflicts.push(p);
        continue;
      }
      const B = state.files[p].h;
      const lc = L !== B;
      const rc = R !== B;
      if (lc && !rc) (L ? push : delRemote).push(p);
      else if (!lc && rc) {
        if (R) pull.push({ p, reuse: local.has(p) });
        else delLocal.push(p);
      } else if (L && R) conflicts.push(p);
      else if (R) pull.push({ p, reuse: false }); // deleted locally, modified remotely -> restore
      else push.push(p); // deleted remotely, modified locally -> keep local
    }
    this.log(
      `plan: push ${push.length}, pull ${pull.length}, delLocal ${delLocal.length}, delRemote ${delRemote.length}, conflicts ${conflicts.length}`
    );

    for (const { p } of pull) this.emit(p, "download", "pending");
    for (const p of push) this.emit(p, "upload", "pending");
    for (const p of delLocal) this.emit(p, "delete-local", "pending");
    for (const p of delRemote) this.emit(p, "delete-remote", "pending");
    for (const p of conflicts) this.emit(p, "conflict", "pending");
    this.phase(push.length + pull.length + delLocal.length + delRemote.length + conflicts.length ? "Transferring…" : "Nothing to transfer");

    // 3. local-side actions
    await pool(delLocal, this.conc, (p) =>
      this.run(p, "delete-local", async () => {
        await io.remove(p);
        delete state.files[p];
        this.stats.deletedLocal++;
      })
    );

    const doPull = async (p: string, reuse: boolean) => {
      const re = index.files[p];
      const have = reuse ? await this.localChunks(p) : undefined;
      const data = await this.assemble(re, have);
      await io.write(p, data, re.m);
      state.files[p] = { h: re.h, s: data.length, m: re.m };
      this.stats.downloaded++;
    };
    await pool(pull, this.conc, ({ p, reuse }) => this.run(p, "download", () => doPull(p, reuse)));

    // conflicts: the newer mtime wins the path, the loser is preserved as a sibling copy
    for (const p of conflicts) {
      await this.run(p, "conflict", async () => {
        const f = local.get(p)!;
        const re = index.files[p];
        const copy = await this.conflictName(p);
        if (re.m > f.mtime) {
          await io.write(copy, await io.read(p), f.mtime);
          await doPull(p, false);
        } else {
          await io.write(copy, await this.assemble(re), re.m);
          push.push(p);
        }
        this.stats.conflicts++;
        this.log(`conflict on ${p} -> ${copy}`);
        return `kept both versions, other copy: ${copy}`;
      });
    }

    // 4. push (upload new chunks first, commit index last)
    const next: RemoteIndex = { v: 1, rev: index.rev + 1, files: { ...index.files } };
    const baseUpdates = new Map<string, BaseEntry>();
    const now = Date.now();
    await pool(push, this.conc, async (p) => {
     await this.run(p, "upload", async () => {
      const f = local.get(p)!;
      const data = await io.read(p);
      const ids: string[] = [];
      for (const [s, e] of chunkRanges(data, this.chunkOpts)) {
        const part = data.subarray(s, e);
        const id = await this.cipher.chunkId(part);
        ids.push(id);
        await this.uploadChunk(id, part);
      }
      const h = await sha256Hex(data);
      next.files[p] = { h, s: data.length, m: f.mtime, c: ids, r: now };
      baseUpdates.set(p, { h, s: data.length, m: f.mtime });
      this.stats.uploaded++;
     });
    });
    for (const p of delRemote) {
      next.files[p] = { h: "", s: 0, m: 0, c: [], d: true, r: now };
      this.stats.deletedRemote++;
      this.emit(p, "delete-remote", "active");
    }
    for (const [p, e] of Object.entries(next.files)) if (e.d && now - e.r > TOMBSTONE_TTL) delete next.files[p];

    if (baseUpdates.size || delRemote.length) {
      this.phase("Updating remote index…");
      try {
        await this.saveIndex(next, loaded);
      } catch (e) {
        if (e instanceof PreconditionFailed) {
          await this.o.saveState();
          return "retry";
        }
        throw e;
      }
      for (const [p, b] of baseUpdates) state.files[p] = b;
      for (const p of delRemote) {
        delete state.files[p];
        this.emit(p, "delete-remote", "done");
      }
    }
    await this.o.saveState();
    return conflicts.length ? "again" : "done";
  }

  private async conflictName(p: string): Promise<string> {
    const dot = p.lastIndexOf(".");
    const hasExt = dot > p.lastIndexOf("/") + 1;
    const stem = hasExt ? p.slice(0, dot) : p;
    const ext = hasExt ? p.slice(dot) : "";
    const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const dev = this.o.deviceName.replace(/[\\/:*?"<>|]/g, "_") || "device";
    for (let n = 0; ; n++) {
      const c = `${stem} (conflict ${dev} ${ts}${n ? " " + n : ""})${ext}`;
      if (!(await this.o.io.exists(c))) return c;
    }
  }

  // ───────────────────────── maintenance ─────────────────────────

  /**
   * Deletes remote chunks that no file in the index references.
   * Only chunks older than `minAgeMs` are removed, so uploads in flight from other
   * devices are not hit. Run it while other devices are idle.
   */
  async gc(minAgeMs = 24 * 3600 * 1000): Promise<{ deleted: number; kept: number }> {
    await this.unlockRemote();
    const loaded = await this.loadIndex();
    if (!loaded) return { deleted: 0, kept: 0 };
    const used = new Set<string>();
    for (const e of Object.values(loaded.index.files)) if (!e.d) for (const id of e.c) used.add(id);
    let deleted = 0;
    let kept = 0;
    const now = Date.now();
    const dirs = (await this.o.dav.list("chunks")) ?? [];
    for (const d of dirs) {
      if (!d.isDir) continue;
      for (const f of (await this.o.dav.list(`chunks/${d.name}`)) ?? []) {
        if (f.isDir) continue;
        if (!used.has(f.name) && f.modified !== undefined && now - f.modified > minAgeMs) {
          await this.o.dav.delete(`chunks/${d.name}/${f.name}`);
          this.known.delete(f.name);
          deleted++;
        } else kept++;
      }
    }
    return { deleted, kept };
  }
}
