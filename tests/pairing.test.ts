import { describe, expect, it } from "vitest";
import { decodePairing, encodePairing, PAIR_PREFIX } from "../src/pairing";
import { decodeQr, renderQrRgba } from "../src/qr";

const full = {
  key: "correct horse battery staple ✓ 密码",
  server: { url: "https://dav.example.com/remote.php/dav/files/me", user: "me@example.com", pass: "p@ss/w:rd?&=", dir: "Vaults/我的笔记" },
};

describe("pairing code", () => {
  it("round-trips key + server (incl. unicode and URL-hostile characters)", () => {
    const code = encodePairing(full);
    expect(code.startsWith(PAIR_PREFIX)).toBe(true);
    expect(code).toMatch(/^OBSYNC1:[A-Za-z0-9_-]+$/); // url-safe, no padding
    expect(decodePairing(code)).toEqual(full);
    expect(decodePairing(`  \n${code}\n `)).toEqual(full); // whitespace from scanners/clipboard
  });

  it("carries the rclone salt (password2) when set, and omits it when empty", () => {
    const withSalt = { ...full, salt: "my salt ✓ 盐" };
    expect(decodePairing(encodePairing(withSalt))).toEqual(withSalt);
    expect(decodePairing(encodePairing({ ...full, salt: "" }))).toEqual(full); // empty salt = rclone default, not sent
    expect(() => decodePairing(PAIR_PREFIX + btoa(JSON.stringify({ v: 1, k: "x", s: 5 })).replace(/=+$/, ""))).toThrow(/salt/);
  });

  it("supports key-only codes", () => {
    expect(decodePairing(encodePairing({ key: "k" }))).toEqual({ key: "k" });
  });

  it("rejects foreign, damaged, wrong-version and malicious payloads", () => {
    expect(() => decodePairing("https://example.com")).toThrow(/not a WebDAV/);
    expect(() => decodePairing("OBSYNC1:@@@@")).toThrow(/damaged/);
    const enc = (o: unknown) => PAIR_PREFIX + btoa(JSON.stringify(o)).replace(/=+$/, "");
    expect(() => decodePairing(enc({ v: 2, k: "x" }))).toThrow(/version/);
    expect(() => decodePairing(enc({ v: 1 }))).toThrow(/key/);
    expect(() => decodePairing(enc({ v: 1, k: "x", u: "javascript:alert(1)", n: "", p: "", d: "" }))).toThrow(/http/);
    expect(() => decodePairing(enc({ v: 1, k: "x".repeat(600) }))).toThrow(/key/);
  });
});

describe("QR code", () => {
  it("what we draw is what a scanner decodes (typical and long payloads)", () => {
    for (const code of [encodePairing({ key: "k" }), encodePairing(full), encodePairing({ ...full, key: "x".repeat(300) })]) {
      const { data, size } = renderQrRgba(code);
      expect(decodeQr(data, size, size)).toBe(code);
    }
  });

  it("decodes when the code is shown scaled down and on a dark background (inverted)", () => {
    const code = encodePairing(full);
    const { data, size } = renderQrRgba(code, 200);
    const inv = data.slice();
    for (let i = 0; i < inv.length; i += 4) inv[i] = inv[i + 1] = inv[i + 2] = 255 - inv[i];
    expect(decodeQr(inv, size, size)).toBe(code);
  });
});
