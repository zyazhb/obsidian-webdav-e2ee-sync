import { FileCipher, MAX_SEGMENT, makeRcloneCipher, plainFileCipher } from "./cipher";
import { compileIgnore, pool, sha256Hex, te } from "./util";
import { DavEntry, PreconditionFailed, WebDAV } from "./webdav";

/*
 * One vault file = one file on the server, stored in rclone-crypt format (see cipher.ts).
 * There is no index and no custom protocol: the server's own listing (name, size, ETag) is
 * the source of truth for "what changed remotely".
 *
 * Change detection is a 3-way compare per path:
 *   local  : sha256 of the file now            (re-hashed only when size/mtime changed)
 *   remote : the server's signature (ETag, else size|mtime) now
 *   base   : what both sides agreed on at the last successful sync (kept per device)
 *
 * A path is "changed locally" if its hash differs from base, "changed remotely" if its signature
 * differs from base. Deletions are detected the same way (missing now, present in base).
 * When both sides changed, or a never-synced path exists on both sides, content is compared
 * (downloaded and hashed if the sizes match) so identical files are simply adopted.
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
  h: string; // sha256 of the plaintext at last sync
  s: number; // local size at last sync
  m: number; // local mtime at last sync
  r: string; // remote signature at last sync
}
export interface LocalState {
  remoteId: string;
  files: Record<string, BaseEntry>;
}

export interface SyncStats {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
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

export interface PlanItem {
  path: string;
  action: FileAction;
  size?: number;
  detail?: string;
}
export interface DryRunResult {
  items: PlanItem[];
  /** files already identical on both sides (nothing to transfer) */
  identical: number;
  totalLocal: number;
  /** the server folder is empty although this device has sync history: everything would be re-uploaded */
  remoteWillBeReset: boolean;
  /** a real sync would refuse to run: it would delete a large share of the files at once */
  massDelete: boolean;
  /** files whose encrypted name would exceed the server's path-segment limit */
  tooLong: string[];
}

export interface EngineOptions {
  io: VaultIO;
  dav: WebDAV;
  state: LocalState;
  saveState: () => Promise<void>;
  /** null => no end-to-end encryption (files stored as they are) */
  password: string | null;
  /** rclone crypt "password2"; empty = rclone's built-in default salt */
  salt?: string;
  ignore?: string[];
  includeConfig?: boolean;
  configDir: string;
  pluginDir: string;
  deviceName: string;
  concurrency?: number;
  /** allow a sync that deletes many files at once (default: refuse, see dry run) */
  allowMassDelete?: boolean;
  log?: (msg: string) => void;
  /** per-file progress */
  onEvent?: (e: FileEvent) => void;
  /** human-readable phase of the current sync ("Scanning local files…") */
  onPhase?: (text: string) => void;
}

interface RemoteFile {
  path: string; // vault path
  enc: string; // server path
  size: number; // plaintext size, -1 if the stored size is not valid ciphertext
  sig: string;
  etag?: string;
  modified?: number;
}

const RCLONE_MAGIC = [0x52, 0x43, 0x4c, 0x4f, 0x4e, 0x45, 0x00, 0x00]; // "RCLONE\0\0"
const MASS_DELETE_MIN = 20;
const MASS_DELETE_SHARE = 0.3;

export const sigOf = (e: Pick<DavEntry, "etag" | "size" | "modified">): string =>
  e.etag ?? `${e.size ?? "?"}|${e.modified ?? "?"}`;
const strongEtag = (etag?: string) => (etag && !etag.startsWith("W/") ? etag : undefined);

const emptyStats = (): SyncStats => ({
  uploaded: 0,
  downloaded: 0,
  deletedLocal: 0,
  deletedRemote: 0,
  conflicts: 0,
  bytesUp: 0,
  bytesDown: 0,
  errors: [],
});

export class SyncEngine {
  private cipher: FileCipher = plainFileCipher;
  private ready = false;
  private ignoreRes: RegExp[];
  private conc: number;
  private stats = emptyStats();
  private errors = new Map<string, string>();
  /** plaintext hash of remote files already downloaded for comparison, keyed by path+signature */
  private hashCache = new Map<string, string>();

  constructor(private o: EngineOptions) {
    this.ignoreRes = compileIgnore(o.ignore ?? []);
    this.conc = o.concurrency ?? 4;
  }

  private log(m: string) {
    this.o.log?.(m);
  }
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

  private async init() {
    if (this.ready) return;
    this.cipher = this.o.password === null ? plainFileCipher : await makeRcloneCipher(this.o.password, this.o.salt ?? "");
    this.ready = true;
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

  // ───────────────────────── remote access ─────────────────────────

  /** Walks the server folder. Entries that do not decrypt with our key (foreign/legacy files) are ignored. */
  private async listRemote(): Promise<Map<string, RemoteFile>> {
    const out = new Map<string, RemoteFile>();
    const root = await this.o.dav.list("");
    if (!root) return out; // folder does not exist yet
    let rootOk = 0;
    const handle = async (dir: string, e: DavEntry, isRoot: boolean, next: string[]) => {
      const enc = dir ? `${dir}/${e.name}` : e.name;
      let plain: string;
      try {
        plain = await this.cipher.decName(enc);
      } catch {
        return;
      }
      if (isRoot) rootOk++;
      if (e.isDir) return void next.push(enc);
      if (this.isExcluded(plain)) return;
      let size = -1;
      try {
        size = this.cipher.plainSize(e.size ?? 0);
      } catch {
        /* keep -1 */
      }
      out.set(plain, { path: plain, enc, size, sig: sigOf(e), etag: strongEtag(e.etag), modified: e.modified });
    };
    let dirs: string[] = [];
    for (const e of root) await handle("", e, true, dirs);
    if (this.cipher.encrypted && root.length > 0 && rootOk === 0)
      throw new Error(
        "Nothing in the remote folder can be decrypted: wrong encryption password/salt, or it is not an rclone-crypt folder " +
          "(an older version of this plugin used a different format — use a new, empty remote folder)."
      );
    while (dirs.length) {
      const next: string[] = [];
      await pool(dirs, this.conc, async (d) => {
        for (const e of (await this.o.dav.list(d)) ?? []) await handle(d, e, false, next);
      });
      dirs = next;
    }
    return out;
  }

  private async download(rf: RemoteFile): Promise<Uint8Array> {
    const got = await this.o.dav.get(rf.enc);
    if (!got) throw new Error("The file disappeared from the server");
    this.stats.bytesDown += got.data.length;
    if (!this.cipher.encrypted && RCLONE_MAGIC.every((b, i) => got.data[i] === b))
      throw new Error("This file is encrypted (rclone crypt): enable E2EE and enter the password.");
    return this.cipher.decData(got.data);
  }

  private async remoteHash(rf: RemoteFile): Promise<string> {
    const key = `${rf.enc}|${rf.sig}`;
    let h = this.hashCache.get(key);
    if (!h) {
      h = await sha256Hex(await this.download(rf));
      this.hashCache.set(key, h);
    }
    return h;
  }

  private nameTooLong(enc: string): boolean {
    return enc.split("/").some((s) => te.encode(s).length > MAX_SEGMENT);
  }

  // ───────────────────────── analysis (read-only) ─────────────────────────

  /**
   * Shared by sync and dry run. Reads the server listing, scans/hashes local files and runs the
   * 3-way compare. Changes nothing persistent; bookkeeping for the caller is returned in
   * `adopt` / `resetBase`. May download files read-only to prove two copies are identical.
   */
  private async analyze() {
    const { io, state } = this.o;
    await this.init();
    this.phase("Listing files on the server…");
    const remote = await this.listRemote();
    // Empty server folder although we have history (wrong/new folder): re-upload, never delete locally.
    const resetBase = remote.size === 0 && Object.keys(state.files).length > 0;
    const base: Record<string, BaseEntry> = resetBase ? {} : state.files;

    this.phase("Scanning local files…");
    const files = await io.list((p) => this.isExcluded(p));
    const local = new Map(files.map((f) => [f.path, f]));
    const lh = new Map<string, string>();
    const toHash: FileInfo[] = [];
    for (const f of files) {
      const b = base[f.path];
      if (b && b.s === f.size && b.m === f.mtime) lh.set(f.path, b.h);
      else toHash.push(f);
    }
    this.phase(`Checking ${toHash.length} changed file(s) of ${files.length}…`);
    await pool(toHash, this.conc, async (f) => {
      lh.set(f.path, await sha256Hex(await io.read(f.path)));
    });

    const pull: string[] = [];
    const push: string[] = [];
    const delLocal: string[] = [];
    const delRemote: string[] = [];
    const conflicts: string[] = [];
    /** paths where both sides agree: just (re)record the base; null = forget it */
    const adopt: Array<[string, BaseEntry | null]> = [];
    let identical = 0;
    /** exist on both sides with unknown relation: compare content before deciding */
    const maybe: Array<{ p: string; L: string; f: FileInfo; rf: RemoteFile; same?: boolean }> = [];

    const paths = new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)]);
    for (const p of paths) {
      if (this.isExcluded(p)) continue;
      const L = lh.get(p) ?? null;
      const f = local.get(p);
      const rf = remote.get(p);
      const b = base[p];
      if (!b) {
        if (L && !rf) push.push(p);
        else if (!L && rf) pull.push(p);
        else if (L && rf) maybe.push({ p, L, f: f!, rf });
        continue;
      }
      const lc = L !== b.h;
      const rc = (rf ? rf.sig : null) !== b.r;
      if (!lc && !rc) {
        adopt.push([p, { ...b, s: f!.size, m: f!.mtime }]);
        identical++;
      } else if (lc && !rc) (L ? push : delRemote).push(p);
      else if (!lc && rc) (rf ? pull : delLocal).push(p);
      else if (!L && !rf) adopt.push([p, null]); // deleted on both sides
      else if (!L) pull.push(p); // deleted locally, modified remotely -> restore
      else if (!rf) push.push(p); // deleted remotely, modified locally -> keep local
      else maybe.push({ p, L, f: f!, rf });
    }

    if (maybe.length) {
      this.phase(`Comparing ${maybe.length} file(s) with the server…`);
      await pool(maybe, this.conc, async (m) => {
        m.same = m.rf.size === m.f.size && (await this.remoteHash(m.rf)) === m.L;
      });
      for (const m of maybe) {
        if (m.same) {
          adopt.push([m.p, { h: m.L, s: m.f.size, m: m.f.mtime, r: m.rf.sig }]);
          identical++;
        } else conflicts.push(m.p);
      }
    }

    const baseCount = Math.max(1, Object.keys(base).length);
    const bigShare = (n: number) => n >= MASS_DELETE_MIN && n > MASS_DELETE_SHARE * baseCount;
    const massDelete = bigShare(delLocal.length) || bigShare(delRemote.length);

    this.log(`plan: push ${push.length}, pull ${pull.length}, delLocal ${delLocal.length}, delRemote ${delRemote.length}, conflicts ${conflicts.length}`);
    return { remote, local, pull, push, delLocal, delRemote, conflicts, adopt, resetBase, identical, massDelete };
  }

  /**
   * Dry run: shows what a sync would do right now without changing anything
   * (no local writes, no uploads, no deletions, no state changes).
   */
  async dryRun(): Promise<DryRunResult> {
    const a = await this.analyze();
    const items: PlanItem[] = [];
    const tooLong: string[] = [];
    for (const p of a.pull) items.push({ path: p, action: "download", size: a.remote.get(p)!.size >= 0 ? a.remote.get(p)!.size : undefined });
    for (const p of a.push) {
      items.push({ path: p, action: "upload", size: a.local.get(p)!.size });
      if (this.nameTooLong(await this.cipher.encName(p))) tooLong.push(p);
    }
    for (const p of a.delLocal) items.push({ path: p, action: "delete-local" });
    for (const p of a.delRemote) items.push({ path: p, action: "delete-remote" });
    for (const p of a.conflicts) {
      const newer = (a.remote.get(p)!.modified ?? 0) > a.local.get(p)!.mtime ? "server" : "this device";
      items.push({ path: p, action: "conflict", detail: `the ${newer} version keeps the name; the other is saved as a "(conflict …)" copy` });
    }
    this.phase(items.length ? `Dry run: ${items.length} change(s) pending` : "Dry run: nothing to do");
    return { items, identical: a.identical, totalLocal: a.local.size, remoteWillBeReset: a.resetBase, massDelete: a.massDelete, tooLong };
  }

  // ───────────────────────── sync ─────────────────────────

  async sync(): Promise<SyncStats> {
    this.stats = emptyStats();
    this.errors.clear();
    this.phase("Connecting…");
    for (let i = 0; i < 2; i++) if (!(await this.pass())) break; // a 2nd pass uploads conflict copies
    this.stats.errors = [...this.errors].map(([path, message]) => ({ path, message }));
    this.phase(this.stats.errors.length ? `Finished with ${this.stats.errors.length} error(s)` : "Up to date");
    return this.stats;
  }

  /** @returns true if conflict copies were created and another pass should pick them up */
  private async pass(): Promise<boolean> {
    const { io, state } = this.o;
    const a = await this.analyze();
    const { remote, local, pull, push, delLocal, delRemote, conflicts } = a;
    if (a.massDelete && !this.o.allowMassDelete)
      throw new Error(
        `Refusing to delete ${delLocal.length} local / ${delRemote.length} remote files at once — that is a large share of your vault. ` +
          `Run "Check changes" to review. If it is intended, turn on "Allow deleting many files at once" in the plugin settings.`
      );
    if (a.resetBase) {
      this.log("server folder is empty: resetting local base");
      state.files = {};
    }
    for (const [p, b] of a.adopt) {
      if (b) state.files[p] = b;
      else delete state.files[p];
    }

    for (const p of pull) this.emit(p, "download", "pending");
    for (const p of push) this.emit(p, "upload", "pending");
    for (const p of delLocal) this.emit(p, "delete-local", "pending");
    for (const p of delRemote) this.emit(p, "delete-remote", "pending");
    for (const p of conflicts) this.emit(p, "conflict", "pending");
    this.phase(push.length + pull.length + delLocal.length + delRemote.length + conflicts.length ? "Transferring…" : "Nothing to transfer");

    await pool(delLocal, this.conc, (p) =>
      this.run(p, "delete-local", async () => {
        await io.remove(p);
        delete state.files[p];
        this.stats.deletedLocal++;
      })
    );

    await pool(pull, this.conc, (p) => this.run(p, "download", () => this.pullFile(p, remote.get(p)!)));

    // conflicts: the newer side keeps the name, the other version is preserved as a sibling copy
    for (const p of conflicts) {
      await this.run(p, "conflict", async () => {
        const f = local.get(p)!;
        const rf = remote.get(p)!;
        const copy = await this.conflictName(p);
        if ((rf.modified ?? 0) > f.mtime) {
          await io.write(copy, await io.read(p), f.mtime);
          await this.pullFile(p, rf);
        } else {
          await io.write(copy, await this.download(rf), rf.modified ?? Date.now());
          await this.pushFile(p, f, rf);
        }
        this.stats.conflicts++;
        this.log(`conflict on ${p} -> ${copy}`);
        return `kept both versions, other copy: ${copy}`;
      });
    }

    await pool(push, this.conc, (p) => this.run(p, "upload", () => this.pushFile(p, local.get(p)!, remote.get(p))));

    await pool(delRemote, this.conc, (p) => this.run(p, "delete-remote", () => this.deleteRemote(p, remote.get(p)!)));

    await this.o.saveState();
    return conflicts.length > 0;
  }

  private async pullFile(p: string, rf: RemoteFile): Promise<void> {
    const data = await this.download(rf);
    const mtime = rf.modified ?? Date.now();
    await this.o.io.write(p, data, mtime);
    this.o.state.files[p] = { h: await sha256Hex(data), s: data.length, m: mtime, r: rf.sig };
    this.stats.downloaded++;
  }

  /**
   * Uploads one file. Overwrites are conditional (If-Match = the ETag we based our decision on) and
   * new files use If-None-Match, so a concurrent change by another device is never overwritten silently.
   */
  private async pushFile(p: string, f: FileInfo, rf: RemoteFile | undefined): Promise<void> {
    const data = await this.o.io.read(p);
    const enc = await this.cipher.encName(p);
    if (this.nameTooLong(enc))
      throw new Error("File name is too long once encrypted (servers allow ~255 bytes per name segment). Shorten the name or exclude it.");
    const blob = await this.cipher.encData(data);
    const cond = rf ? (rf.etag ? { ifMatch: rf.etag } : {}) : { ifNoneMatch: true };
    try {
      await this.o.dav.put(enc, blob, cond);
    } catch (e) {
      await this.resolveSpurious412(e, enc, rf, () => this.o.dav.put(enc, blob));
    }
    this.stats.bytesUp += blob.length;
    const st = await this.o.dav.stat(enc);
    if (!st) throw new Error("Upload finished but the file is not visible on the server");
    this.o.state.files[p] = { h: await sha256Hex(data), s: data.length, m: f.mtime, r: sigOf(st) };
    this.stats.uploaded++;
  }

  private async deleteRemote(p: string, rf: RemoteFile): Promise<void> {
    try {
      await this.o.dav.delete(rf.enc, rf.etag ? { ifMatch: rf.etag } : {});
    } catch (e) {
      await this.resolveSpurious412(e, rf.enc, rf, () => this.o.dav.delete(rf.enc));
    }
    delete this.o.state.files[p];
    this.stats.deletedRemote++;
  }

  /**
   * A 412 means either another device changed the file meanwhile (real conflict: report it, the next
   * sync reconciles it) or the server's validators don't round-trip. If the file's signature is still
   * what we based our decision on, nobody touched it, so the unconditional retry is safe.
   */
  private async resolveSpurious412(e: unknown, enc: string, rf: RemoteFile | undefined, retry: () => Promise<unknown>) {
    if (!(e instanceof PreconditionFailed)) throw e;
    const cur = await this.o.dav.stat(enc);
    if (rf && cur && sigOf(cur) === rf.sig) {
      this.log(`server rejected If-Match for ${enc.slice(0, 8)}… although unchanged; retrying unconditionally`);
      await retry();
    } else throw new Error("Changed on the server while syncing; it will be reconciled on the next sync.");
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
}
