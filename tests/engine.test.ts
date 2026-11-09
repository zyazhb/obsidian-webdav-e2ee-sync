import { beforeEach, describe, expect, it } from "vitest";
import { EngineOptions, LocalState, SyncEngine } from "../src/engine";
import { WebDAV } from "../src/webdav";
import { FakeDavServer, MemoryVault, randomBytes } from "./helpers";

function device(server: FakeDavServer, name: string, password: string | null = "pw", extra: Partial<EngineOptions> = {}) {
  const vault = new MemoryVault();
  const state: LocalState = { remoteId: "x", files: {} };
  const engine = new SyncEngine({
    io: vault,
    dav: new WebDAV(server.base, "u", "p", server.http, "vault/sub"),
    state,
    saveState: async () => {},
    password,
    salt: "salt",
    configDir: ".obsidian",
    pluginDir: ".obsidian/plugins/webdav-e2ee-sync",
    deviceName: name,
    ...extra,
  });
  return { vault, state, engine };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const dec = (d: Uint8Array) => new TextDecoder().decode(d);
const FUTURE = 9_000_000_000_000; // an mtime newer than any server upload time

describe("sync engine (rclone-crypt, per-file)", () => {
  let server: FakeDavServer;
  beforeEach(() => {
    server = new FakeDavServer();
  });

  it("syncs between devices; the server sees only rclone-crypt ciphertext and opaque names", async () => {
    const A = device(server, "A");
    const B = device(server, "B");
    A.vault.put("notes/secret-plan.md", "TOP-SECRET-MARKER launch at dawn");
    A.vault.put("img/photo.bin", randomBytes(200_000, 5));
    expect((await A.engine.sync()).uploaded).toBe(2);

    const s2 = await B.engine.sync();
    expect(s2.downloaded).toBe(2);
    expect(B.vault.text("notes/secret-plan.md")).toContain("TOP-SECRET-MARKER");
    expect(same(B.vault.files.get("img/photo.bin")!.data, A.vault.files.get("img/photo.bin")!.data)).toBe(true);

    const { paths, blobs } = server.dump();
    expect(paths.join("\n")).not.toMatch(/secret|photo|notes|img/i);
    const marker = new TextEncoder().encode("TOP-SECRET-MARKER");
    for (const b of blobs) {
      expect(dec(b.subarray(0, 6))).toBe("RCLONE"); // rclone crypt file header
      expect(indexOf(b, marker)).toBe(-1);
    }

    // an unchanged vault costs only directory listings: no uploads, no downloads, no deletes
    server.resetLog();
    const s3 = await B.engine.sync();
    expect(s3).toMatchObject({ uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0 });
    expect(server.count("GET")).toBe(0);
    expect(server.count("PUT")).toBe(0);
  }, 60_000);

  it("propagates edits in both directions", async () => {
    const A = device(server, "A");
    const B = device(server, "B");
    A.vault.put("n.md", "v1");
    await A.engine.sync();
    await B.engine.sync();
    A.vault.put("n.md", "v2 from A");
    expect((await A.engine.sync()).uploaded).toBe(1);
    expect((await B.engine.sync()).downloaded).toBe(1);
    expect(B.vault.text("n.md")).toBe("v2 from A");
    B.vault.put("n.md", "v3 from B");
    await B.engine.sync();
    await A.engine.sync();
    expect(A.vault.text("n.md")).toBe("v3 from B");
  }, 60_000);

  it("propagates deletions", async () => {
    const A = device(server, "A");
    const B = device(server, "B");
    A.vault.put("a.md", "one");
    A.vault.put("b.md", "two");
    await A.engine.sync();
    await B.engine.sync();
    A.vault.files.delete("a.md");
    expect((await A.engine.sync()).deletedRemote).toBe(1);
    expect((await B.engine.sync()).deletedLocal).toBe(1);
    expect(B.vault.files.has("a.md")).toBe(false);
    expect(B.vault.text("b.md")).toBe("two");
    expect((await A.engine.sync()).uploaded).toBe(0);
  }, 60_000);

  it("keeps both versions on conflict (newer wins the name, the other is saved as a copy)", async () => {
    const A = device(server, "A");
    const B = device(server, "B");
    A.vault.put("n.md", "base");
    await A.engine.sync();
    await B.engine.sync();
    A.vault.put("n.md", "from A");
    B.vault.put("n.md", "from B (newer)", FUTURE);
    await A.engine.sync();
    const s = await B.engine.sync();
    expect(s.conflicts).toBe(1);
    expect(B.vault.text("n.md")).toBe("from B (newer)");
    const copy = [...B.vault.files.keys()].find((k) => k.startsWith("n (conflict B"));
    expect(copy).toBeTruthy();
    expect(B.vault.text(copy!)).toBe("from A");
    await A.engine.sync(); // everything converges on A as well
    expect(A.vault.text("n.md")).toBe("from B (newer)");
    expect(A.vault.text(copy!)).toBe("from A");
  }, 60_000);

  it("local edit beats a remote deletion; remote edit restores a locally deleted file", async () => {
    const A = device(server, "A");
    const B = device(server, "B");
    A.vault.put("x.md", "v1");
    A.vault.put("y.md", "v1");
    await A.engine.sync();
    await B.engine.sync();
    A.vault.files.delete("x.md");
    await A.engine.sync();
    B.vault.put("x.md", "v2 edited on B");
    A.vault.put("y.md", "v2 edited on A");
    B.vault.files.delete("y.md");
    await B.engine.sync();
    expect(B.vault.text("x.md")).toBe("v2 edited on B");
    await A.engine.sync();
    expect(A.vault.text("x.md")).toBe("v2 edited on B");
    await B.engine.sync();
    expect(B.vault.text("y.md")).toBe("v2 edited on A");
  }, 60_000);

  it("rejects a wrong password or salt, and does not misread an encrypted folder as plain", async () => {
    const A = device(server, "A", "right");
    A.vault.put("a.md", "x");
    await A.engine.sync();
    await expect(device(server, "B", "wrong").engine.sync()).rejects.toThrow(/decrypted/i);
    await expect(device(server, "B2", "right", { salt: "other" }).engine.sync()).rejects.toThrow(/decrypted/i);
    const C = device(server, "C", null); // E2EE off against an encrypted folder
    const s = await C.engine.sync();
    expect(s.errors.length).toBeGreaterThan(0);
    expect(s.errors[0].message).toMatch(/encrypted/i);
    expect(C.vault.files.size).toBe(0);
  }, 60_000);

  it("works without E2EE (files are stored as they are)", async () => {
    const A = device(server, "A", null);
    const B = device(server, "B", null);
    A.vault.put("notes/a.md", "plain");
    await A.engine.sync();
    expect(server.files.has("vault/sub/notes/a.md")).toBe(true);
    await B.engine.sync();
    expect(B.vault.text("notes/a.md")).toBe("plain");
  });

  it("never syncs the plugin dir, .git, or ignored paths; config dir only when enabled", async () => {
    const A = device(server, "A", null, { ignore: ["Private/**"] });
    const B = device(server, "B", null, { ignore: ["Private/**"] });
    A.vault.put(".obsidian/plugins/webdav-e2ee-sync/data.json", "{password}");
    A.vault.put(".obsidian/app.json", "{}");
    A.vault.put(".git/HEAD", "ref");
    A.vault.put("Private/diary.md", "no");
    A.vault.put("ok.md", "yes");
    await A.engine.sync();
    await B.engine.sync();
    expect([...B.vault.files.keys()]).toEqual(["ok.md"]);

    const C = device(server, "C", null, { includeConfig: true });
    const D = device(server, "D", null, { includeConfig: true });
    C.vault.put(".obsidian/app.json", "{cfg}");
    C.vault.put(".obsidian/workspace.json", "{}");
    C.vault.put(".obsidian/plugins/webdav-e2ee-sync/data.json", "{password}");
    await C.engine.sync();
    await D.engine.sync();
    expect(D.vault.text(".obsidian/app.json")).toBe("{cfg}");
    expect(D.vault.files.has(".obsidian/workspace.json")).toBe(false);
    expect(D.vault.files.has(".obsidian/plugins/webdav-e2ee-sync/data.json")).toBe(false);
  }, 60_000);

  it("an empty/new server folder never wipes the local vault", async () => {
    const A = device(server, "A", null);
    A.vault.put("keep.md", "precious");
    await A.engine.sync();
    const fresh = new FakeDavServer(); // the plugin was pointed at an empty server
    const A2 = device(fresh, "A", null);
    A2.state.files = structuredClone(A.state.files);
    A2.vault.files = A.vault.files;
    await A2.engine.sync();
    expect(A2.vault.text("keep.md")).toBe("precious");
    expect(fresh.files.size).toBeGreaterThan(0);
  });

  it("a file changed by another device during upload is not overwritten (If-Match) and is reconciled next sync", async () => {
    const A = device(server, "A", null);
    A.vault.put("a.md", "v1");
    await A.engine.sync();
    A.vault.put("a.md", "v2 from A");
    const orig = server.http;
    let hit = false;
    server.http = async (r) => {
      if (r.method === "PUT" && r.headers?.["If-Match"] && !hit) {
        hit = true;
        server.files.get("vault/sub/a.md")!.etag = "changed-by-B"; // another device wrote in between
      }
      return orig(r);
    };
    const A2 = device(server, "A", null);
    A2.vault.files = A.vault.files;
    A2.state.files = A.state.files;
    const s = await A2.engine.sync();
    expect(hit).toBe(true);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0].message).toMatch(/changed on the server/i);
    expect(server.files.get("vault/sub/a.md")!.etag).toBe("changed-by-B"); // not overwritten
    expect((await A2.engine.sync()).errors).toHaveLength(0); // reconciled (conflict handling)
  }, 60_000);

  it("many files into a new folder at once work even if the server answers 403 to MKCOL on an existing folder", async () => {
    server.mkcolExistsStatus = 403; // observed on a real Apache-based service
    const A = device(server, "A");
    for (let i = 0; i < 12; i++) A.vault.put(`Archived/sub/note${i}.md`, `n${i}`); // same new folders, concurrent uploads
    A.vault.put("Other/x.md", "x");
    const s = await A.engine.sync();
    expect(s.errors).toEqual([]);
    expect(s.uploaded).toBe(13);
    const B = device(server, "B");
    expect((await B.engine.sync()).downloaded).toBe(13);
  }, 60_000);

  it("works on servers whose If-Match never matches when nothing actually changed", async () => {
    server.ifMatchAlwaysFails = true;
    const A = device(server, "A", null);
    A.vault.put("a.md", "1");
    await A.engine.sync();
    A.vault.put("a.md", "2");
    const s = await A.engine.sync();
    expect(s.uploaded).toBe(1);
    expect(s.errors).toHaveLength(0);
    const B = device(server, "B", null);
    await B.engine.sync();
    expect(B.vault.text("a.md")).toBe("2");
    A.vault.files.delete("a.md");
    expect((await A.engine.sync()).deletedRemote).toBe(1);
  });

  it("reports per-file events; one failing file does not abort the rest and is retried next sync", async () => {
    const events: string[] = [];
    const orig = server.http;
    let failed = 0;
    server.http = async (r) => {
      if (r.method === "PUT" && failed++ === 0) return { status: 500, headers: {}, body: new ArrayBuffer(0) };
      return orig(r);
    };
    const A = device(server, "A", null, { onEvent: (e) => events.push(`${e.path}:${e.action}:${e.status}`) });
    A.vault.put("one.md", "first");
    A.vault.put("two.md", "second");
    const s = await A.engine.sync();
    expect(s.errors).toHaveLength(1);
    expect(s.uploaded).toBe(1);
    const bad = s.errors[0].path;
    const good = bad === "one.md" ? "two.md" : "one.md";
    expect(events).toContain(`${good}:upload:done`);
    expect(events).toContain(`${bad}:upload:error`);
    expect(events).toContain(`${bad}:upload:pending`);
    expect(A.state.files[bad]).toBeUndefined();

    const B = device(server, "B", null);
    await B.engine.sync();
    expect(B.vault.files.has(bad)).toBe(false);
    expect((await A.engine.sync()).errors).toHaveLength(0);
    await B.engine.sync();
    expect(B.vault.text(bad)).toBeTruthy();
  }, 60_000);

  it("dry run lists the plan, changes nothing, proves identical copies by content, and matches what sync then does", async () => {
    const A = device(server, "A");
    A.vault.put("same.md", "identical");
    A.vault.put("remote-only.md", "from A");
    A.vault.put("clash.md", "A version");
    await A.engine.sync();

    const B = device(server, "B"); // e.g. a phone that already holds a copy of the vault
    B.vault.put("same.md", "identical", FUTURE);
    B.vault.put("local-only.md", "from B");
    B.vault.put("clash.md", "B version", FUTURE); // same size as A's: must be compared by content
    const before = new Map([...B.vault.files].map(([k, v]) => [k, dec(v.data)]));

    server.resetLog();
    const plan = await B.engine.dryRun();
    const by = (a: string) => plan.items.filter((i) => i.action === a).map((i) => i.path);
    expect(by("download")).toEqual(["remote-only.md"]);
    expect(by("upload")).toEqual(["local-only.md"]);
    expect(by("conflict")).toEqual(["clash.md"]);
    expect(plan.identical).toBe(1); // same.md: nothing to transfer
    expect(server.count("PUT")).toBe(0);
    expect(server.count("DELETE")).toBe(0);
    expect(new Map([...B.vault.files].map(([k, v]) => [k, dec(v.data)]))).toEqual(before);
    expect(B.state.files).toEqual({});

    const s = await B.engine.sync();
    expect(s.uploaded).toBeGreaterThanOrEqual(1);
    expect(s.downloaded).toBeGreaterThanOrEqual(1);
    expect(s.conflicts).toBe(1);
    expect(B.vault.text("remote-only.md")).toBe("from A");
    expect(B.vault.text("same.md")).toBe("identical");
  }, 60_000);

  it("refuses a sync that would delete a large share of the vault, unless allowed; dry run flags it", async () => {
    const A = device(server, "A", null);
    for (let i = 0; i < 30; i++) A.vault.put(`n${i}.md`, `note ${i}`);
    await A.engine.sync();
    for (let i = 0; i < 25; i++) A.vault.files.delete(`n${i}.md`); // e.g. an accident or a failed storage mount
    const plan = await A.engine.dryRun();
    expect(plan.massDelete).toBe(true);
    await expect(A.engine.sync()).rejects.toThrow(/Refusing to delete/);
    expect(server.files.size).toBeGreaterThanOrEqual(30); // nothing was deleted remotely

    const allowed = device(server, "A", null, { allowMassDelete: true });
    allowed.vault.files = A.vault.files;
    allowed.state.files = A.state.files;
    expect((await allowed.engine.sync()).deletedRemote).toBe(25);
  }, 60_000);

  it("file names that are too long once encrypted fail on their own, with a clear message", async () => {
    const A = device(server, "A");
    const long = "长".repeat(80) + ".md"; // 240 bytes of UTF-8 -> far beyond 255 once base32-encrypted
    A.vault.put(long, "x");
    A.vault.put("fine.md", "y");
    const plan = await A.engine.dryRun();
    expect(plan.tooLong).toEqual([long]);
    const s = await A.engine.sync();
    expect(s.uploaded).toBe(1);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0].message).toMatch(/too long/i);
  }, 60_000);
});

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
