import { describe, expect, it } from "vitest";
import { chunkRanges } from "../src/chunker";
import { newMeta, unlock } from "../src/crypto";
import { compileIgnore, toHex } from "../src/util";
import { parseMultistatus } from "../src/webdav";
import { randomBytes } from "./helpers";

describe("chunker", () => {
  it("covers the input exactly and respects size bounds", () => {
    const data = randomBytes(3_000_000, 7);
    const ranges = chunkRanges(data);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[ranges.length - 1][1]).toBe(data.length);
    ranges.forEach(([s, e], i) => {
      if (i > 0) expect(s).toBe(ranges[i - 1][1]);
      expect(e - s).toBeLessThanOrEqual(256 * 1024);
      if (i < ranges.length - 1) expect(e - s).toBeGreaterThanOrEqual(16 * 1024);
    });
    const avg = data.length / ranges.length;
    expect(avg).toBeGreaterThan(32 * 1024);
    expect(avg).toBeLessThan(140 * 1024);
  });

  it("is shift-resistant: inserting bytes only changes nearby chunks", () => {
    const a = randomBytes(2_000_000, 3);
    const b = new Uint8Array(a.length + 100);
    b.set(a.subarray(0, 1_000_000), 0);
    b.set(randomBytes(100, 99), 1_000_000);
    b.set(a.subarray(1_000_000), 1_000_100);
    const key = (d: Uint8Array) => chunkRanges(d).map(([s, e]) => toHex(d.subarray(s, e).slice(0, 32)) + (e - s));
    const ka = new Set(key(a));
    const kb = key(b);
    const reused = kb.filter((k) => ka.has(k)).length;
    expect(reused).toBeGreaterThanOrEqual(kb.length - 3);
  });

  it("handles empty and tiny inputs", () => {
    expect(chunkRanges(new Uint8Array(0))).toEqual([]);
    expect(chunkRanges(new Uint8Array(10))).toEqual([[0, 10]]);
  });
});

describe("crypto", () => {
  it("round-trips, binds AAD, rejects tampering and wrong passwords", async () => {
    const { meta, cipher } = await newMeta("pw-1");
    const msg = new TextEncoder().encode("hello world");
    const blob = await cipher.encrypt(msg, "aad");
    expect(new TextDecoder().decode(await cipher.decrypt(blob, "aad"))).toBe("hello world");
    await expect(cipher.decrypt(blob, "other-aad")).rejects.toThrow();
    const bad = blob.slice();
    bad[bad.length - 1] ^= 1;
    await expect(cipher.decrypt(bad, "aad")).rejects.toThrow();
    // same plaintext twice -> different ciphertext (random IV) but the same chunk id
    expect(toHex(await cipher.encrypt(msg, "aad"))).not.toBe(toHex(blob));
    expect(await cipher.chunkId(msg)).toBe(await cipher.chunkId(msg));

    const again = await unlock(meta, "pw-1");
    expect(await again.chunkId(msg)).toBe(await cipher.chunkId(msg));
    await expect(unlock(meta, "nope")).rejects.toThrow(/wrong/i);
  }, 30_000);
});

describe("webdav + ignore helpers", () => {
  it("parses multistatus with any namespace prefix and entities", () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a/b%20c/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
      <D:response><D:href>/a/b%20c/f.bin</D:href><D:propstat><D:prop><D:resourcetype/><D:getetag>&quot;x1&quot;</D:getetag><D:getcontentlength>5</D:getcontentlength></D:prop></D:propstat></D:response></D:multistatus>`;
    const r = parseMultistatus(xml);
    expect(r[0]).toMatchObject({ pathname: "/a/b c", isDir: true });
    expect(r[1]).toMatchObject({ name: "f.bin", isDir: false, etag: '"x1"', size: 5 });
  });

  it("compiles ignore globs", () => {
    const res = compileIgnore(["Private/**", "*.tmp", "# c", "/root-only.md"]);
    const hit = (p: string) => res.some((r) => r.test(p));
    expect(hit("Private/a/b.md")).toBe(true);
    expect(hit("a/b.tmp")).toBe(true);
    expect(hit("notes/Private/x.md")).toBe(false);
    expect(hit("root-only.md")).toBe(true);
    expect(hit("x/root-only.md")).toBe(false);
    expect(hit("a.md")).toBe(false);
  });
});
