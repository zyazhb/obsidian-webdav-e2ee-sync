/**
 * FastCDC-style content-defined chunking (Xia et al., USENIX ATC'16):
 * gear rolling hash + normalized chunking (stricter mask before the average
 * size, looser after it). Boundaries depend on content, so an insertion or
 * edit only changes the chunks around it — the rest keep their ids and need
 * not be transferred again.
 */
export interface ChunkOptions {
  min: number;
  avg: number; // must be a power of two
  max: number;
}

export const DEFAULT_CHUNK: ChunkOptions = { min: 16 * 1024, avg: 64 * 1024, max: 256 * 1024 };

// Deterministic gear table (xorshift32) so every device cuts identical boundaries.
const GEAR = (() => {
  const t = new Int32Array(256);
  let x = 0x9e3779b9 | 0;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    t[i] = x | 0;
  }
  return t;
})();

/** Returns [start, end) ranges covering `data`. */
export function chunkRanges(data: Uint8Array, opts: ChunkOptions = DEFAULT_CHUNK): Array<[number, number]> {
  const { min, avg, max } = opts;
  const bits = Math.round(Math.log2(avg));
  // Masks use the high bits of the 32-bit hash, which depend on the last 32 bytes.
  const maskS = -1 << (32 - (bits + 2));
  const maskL = -1 << (32 - (bits - 2));
  const n = data.length;
  const out: Array<[number, number]> = [];
  let off = 0;
  while (off < n) {
    if (n - off <= min) {
      out.push([off, n]);
      break;
    }
    const limit = Math.min(n, off + max);
    const mid = Math.min(limit, off + avg);
    let i = off + min;
    let fp = 0;
    let cut = limit;
    for (; i < mid; i++) {
      fp = ((fp << 1) + GEAR[data[i]]) | 0;
      if ((fp & maskS) === 0) {
        cut = i + 1;
        break;
      }
    }
    if (cut === limit) {
      for (; i < limit; i++) {
        fp = ((fp << 1) + GEAR[data[i]]) | 0;
        if ((fp & maskL) === 0) {
          cut = i + 1;
          break;
        }
      }
    }
    out.push([off, cut]);
    off = cut;
  }
  return out;
}
