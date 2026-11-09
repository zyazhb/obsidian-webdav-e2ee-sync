import { ItemView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE = "webdav-sync-status";

export type RowState = "active" | "pending" | "error" | "done" | "synced" | "unsynced" | "ignored" | "preview";
export interface StatusRow {
  path: string;
  state: RowState;
  label: string;
  detail?: string;
}
export interface StatusSummary {
  syncing: boolean;
  phase: string;
  done: number;
  total: number;
  lastSync: string;
  /** one-line result of the last dry run, if any */
  preview?: string;
}
export interface StatusSource {
  getRows(): StatusRow[];
  getSummary(): StatusSummary;
  syncNow(): void;
  previewNow(): void;
  openFile(path: string): void;
}

const ICON: Record<RowState, string> = {
  active: "⟳",
  pending: "…",
  error: "⚠",
  done: "✓",
  synced: "✓",
  unsynced: "●",
  ignored: "–",
  preview: "◇",
};
const ORDER: Record<RowState, number> = { active: 0, error: 1, pending: 2, preview: 3, unsynced: 4, done: 5, synced: 6, ignored: 7 };
const MAX_ROWS = 500;

type Filter = "attention" | "all" | "errors";

export class SyncStatusView extends ItemView {
  private filter: Filter = "attention";
  private query = "";
  private listEl!: HTMLElement;
  private headEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private src: StatusSource) {
    super(leaf);
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "WebDAV sync status";
  }
  getIcon() {
    return "refresh-cw";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("wds-view");
    this.headEl = root.createDiv({ cls: "wds-head" });

    const bar = root.createDiv({ cls: "wds-toolbar" });
    const search = bar.createEl("input", { type: "search", placeholder: "Filter files…" });
    search.addEventListener("input", () => {
      this.query = search.value.toLowerCase();
      this.renderList();
    });
    const sel = bar.createEl("select");
    for (const [v, t] of [
      ["attention", "Needs attention + recent"],
      ["all", "All files"],
      ["errors", "Errors only"],
    ] as const)
      sel.createEl("option", { value: v, text: t });
    sel.addEventListener("change", () => {
      this.filter = sel.value as Filter;
      this.renderList();
    });

    this.listEl = root.createDiv({ cls: "wds-list" });
    this.render();
  }

  /** Called by the plugin whenever status changes. */
  render() {
    if (!this.headEl) return;
    const s = this.src.getSummary();
    this.headEl.empty();
    const top = this.headEl.createDiv({ cls: "wds-top" });
    top.createSpan({ cls: "wds-phase", text: s.syncing ? s.phase : s.phase || "Idle" });
    const btns = top.createDiv({ cls: "wds-btns" });
    const check = btns.createEl("button", { text: "Check changes" });
    check.setAttribute("aria-label", "Dry run: compare with the server and list what a sync would do, without changing anything");
    check.disabled = s.syncing;
    check.addEventListener("click", () => this.src.previewNow());
    const btn = btns.createEl("button", { text: s.syncing ? "Syncing…" : "Sync now", cls: "mod-cta" });
    btn.disabled = s.syncing;
    btn.addEventListener("click", () => this.src.syncNow());
    if (s.total > 0) {
      const prog = this.headEl.createEl("progress");
      prog.max = s.total;
      prog.value = s.done;
      this.headEl.createDiv({ cls: "wds-sub", text: `${s.done} / ${s.total} files` });
    }
    if (s.preview) this.headEl.createDiv({ cls: "wds-previewbox", text: s.preview });
    if (s.lastSync) this.headEl.createDiv({ cls: "wds-sub", text: `Last sync: ${s.lastSync}` });
    this.renderList();
  }

  private renderList() {
    if (!this.listEl) return;
    const all = this.src.getRows();
    const counts: Record<RowState, number> = { active: 0, pending: 0, error: 0, done: 0, synced: 0, unsynced: 0, ignored: 0, preview: 0 };
    for (const r of all) counts[r.state]++;

    let rows = all.filter((r) => (this.query ? r.path.toLowerCase().includes(this.query) : true));
    if (this.filter === "errors") rows = rows.filter((r) => r.state === "error");
    else if (this.filter === "attention") rows = rows.filter((r) => r.state !== "synced" && r.state !== "ignored");
    rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.path.localeCompare(b.path));

    this.listEl.empty();
    this.listEl.createDiv({
      cls: "wds-counts",
      text:
        `${counts.synced + counts.done} synced · ${counts.unsynced + counts.pending} waiting · ` +
        `${counts.active} in progress · ${counts.error} errors · ${counts.ignored} ignored` +
        (counts.preview ? ` · ${counts.preview} would change` : ""),
    });
    if (!rows.length) this.listEl.createDiv({ cls: "wds-empty", text: "Nothing to show." });
    for (const r of rows.slice(0, MAX_ROWS)) {
      const row = this.listEl.createDiv({ cls: `wds-row wds-${r.state}` });
      row.createSpan({ cls: "wds-icon", text: ICON[r.state] });
      const body = row.createDiv({ cls: "wds-body" });
      const name = body.createDiv({ cls: "wds-path", text: r.path });
      name.addEventListener("click", () => this.src.openFile(r.path));
      body.createDiv({ cls: "wds-label", text: r.detail ? `${r.label} — ${r.detail}` : r.label });
    }
    if (rows.length > MAX_ROWS) this.listEl.createDiv({ cls: "wds-empty", text: `…and ${rows.length - MAX_ROWS} more (use the filter)` });
  }
}
