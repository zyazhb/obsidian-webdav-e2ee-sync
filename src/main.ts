import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, debounce } from "obsidian";
import { ConfirmPairingModal, ScanQrModal, ShowQrModal } from "./pair-ui";
import { Pairing, decodePairing } from "./pairing";
import { DryRunResult, FileAction, FileEvent, LocalState, SyncEngine, SyncStats } from "./engine";
import { ObsidianVaultIO, obsidianHttp } from "./obsidian-io";
import { StatusRow, StatusSource, StatusSummary, SyncStatusView, VIEW_TYPE } from "./view";
import { WebDAV } from "./webdav";

const ACTION_DONE: Record<FileAction, string> = {
  upload: "uploaded",
  download: "downloaded",
  "delete-local": "deleted locally (removed on another device)",
  "delete-remote": "deletion sent to server",
  conflict: "conflict resolved",
};
const ACTION_ACTIVE: Record<FileAction, string> = {
  upload: "uploading…",
  download: "downloading…",
  "delete-local": "deleting locally…",
  "delete-remote": "sending deletion…",
  conflict: "resolving conflict…",
};
const ACTION_QUEUED: Record<FileAction, string> = {
  upload: "queued: upload",
  download: "queued: download",
  "delete-local": "queued: delete locally",
  "delete-remote": "queued: delete on server",
  conflict: "queued: conflict",
};

interface Settings {
  serverUrl: string;
  username: string;
  password: string;
  remoteDir: string;
  e2ee: boolean;
  e2eePassword: string;
  e2eeSalt: string;
  allowMassDelete: boolean;
  intervalMin: number;
  syncOnStartup: boolean;
  syncOnChange: boolean;
  includeConfig: boolean;
  ignore: string;
  deviceName: string;
}

const DEFAULTS: Settings = {
  serverUrl: "",
  username: "",
  password: "",
  remoteDir: "obsidian-vault",
  e2ee: true,
  e2eePassword: "",
  e2eeSalt: "",
  allowMassDelete: false,
  intervalMin: 0,
  syncOnStartup: true,
  syncOnChange: false,
  includeConfig: false,
  ignore: "",
  deviceName: "",
};

export default class WebDavSyncPlugin extends Plugin implements StatusSource {
  settings!: Settings;
  private fileStatus = new Map<string, FileEvent & { time: number }>();
  private phase = "";
  private lastSync = "";
  private lastTime = "";
  private failed = false;
  settingsTab!: SyncSettingTab;
  private preview: { time: string; result: DryRunResult } | null = null;
  /** mobile has no status bar: a persistent notice shows progress during a manual sync */
  private progressNotice: Notice | null = null;
  private notify = debounce(() => this.refreshViews(), 200, true);
  private state: LocalState = { remoteId: "", files: {} };
  private engine: SyncEngine | null = null;
  private syncing = false;
  private statusEl!: HTMLElement;
  private timer: number | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    if (!this.settings.deviceName) {
      this.settings.deviceName = `device-${Math.random().toString(36).slice(2, 6)}`;
      await this.saveSettings();
    }
    this.state = await this.loadState();

    this.registerView(VIEW_TYPE, (leaf) => new SyncStatusView(leaf, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("wds-statusbar");
    this.statusEl.setAttribute("aria-label", "Open WebDAV sync status");
    this.statusEl.addEventListener("click", () => void this.activateView());
    this.setStatus("idle");
    this.addRibbonIcon("refresh-cw", "WebDAV sync status", () => void this.activateView());
    this.addCommand({ id: "preview", name: "Check changes (dry run, changes nothing)", callback: () => void this.previewChanges() });
    this.addCommand({ id: "show-status", name: "Show sync status", callback: () => void this.activateView() });
    this.settingsTab = new SyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.addCommand({ id: "show-pairing-qr", name: "Pair another device: show QR code", callback: () => this.showPairingQr() });
    if (Platform.isMobile)
      this.addCommand({ id: "scan-pairing-qr", name: "Pair this device: scan QR code", callback: () => this.scanPairingQr() });

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync() });
    this.addCommand({
      id: "reset-state",
      name: "Reset local sync state (next sync re-compares every file)",
      callback: async () => {
        this.state.files = {};
        await this.saveState();
        new Notice("Local sync state cleared.");
      },
    });

    const onChange = debounce(() => {
      if (this.settings.syncOnChange && !this.syncing) void this.runSync(true);
    }, 20_000, true);
    for (const ev of ["create", "modify", "delete", "rename"] as const) {
      this.registerEvent(this.app.vault.on(ev as "modify", onChange));
      this.registerEvent(this.app.vault.on(ev as "modify", () => this.notify())); // keep status live
    }
    this.app.workspace.onLayoutReady(() => this.notify());

    this.applyInterval();
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.syncOnStartup && this.configured()) window.setTimeout(() => void this.runSync(true), 3000);
    });
  }

  // ───────── persistence ─────────

  private statePath() {
    return `${this.manifest.dir}/state.json`;
  }
  private async loadState(): Promise<LocalState> {
    try {
      const p = this.statePath();
      if (await this.app.vault.adapter.exists(p)) return JSON.parse(await this.app.vault.adapter.read(p));
    } catch (e) {
      console.warn("[webdav-sync] could not read state, starting fresh", e);
    }
    return { remoteId: "", files: {} };
  }
  async saveState() {
    await this.app.vault.adapter.write(this.statePath(), JSON.stringify(this.state));
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.engine = null; // re-create (and re-derive keys) with the new settings
    this.applyInterval();
  }

  // ───────── sync control ─────────

  configured() {
    const s = this.settings;
    return !!s.serverUrl && (!s.e2ee || !!s.e2eePassword);
  }

  private applyInterval() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.settings.intervalMin > 0) {
      this.timer = window.setInterval(() => void this.runSync(true), this.settings.intervalMin * 60_000);
      this.registerInterval(this.timer);
    }
  }

  private setStatus(text: string) {
    this.statusEl?.setText(`WebDAV: ${text}`);
    this.progressNotice?.setMessage(`WebDAV: ${text}`);
  }

  // ───────── pairing (share the E2EE key by QR code) ─────────

  showPairingQr() {
    const s = this.settings;
    if (!s.e2ee || !s.e2eePassword) return void new Notice("Enable E2EE and set the encryption password first.");
    new ShowQrModal(
      this.app,
      (withServer): Pairing => ({
        key: s.e2eePassword,
        salt: s.e2eeSalt,
        server: withServer ? { url: s.serverUrl, user: s.username, pass: s.password, dir: s.remoteDir } : undefined,
      }),
      !!s.serverUrl
    ).open();
  }

  scanPairingQr() {
    new ScanQrModal(this.app, (text) => this.handlePairingText(text)).open();
  }

  private handlePairingText(text: string) {
    let p: Pairing;
    try {
      p = decodePairing(text);
    } catch (e) {
      return void new Notice((e as Error).message, 8000);
    }
    new ConfirmPairingModal(this.app, p, !!this.settings.e2eePassword, () => void this.applyPairing(p)).open();
  }

  private async applyPairing(p: Pairing) {
    const s = this.settings;
    s.e2ee = true;
    s.e2eePassword = p.key;
    s.e2eeSalt = p.salt ?? "";
    if (p.server) {
      s.serverUrl = p.server.url;
      s.username = p.server.user;
      s.password = p.server.pass;
      s.remoteDir = p.server.dir;
    }
    await this.saveSettings();
    this.settingsTab.display();
    // never start a real sync on pairing: show a dry run first so nothing is overwritten unseen
    new Notice(p.server ? "Paired. Checking what a sync would change — nothing is modified yet." : "Encryption key saved. Check the server settings, then check changes.", 8000);
    if (this.configured()) void this.previewChanges();
  }

  // ───────── status view ─────────

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    void workspace.revealLeaf(leaf);
  }

  /** no base recorded yet on this device: nothing has been compared with the server */
  private isFirstSync() {
    return Object.keys(this.state.files).length === 0;
  }

  private updateIdleStatus() {
    if (this.syncing) return;
    if (this.failed) return this.setStatus("error – click for details");
    if (!this.configured()) return this.setStatus("not configured");
    const rows = this.getRows();
    const errors = rows.filter((r) => r.state === "error").length;
    const waiting = rows.filter((r) => r.state === "unsynced").length;
    if (errors) this.setStatus(`${errors} file error(s) – click for details`);
    else if (waiting && this.isFirstSync()) this.setStatus("first sync pending");
    else if (waiting) this.setStatus(`${waiting} unsynced change(s)`);
    else this.setStatus(this.lastTime ? `synced ${this.lastTime}` : "idle");
  }

  private refreshViews() {
    this.updateIdleStatus();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as SyncStatusView).render();
  }

  private progress() {
    let done = 0;
    for (const e of this.fileStatus.values()) if (e.status === "done" || e.status === "error") done++;
    return { done, total: this.fileStatus.size };
  }

  private onFileEvent = (e: FileEvent) => {
    this.fileStatus.set(e.path, { ...e, time: Date.now() });
    if (this.syncing) {
      const { done, total } = this.progress();
      this.setStatus(`syncing ${done}/${total}`);
    }
    this.notify();
  };

  getSummary(): StatusSummary {
    return { syncing: this.syncing, phase: this.phase, ...this.progress(), lastSync: this.lastSync, preview: this.previewText() };
  }

  syncNow() {
    void this.runSync();
  }

  previewNow() {
    void this.previewChanges();
  }

  private previewText(): string | undefined {
    if (!this.preview) return undefined;
    const { result: r, time } = this.preview;
    const n = (a: FileAction) => r.items.filter((i) => i.action === a).length;
    const parts = [`↑ ${n("upload")} upload`, `↓ ${n("download")} download`, `✕ ${n("delete-local") + n("delete-remote")} delete`, `⚠ ${n("conflict")} conflict`];
    const empty = r.items.filter((i) => i.action === "upload" && i.size === 0).length;
    const warn =
      (empty ? ` ⚠ ${empty} of the uploads are EMPTY (0 B) files — check them before syncing.` : "") +
      (r.tooLong.length ? ` ⚠ ${r.tooLong.length} file name(s) are too long once encrypted and cannot be uploaded.` : "") +
      (r.massDelete ? " ⚠ This would delete many files at once; a sync will refuse unless you allow it in settings." : "") +
      (r.remoteWillBeReset ? " ⚠ The server folder is empty: everything would be uploaded again." : "");
    return `Dry run at ${time} — ${r.items.length ? parts.join(" · ") : "nothing to change"}; ${r.identical} identical (no transfer). Nothing has been changed yet.${warn}`;
  }

  /** Compares with the server and shows what a sync would do. Changes nothing. */
  async previewChanges() {
    if (this.syncing) return void new Notice("A sync is already running.");
    if (!this.configured()) return void new Notice("WebDAV sync: set the server URL (and E2EE password) in settings first.");
    this.syncing = true;
    this.preview = null;
    this.phase = "Checking changes (nothing will be modified)…";
    this.setStatus("checking…");
    this.notify();
    try {
      const result = await this.getEngine().dryRun();
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.preview = { time, result };
      new Notice(this.previewText() ?? "", 10_000);
      await this.activateView();
    } catch (e) {
      console.error("[webdav-sync]", e);
      this.phase = `Check failed: ${(e as Error).message}`;
      new Notice(`Check failed: ${(e as Error).message}`, 10_000);
    } finally {
      this.syncing = false;
      this.notify();
    }
  }

  openFile(path: string) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
    else new Notice("This file is not in the vault (it may have been deleted).");
  }

  getRows(): StatusRow[] {
    const rows = new Map<string, StatusRow>();
    const eng = this.configured() ? this.getEngine() : null;
    for (const f of this.app.vault.getFiles()) {
      if (eng?.isExcluded(f.path)) {
        rows.set(f.path, { path: f.path, state: "ignored", label: "ignored by rules" });
        continue;
      }
      const b = this.state.files[f.path];
      const synced = !!b && b.s === f.stat.size && b.m === f.stat.mtime;
      rows.set(
        f.path,
        synced
          ? { path: f.path, state: "synced", label: "in sync" }
          : {
              path: f.path,
              state: "unsynced",
              label: b
                ? "changed locally, not yet synced"
                : this.isFirstSync()
                  ? "not compared with the server yet (first sync: identical files are not re-uploaded)"
                  : "new, not yet synced",
            }
      );
    }
    // files synced before but gone locally: their deletion is still waiting to be sent
    // (hidden paths are skipped: the vault index does not list dotfiles, so we can't tell)
    for (const p of Object.keys(this.state.files)) {
      if (rows.has(p) || p.split("/").some((s) => s.startsWith("."))) continue;
      if (eng?.isExcluded(p)) continue;
      rows.set(p, { path: p, state: "unsynced", label: "deleted locally, deletion not yet synced" });
    }
    if (this.preview) {
      const WOULD: Record<FileAction, string> = {
        upload: "would upload",
        download: "would download",
        "delete-local": "would delete here (deleted on another device)",
        "delete-remote": "would delete on the server",
        conflict: "conflict: both sides changed",
      };
      for (const it of this.preview.result.items) {
        const size = it.size !== undefined ? ` (${fmt(it.size)})` : "";
        rows.set(it.path, { path: it.path, state: "preview", label: `${WOULD[it.action]}${size}`, detail: it.detail });
      }
    }
    for (const [path, e] of this.fileStatus) {
      const time = new Date(e.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const row: StatusRow =
        e.status === "error"
          ? { path, state: "error", label: `${e.action} failed (will retry next sync)`, detail: e.detail }
          : e.status === "done"
            ? { path, state: "done", label: `${ACTION_DONE[e.action]} at ${time}`, detail: e.detail }
            : e.status === "active"
              ? { path, state: "active", label: ACTION_ACTIVE[e.action] }
              : { path, state: "pending", label: ACTION_QUEUED[e.action] };
      rows.set(path, row);
    }
    return [...rows.values()];
  }

  private makeDav() {
    const s = this.settings;
    return new WebDAV(s.serverUrl, s.username, s.password, obsidianHttp, s.remoteDir);
  }

  private getEngine(): SyncEngine {
    if (this.engine) return this.engine;
    const s = this.settings;
    const remoteId = `${s.serverUrl}|${s.remoteDir}|${s.e2ee ? "crypt" : "plain"}`;
    if (this.state.remoteId !== remoteId) this.state = { remoteId, files: {} };
    this.engine = new SyncEngine({
      io: new ObsidianVaultIO(this.app),
      dav: this.makeDav(),
      state: this.state,
      saveState: () => this.saveState(),
      password: s.e2ee ? s.e2eePassword : null,
      salt: s.e2eeSalt,
      allowMassDelete: s.allowMassDelete,
      ignore: s.ignore.split("\n"),
      includeConfig: s.includeConfig,
      configDir: this.app.vault.configDir,
      pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
      deviceName: s.deviceName,
      log: (m) => console.debug("[webdav-sync]", m),
      concurrency: Platform.isMobile ? 2 : 4, // gentler on phone CPU, memory and radio
      onEvent: this.onFileEvent,
      onPhase: (t) => {
        this.phase = t;
        this.progressNotice?.setMessage(`WebDAV: ${t}`);
        this.notify();
      },
    });
    return this.engine;
  }

  async runSync(silent = false) {
    if (this.syncing) {
      if (!silent) new Notice("A sync is already running.");
      return;
    }
    if (!this.configured()) {
      if (!silent) new Notice("WebDAV sync: set the server URL (and E2EE password) in settings first.");
      return;
    }
    this.syncing = true;
    this.failed = false;
    if (Platform.isMobile && !silent) this.progressNotice = new Notice("WebDAV: starting…", 0);
    this.fileStatus.clear();
    this.preview = null;
    this.phase = "Starting…";
    this.setStatus("syncing…");
    this.notify();
    try {
      const st = await this.getEngine().sync();
      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.lastTime = time;
      this.lastSync = new Date().toLocaleString();
      const msg = summarize(st);
      if (msg && !silent) new Notice(`Sync done: ${msg}`);
      else if (!msg && !st.errors.length && !silent) new Notice("Already up to date.");
      if (st.conflicts) new Notice(`${st.conflicts} conflict(s): a "(conflict …)" copy was kept next to the file.`, 10_000);
      if (st.errors.length)
        new Notice(`${st.errors.length} file(s) failed, e.g. ${st.errors[0].path}: ${st.errors[0].message}\nOpen "Show sync status" for the full list.`, 12_000);
    } catch (e) {
      console.error("[webdav-sync]", e);
      this.phase = `Failed: ${(e as Error).message}`;
      this.failed = true;
      // don't leave files looking "in progress" after an aborted sync
      for (const [p, ev] of this.fileStatus)
        if (ev.status === "active" || ev.status === "pending")
          this.fileStatus.set(p, { ...ev, status: "error", detail: "sync aborted before this was committed", time: Date.now() });
      new Notice(`Sync failed: ${(e as Error).message}`, 10_000);
    } finally {
      this.syncing = false;
      this.progressNotice?.hide();
      this.progressNotice = null;
      this.notify();
    }
  }

  async testConnection(): Promise<string> {
    try {
      await this.makeDav().test();
      return "OK";
    } catch (e) {
      return (e as Error).message;
    }
  }
}

function summarize(s: SyncStats): string {
  const parts: string[] = [];
  if (s.uploaded) parts.push(`↑${s.uploaded}`);
  if (s.downloaded) parts.push(`↓${s.downloaded}`);
  if (s.deletedLocal || s.deletedRemote) parts.push(`✕${s.deletedLocal + s.deletedRemote}`);
  if (s.bytesUp || s.bytesDown) parts.push(`${fmt(s.bytesUp)} up / ${fmt(s.bytesDown)} down`);
  return parts.join("  ");
}
function fmt(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

class SyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: WebDavSyncPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl: el } = this;
    const s = this.plugin.settings;
    el.empty();

    const text = (name: string, desc: string, key: keyof Settings, opts: { secret?: boolean; placeholder?: string } = {}) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          if (opts.secret) t.inputEl.type = "password";
          t.setPlaceholder(opts.placeholder ?? "")
            .setValue(String(s[key]))
            .onChange(async (v) => {
              (s[key] as string) = v.trim();
              await this.plugin.saveSettings();
            });
        });

    new Setting(el).setName("WebDAV server").setHeading();
    text("Server URL", "e.g. https://dav.example.com/remote.php/dav/files/me", "serverUrl", { placeholder: "https://…" });
    text("Username", "", "username");
    text("Password", "Stored in this plugin's data.json inside the vault's config folder (never synced).", "password", { secret: true });
    text("Remote folder", "Created automatically. Use a dedicated folder per vault.", "remoteDir");
    new Setting(el).setName("Test connection").addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        new Notice(`Connection: ${await this.plugin.testConnection()}`);
      })
    );

    new Setting(el).setName("End-to-end encryption").setHeading();
    new Setting(el)
      .setName("Enable E2EE")
      .setDesc("Stored in rclone crypt format: file contents and names are encrypted (XSalsa20-Poly1305 / AES-EME), so you can always read the vault with stock rclone. Must match the remote folder.")
      .addToggle((t) =>
        t.setValue(s.e2ee).onChange(async (v) => {
          s.e2ee = v;
          await this.plugin.saveSettings();
        })
      );
    text("Encryption password", "Not recoverable. If you lose it, the remote data cannot be decrypted. Use the same password on every device.", "e2eePassword", { secret: true });
    text("Salt (optional)", "rclone's \"password2\". Leave empty to use rclone's built-in salt. Must be identical on every device (the QR code carries it).", "e2eeSalt", { secret: true });

    new Setting(el).setName("Pair devices with a QR code").setHeading();
    new Setting(el)
      .setName("Show QR code")
      .setDesc("On the device that already works: show a QR code with the encryption key (and optionally the server settings) for your other devices to scan.")
      .addButton((b) => b.setButtonText("Show QR").onClick(() => this.plugin.showPairingQr()));
    if (Platform.isMobile)
      new Setting(el)
        .setName("Scan QR code")
        .setDesc("Scan the code shown on your computer. If the camera doesn't open, take/choose a photo of it or paste the code.")
        .addButton((b) => b.setButtonText("Scan").setCta().onClick(() => this.plugin.scanPairingQr()));

    new Setting(el).setName("Sync behaviour").setHeading();
    new Setting(el)
      .setName("Auto sync interval (minutes)")
      .setDesc("0 disables periodic sync.")
      .addText((t) =>
        t.setValue(String(s.intervalMin)).onChange(async (v) => {
          s.intervalMin = Math.max(0, Number(v) || 0);
          await this.plugin.saveSettings();
        })
      );
    const toggle = (name: string, desc: string, key: "syncOnStartup" | "syncOnChange" | "includeConfig" | "allowMassDelete") =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = v;
            await this.plugin.saveSettings();
          })
        );
    toggle("Sync on startup", "Run a sync a few seconds after Obsidian opens.", "syncOnStartup");
    toggle("Sync after changes", "Sync 20 s after the last edit.", "syncOnChange");
    toggle("Allow deleting many files at once", "By default a sync refuses to delete 20+ files (and over 30% of the vault) in one go, to protect against accidents. Use \"Check changes\" to review first.", "allowMassDelete");
    toggle("Sync config folder", "Include .obsidian (themes, snippets, hotkeys, plugins). This plugin's own folder and workspace files are always skipped.", "includeConfig");
    new Setting(el)
      .setName("Ignore patterns")
      .setDesc("One glob per line (* within a folder, ** across folders). Example: Private/**   or   *.tmp")
      .addTextArea((t) =>
        t.setValue(s.ignore).onChange(async (v) => {
          s.ignore = v;
          await this.plugin.saveSettings();
        })
      );
    text("Device name", "Used to label conflict copies.", "deviceName");

    new Setting(el)
      .setName("Check changes (dry run)")
      .setDesc("Compare with the server and list what a sync would upload, download, delete or flag as a conflict. Changes nothing.")
      .addButton((b) => b.setButtonText("Check").onClick(() => void this.plugin.previewChanges()));
    new Setting(el).setName("Sync now").addButton((b) => b.setButtonText("Sync").setCta().onClick(() => void this.plugin.runSync()));
  }
}
