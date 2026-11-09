import jsQR from "jsqr";
import qrcode from "qrcode-generator";

/** Module matrix of a QR code (error correction M, byte mode, auto size). */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** Black-on-white RGBA bitmap with a 4-module quiet zone (white even in dark themes, or scanners fail). */
export function renderQrRgba(text: string, targetPx = 320): { data: Uint8ClampedArray; size: number } {
  const m = qrMatrix(text);
  const quiet = 4;
  const total = m.length + quiet * 2;
  const scale = Math.max(3, Math.floor(targetPx / total));
  const size = total * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < m.length; r++)
    for (let c = 0; c < m.length; c++) {
      if (!m[r][c]) continue;
      for (let y = 0; y < scale; y++)
        for (let x = 0; x < scale; x++) {
          const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
  return { data, size };
}

export function drawQr(canvas: HTMLCanvasElement, text: string, targetPx = 320): void {
  const { data, size } = renderQrRgba(text, targetPx);
  canvas.width = canvas.height = size;
  canvas.getContext("2d")!.putImageData(new ImageData(data, size, size), 0, 0);
}

export function decodeQr(data: Uint8ClampedArray, width: number, height: number): string | null {
  return jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}
