import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRcloneCipher } from "../src/cipher";
import { compileIgnore } from "../src/util";
import { parseMultistatus } from "../src/webdav";
import { randomBytes } from "./helpers";

describe("rclone-crypt cipher wrapper", () => {
  it("round-trips names and data, and rejects wrong keys / tampering", async () => {
    const c = await makeRcloneCipher("pw", "salt");
    const name = "Archived/2024WP/中国联通 网络安全 决赛.md";
    const enc = await c.encName(name);
    expect(enc).not.toMatch(/Archived|中国|md/);
    expect(enc.split("/")).toHaveLength(3); // directory structure is kept, names are opaque
    expect(await c.decName(enc)).toBe(name);
    expect(await c.encName(name)).toBe(enc); // deterministic: same path -> same server path

    const data = randomBytes(150_000, 9); // spans several 64 KiB blocks
    const blob = await c.encData(data);
    expect(c.plainSize(blob.length)).toBe(data.length);
    expect(await c.decData(blob)).toEqual(data);
    const bad = blob.slice();
    bad[bad.length - 1] ^= 1;
    await expect(c.decData(bad)).rejects.toThrow();

    const other = await makeRcloneCipher("pw", "other-salt");
    await expect(other.decName(enc)).rejects.toThrow();
    await expect(other.decData(blob)).rejects.toThrow();
  }, 30_000);
});

// Interoperability with the real rclone binary (skipped where rclone isn't installed).
const hasRclone = (() => {
  try {
    return spawnSync("rclone", ["version"]).status === 0;
  } catch {
    return false;
  }
})();
const rclone = (...args: string[]) => {
  const r = spawnSync("rclone", args, { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`rclone ${args[0]} failed: ${r.stderr}`);
  return r.stdout as Buffer;
};
const walk = (d: string, rel = ""): string[] =>
  readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n), rel ? `${rel}/${n}` : n) : [rel ? `${rel}/${n}` : n]));

describe.skipIf(!hasRclone)("interop with stock rclone crypt", () => {
  for (const salt of ["salt", ""]) {
    it(`both directions (${salt ? "custom salt" : "rclone default salt"})`, async () => {
      const tmp = mkdtempSync(join(tmpdir(), "obsync-rclone-"));
      const enc = join(tmp, "enc");
      mkdirSync(enc);
      const remote =
        `:crypt,remote=${enc},password=${rclone("obscure", "pw").toString().trim()},` +
        (salt ? `password2=${rclone("obscure", salt).toString().trim()},` : "") +
        `filename_encryption=standard,directory_name_encryption=true,filename_encoding=base32:`;
      const files: Record<string, Uint8Array> = {
        "a.md": new TextEncoder().encode("hello"),
        "Archived/2024WP/中国联通 决赛.md": new TextEncoder().encode("中文 ✓"),
        "empty.md": new Uint8Array(0),
        "img/big.bin": randomBytes(200_000, 3),
      };
      const c = await makeRcloneCipher("pw", salt);

      // ours -> rclone reads it
      for (const [p, d] of Object.entries(files)) {
        const ep = join(enc, await c.encName(p));
        mkdirSync(dirname(ep), { recursive: true });
        writeFileSync(ep, await c.encData(d));
      }
      for (const [p, d] of Object.entries(files)) expect(new Uint8Array(rclone("cat", remote + p))).toEqual(d);
      expect(rclone("lsf", "-R", remote).toString()).toContain("big.bin");

      // rclone writes -> we read it
      const plain = join(tmp, "plain");
      mkdirSync(join(plain, "sub"), { recursive: true });
      writeFileSync(join(plain, "sub", "汉字 name.md"), "一二三");
      writeFileSync(join(plain, "r.bin"), randomBytes(130_000, 4));
      rclone("copy", plain, remote);
      const seen: string[] = [];
      for (const encRel of walk(enc)) {
        const name = await c.decName(encRel);
        if (name in files) continue;
        seen.push(name);
        expect(new Uint8Array(await c.decData(new Uint8Array(readFileSync(join(enc, encRel)))))).toEqual(
          new Uint8Array(readFileSync(join(plain, name)))
        );
      }
      expect(seen.sort()).toEqual(["r.bin", "sub/汉字 name.md"]);
    }, 60_000);
  }
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
