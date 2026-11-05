import { App, DataAdapter, requestUrl } from "obsidian";
import type { FileInfo, VaultIO } from "./engine";
import { pool } from "./util";
import type { HttpFn } from "./webdav";

const toArrayBuffer = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** Uses Obsidian's requestUrl, which bypasses CORS (needed for most WebDAV servers). */
export const obsidianHttp: HttpFn = async (r) => {
  const res = await requestUrl({
    url: r.url,
    method: r.method,
    headers: r.headers,
    body: r.body instanceof Uint8Array ? toArrayBuffer(r.body) : r.body,
    throw: false,
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, body: res.arrayBuffer };
};

export class ObsidianVaultIO implements VaultIO {
  constructor(private app: App) {}

  private get a(): DataAdapter {
    return this.app.vault.adapter;
  }

  async list(skip: (path: string, isDir: boolean) => boolean): Promise<FileInfo[]> {
    const names: string[] = [];
    const walk = async (dir: string) => {
      const l = await this.a.list(dir);
      for (const f of l.files) if (!skip(f, false)) names.push(f);
      for (const d of l.folders) if (!skip(d, true)) await walk(d);
    };
    await walk("/");
    const out: FileInfo[] = [];
    await pool(names, 16, async (path) => {
      const st = await this.a.stat(path);
      if (st && st.type === "file") out.push({ path, size: st.size, mtime: st.mtime });
    });
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.a.readBinary(path));
  }

  async write(path: string, data: Uint8Array, mtime: number): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let dir = "";
    for (const seg of parts) {
      dir = dir ? `${dir}/${seg}` : seg;
      if (!(await this.a.exists(dir))) await this.a.mkdir(dir);
    }
    await this.a.writeBinary(path, toArrayBuffer(data), { mtime });
  }

  async remove(path: string): Promise<void> {
    // honour the user's "deleted files" preference (system trash / .trash / permanent)
    const trashed = await this.app.fileManager
      .trashFile(this.app.vault.getAbstractFileByPath(path) as never)
      .then(() => true)
      .catch(() => false);
    if (!trashed && (await this.a.exists(path))) await this.a.remove(path);
  }

  exists(path: string): Promise<boolean> {
    return this.a.exists(path);
  }
}
