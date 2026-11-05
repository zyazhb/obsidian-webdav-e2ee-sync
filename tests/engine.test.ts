import { beforeEach, describe, expect, it } from "vitest";
import { LocalState, SyncEngine } from "../src/engine";
import { WebDAV } from "../src/webdav";
import { FakeDavServer, MemoryVault, randomBytes } from "./helpers";

const SMALL = { min: 1024, avg: 4096, max: 16384 };

function device(server: FakeDavServer, name: string, password: string | null = "pw", extra: Partial<ConstructorParameters<typeof SyncEngine>[0]> = {}) {
  const vault = new MemoryVault();
  const state: LocalState = { remoteId: "x", files: {} };
  const engine = new SyncEngine({
    io: vault,
    dav: new WebDAV(server.base, "u", "p", server.http, "vault/sub"),
    state,
    saveState: async () => {},
    password,
    configDir: ".obsidian",
    pluginDir: ".obsidian/plugins/webdav-e2ee-sync",
    deviceName: name,
    chunk: SMALL,
    ...extra,
  });
  return { vault, state, engine };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

describe("sync engine", () => {
  let server: FakeDavServer;
  beforeEach(() => {
    server = new FakeDavServer();
  });

  it("syncs between devices; the server sees only ciphertext and opaque paths", async () => {
    const A = device(server, "A");
    const B = device(server, "B");
    A.vault.put("notes/secret-plan.md", "TOP-SECRET-MARKER launch at dawn");
    A.vault.put("img/photo.bin", randomBytes(200_000, 5));
    const s1 = await A.engine.sync();
    expect(s1.uploaded).toBe(2);

    const s2 = await B.engine.sync();
    expect(s2.downloaded).toBe(2);
    expect(B.vault.text("notes/secret-plan.md")).toContain("TOP-SECRET-MARKER");
    expect(same(B.vault.files.get("img/photo.bin")!.data, A.vault.files.get("img/photo.bin")!.data)).toBe(true);
    // mtime is preserved
    expect(B.vault.files.get("notes/secret-plan.md")!.mtime).toBe(A.vault.files.get("notes/secret-plan.md")!.mtime);

    const { paths, blobs } = server.dump();
    expect(paths.join("\n")).not.toMatch(/secret|photo|notes|img/i);
    const marker = new TextEncoder().encode("TOP-SECRET-MARKER");
    for (const b of blobs) expect(indexOf(b, marker)).toBe(-1);

    // a second run is a no-op with no uploads/downloads
    const s3 = await B.engine.sync();
    expect(s3).toMatchObject({ uploaded: 0, downloaded: 0, chunksUp: 0, chunksDown: 0 });
  }, 60_000);

  it("delta sync: a small edit in a big file moves only a few chunks, both directions", async () => {
    const A = device(server, "A");
    const B = device(server, "B");
    const big = randomBytes(1_000_000, 11);
    A.vault.put("big.bin", big);
    const first = await A.engine.sync();
    expect(first.chunksUp).toBeGreaterThan(50);
    await B.engine.sync();

    const edited = big.slice();
    edited.set(randomBytes(300, 77), 500_000); // overwrite 300 bytes in the middle
    A.vault.put("big.bin", edited);
    const up = await A.engine.sync();
    expect(up.uploaded).toBe(1);
    expect(up.chunksUp).toBeGreaterThanOrEqual(1);
    expect(up.chunksUp).toBeLessThanOrEqual(4);
    expect(up.bytesUp).toBeLessThan(80_000);

    server.resetLog();
    const down = await B.engine.sync();
    expect(down.downloaded).toBe(1);
    expect(down.chunksDown).toBeLessThanOrEqual(4);
    expect(server.count("GET", "vault/sub/chunks")).toBeLessThanOrEqual(4);
    expect(same(B.vault.files.get("big.bin")!.data, edited)).toBe(true);
  }, 120_000);

  it("insertion in a big file (shifted content) still reuses the unshifted chunks", async () => {
    const A = device(server, "A");
    const big = randomBytes(600_000, 21);
    A.vault.put("big.bin", big);
    await A.engine.sync();
    const ins = new Uint8Array(big.length + 50);
    ins.set(big.subarray(0, 300_000));
    ins.set(randomBytes(50, 2), 300_000);
    ins.set(big.subarray(300_000), 300_050);
    A.vault.put("big.bin", ins);
    const s = await A.engine.sync();
    expect(s.chunksUp).toBeLessThanOrEqual(5);
  }, 60_000);

  it("propagates deletions and restores nothing by accident", async () => {
    const A = device(server, "A");
    const B = device(server, "B");
    A.vault.put("a.md", "one");
    A.vault.put("b.md", "two");
    await A.engine.sync();
    await B.engine.sync();
    A.vault.files.delete("a.md");
    const s = await A.engine.sync();
    expect(s.deletedRemote).toBe(1);
    const sb = await B.engine.sync();
    expect(sb.deletedLocal).toBe(1);
    expect(B.vault.files.has("a.md")).toBe(false);
    expect(B.vault.text("b.md")).toBe("two");
    expect((await A.engine.sync()).uploaded).toBe(0);
  }, 60_000);

  it("keeps both versions on conflict (newer wins the path, older saved as a copy)", async () => {
    const A = device(server, "A");
    const B = device(server, "B");
    A.vault.put("n.md", "base");
    await A.engine.sync();
    await B.engine.sync();
    A.vault.put("n.md", "from A");
    B.vault.put("n.md", "from B (newer)", 1_800_000_000_000); // explicitly later than A's edit
    await A.engine.sync();
    const s = await B.engine.sync();
    expect(s.conflicts).toBe(1);
    expect(B.vault.text("n.md")).toBe("from B (newer)");
    const copy = [...B.vault.files.keys()].find((k) => k.startsWith("n (conflict B"));
    expect(copy).toBeTruthy();
    expect(B.vault.text(copy!)).toBe("from A");
    // everything converges on A as well
    await A.engine.sync();
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
    await A.engine.sync(); // x deleted remotely
    B.vault.put("x.md", "v2 edited on B"); // B edits x while A deleted it
    A.vault.put("y.md", "v2 edited on A");
    B.vault.files.delete("y.md"); // B deletes y while A edited it
    await B.engine.sync();
    expect(B.vault.text("x.md")).toBe("v2 edited on B");
    await A.engine.sync();
    expect(A.vault.text("x.md")).toBe("v2 edited on B");
    await B.engine.sync();
    expect(B.vault.text("y.md")).toBe("v2 edited on A");
  }, 60_000);

  it("rejects a wrong password and mismatching E2EE mode", async () => {
    const A = device(server, "A", "right");
    A.vault.put("a.md", "x");
    await A.engine.sync();
    await expect(device(server, "B", "wrong").engine.sync()).rejects.toThrow(/wrong/i);
    await expect(device(server, "C", null).engine.sync()).rejects.toThrow(/encrypted/i);
  }, 60_000);

  it("works without E2EE too", async () => {
    const A = device(server, "A", null);
    const B = device(server, "B", null);
    A.vault.put("a.md", "plain");
    await A.engine.sync();
    await B.engine.sync();
    expect(B.vault.text("a.md")).toBe("plain");
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

  it("a fresh/empty remote does not wipe the local vault", async () => {
    const A = device(server, "A", null);
    A.vault.put("keep.md", "precious");
    await A.engine.sync();
    const fresh = new FakeDavServer(); // user pointed the plugin at an empty server
    const A2 = device(fresh, "A", null);
    A2.state.files = structuredClone(A.state.files);
    A2.vault.files = A.vault.files;
    await A2.engine.sync();
    expect(A2.vault.text("keep.md")).toBe("precious");
    expect(fresh.files.size).toBeGreaterThan(0);
  });

  it("retries when the index changes concurrently (If-Match)", async () => {
    const A = device(server, "A", null);
    const B = device(server, "B", null);
    A.vault.put("a.md", "a");
    await A.engine.sync();
    await B.engine.sync();
    // B starts a sync whose index PUT races with A: simulate by having A commit between B's GET and PUT
    A.vault.put("a2.md", "from A");
    B.vault.put("b2.md", "from B");
    const origHttp = server.http;
    let raced = false;
    server.http = async (r) => {
      if (r.method === "PUT" && r.url.endsWith("/index.bin") && !raced) {
        raced = true;
        server.http = origHttp;
        await A.engine.sync();
      }
      return origHttp(r);
    };
    const mine = device(server, "B2", null); // new engine object sharing nothing but server
    mine.vault.files = B.vault.files;
    mine.state.files = B.state.files;
    await mine.engine.sync();
    expect(raced).toBe(true);
    await A.engine.sync();
    expect(A.vault.text("b2.md")).toBe("from B");
    expect(mine.vault.text("a2.md")).toBe("from A");
  }, 60_000);

  it("reports per-file events; one failing file does not abort the rest and is retried next sync", async () => {
    const events: string[] = [];
    const orig = server.http;
    let failed = 0;
    server.http = async (r) => {
      if (r.method === "PUT" && r.url.includes("/chunks/") && failed++ === 0) return { status: 500, headers: {}, body: new ArrayBuffer(0) };
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
    expect(B.vault.files.has(bad)).toBe(false); // failed file not published
    const s2 = await A.engine.sync(); // retry
    expect(s2.errors).toHaveLength(0);
    await B.engine.sync();
    expect(B.vault.text(bad)).toBeTruthy();
  }, 60_000);

  it("works on servers whose GET ETag is transformed (Apache mod_deflate '-gzip')", async () => {
    server.gzipEtagOnGet = true;
    const A = device(server, "A", null);
    const B = device(server, "B", null);
    A.vault.put("a.md", "1");
    await A.engine.sync();
    await B.engine.sync();
    A.vault.put("a.md", "2");
    await A.engine.sync();
    await B.engine.sync();
    expect(B.vault.text("a.md")).toBe("2");
  });

  it("falls back when the server's If-Match never matches but nothing changed", async () => {
    server.ifMatchAlwaysFails = true;
    const A = device(server, "A", null);
    A.vault.put("a.md", "1");
    await A.engine.sync();
    A.vault.put("a.md", "2");
    A.vault.put("b.md", "x");
    const s = await A.engine.sync();
    expect(s.uploaded).toBe(2);
    const B = device(server, "B", null);
    await B.engine.sync();
    expect(B.vault.text("a.md")).toBe("2");
  });

  it("gc removes only unreferenced, old chunks", async () => {
    const A = device(server, "A");
    A.vault.put("f.bin", randomBytes(100_000, 4));
    await A.engine.sync();
    A.vault.put("f.bin", randomBytes(100_000, 5)); // totally different content
    await A.engine.sync();
    const before = [...server.files.keys()].filter((k) => k.includes("/chunks/")).length;
    expect((await A.engine.gc(3600_000)).deleted).toBe(0); // too young
    const r = await A.engine.gc(-1);
    expect(r.deleted).toBeGreaterThan(0);
    const after = [...server.files.keys()].filter((k) => k.includes("/chunks/")).length;
    expect(after).toBe(before - r.deleted);
    // file is still intact for another device
    const B = device(server, "B");
    await B.engine.sync();
    expect(same(B.vault.files.get("f.bin")!.data, A.vault.files.get("f.bin")!.data)).toBe(true);
  }, 60_000);
});

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
