import { App, Modal, Notice, Setting } from "obsidian";
import { Pairing, PAIR_PREFIX, decodePairing, encodePairing } from "./pairing";
import { decodeQr, drawQr } from "./qr";

const SHOW_SECONDS = 120;

/** Shows the pairing QR code (+ copyable text) on the device that already has the key. */
export class ShowQrModal extends Modal {
  private timer: number | null = null;
  private includeServer: boolean;

  constructor(app: App, private build: (includeServer: boolean) => Pairing, hasServer: boolean) {
    super(app);
    this.includeServer = hasServer;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wds-modal");
    this.titleEl.setText("Pair another device");
    contentEl.createEl("p", {
      cls: "wds-warn",
      text: "This code contains your encryption key. Anyone who scans it can read your synced notes. Show it only to your own device — it closes automatically.",
    });

    const qrBox = contentEl.createDiv({ cls: "wds-qr" });
    const canvas = qrBox.createEl("canvas");
    const countdown = contentEl.createDiv({ cls: "wds-sub" });
    let code = "";
    const draw = () => {
      code = encodePairing(this.build(this.includeServer));
      drawQr(canvas, code, 360);
    };
    draw();

    new Setting(contentEl)
      .setName("Include WebDAV server settings")
      .setDesc("URL, username, password and remote folder. Off = only the encryption key.")
      .addToggle((t) =>
        t.setValue(this.includeServer).onChange((v) => {
          this.includeServer = v;
          draw();
        })
      );
    new Setting(contentEl)
      .setName("Can't scan?")
      .setDesc("Copy the code as text and paste it on the other device (\"Scan QR code\" → paste).")
      .addButton((b) =>
        b.setButtonText("Copy code").onClick(async () => {
          await navigator.clipboard.writeText(code);
          new Notice("Pairing code copied. Clear your clipboard after pasting.");
        })
      );

    let left = SHOW_SECONDS;
    const tick = () => {
      countdown.setText(`Closes in ${left}s`);
      if (left-- <= 0) this.close();
    };
    tick();
    this.timer = window.setInterval(tick, 1000);
  }

  onClose() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.contentEl.empty(); // drop the canvas holding the secret
  }
}

/**
 * Scans a pairing QR code. Three ways in, because camera access inside the mobile
 * Obsidian webview is not guaranteed: live camera, a photo/screenshot, or pasted text.
 */
export class ScanQrModal extends Modal {
  private stream: MediaStream | null = null;
  private raf = 0;
  private done = false;
  private status!: HTMLElement;

  constructor(app: App, private onCode: (text: string) => void) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wds-modal");
    this.titleEl.setText("Scan pairing QR code");
    const video = contentEl.createEl("video", { cls: "wds-video" });
    video.setAttribute("playsinline", "true");
    video.muted = true;
    this.status = contentEl.createDiv({ cls: "wds-sub", text: "Starting camera…" });

    new Setting(contentEl)
      .setName("Take or choose a photo")
      .setDesc("Photograph the QR code, or pick a screenshot of it.")
      .addButton((b) => {
        const input = contentEl.createEl("input", { type: "file", attr: { accept: "image/*" } });
        input.style.display = "none";
        input.addEventListener("change", () => input.files?.[0] && void this.fromImage(input.files[0]));
        b.setButtonText("Photo…").onClick(() => input.click());
      });

    let pasted = "";
    new Setting(contentEl)
      .setName("Paste code")
      .setDesc("The text from \"Copy code\" on the other device.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder(`${PAIR_PREFIX}…`).onChange((v) => (pasted = v));
      })
      .addButton((b) => b.setButtonText("Use").onClick(() => this.finish(pasted)));

    void this.startCamera(video);
  }

  private finish(text: string) {
    if (this.done || !text.trim()) return;
    this.done = true;
    this.close();
    this.onCode(text);
  }

  private async startCamera(video: HTMLVideoElement) {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.status.setText("Live camera isn't available here. Use “Photo…” or paste the code.");
      video.hide();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (this.done || !this.contentEl.isConnected) return stream.getTracks().forEach((t) => t.stop());
      this.stream = stream;
      video.srcObject = stream;
      await video.play();
      this.status.setText("Point the camera at the QR code on your other device.");
      this.loop(video);
    } catch (e) {
      const name = (e as Error).name;
      this.status.setText(
        name === "NotAllowedError"
          ? "Camera permission denied. Allow camera access for Obsidian in system settings, or use “Photo…” / paste the code."
          : `Camera unavailable (${name}). Use “Photo…” or paste the code.`
      );
      video.hide();
    }
  }

  private loop(video: HTMLVideoElement) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    let last = 0;
    const step = (now: number) => {
      if (this.done) return;
      if (now - last > 120 && video.readyState >= 2 && video.videoWidth) {
        last = now;
        const k = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * k);
        canvas.height = Math.round(video.videoHeight * k);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const text = decodeQr(img.data, img.width, img.height);
        if (text?.toUpperCase().startsWith(PAIR_PREFIX)) return this.finish(text);
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private async fromImage(file: File) {
    this.status.setText("Reading image…");
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("Could not open the image."));
        i.src = url;
      });
      // phone photos are huge; try a few sizes since the decoder is sensitive to scale
      for (const max of [1200, 800, 1800, 500]) {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k);
        c.height = Math.round(img.naturalHeight * k);
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const text = decodeQr(d.data, d.width, d.height);
        if (text) return this.finish(text);
      }
      this.status.setText("No QR code found in that image. Try again with the code filling more of the frame.");
    } catch (e) {
      this.status.setText((e as Error).message);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  onClose() {
    this.done = true;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.contentEl.empty();
  }
}

/** Shows what a scanned code will change (never the secrets) and asks before applying. */
export class ConfirmPairingModal extends Modal {
  constructor(app: App, private p: Pairing, private hasKey: boolean, private apply: () => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("Apply pairing?");
    const ul = contentEl.createEl("ul");
    if (this.p.server) {
      let host = this.p.server.url;
      try {
        host = new URL(this.p.server.url).host;
      } catch {
        /* show raw */
      }
      ul.createEl("li", { text: `Server: ${host}` });
      ul.createEl("li", { text: `Username: ${this.p.server.user || "(none)"}` });
      ul.createEl("li", { text: `Remote folder: ${this.p.server.dir || "(root)"}` });
    }
    ul.createEl("li", { text: `Encryption key: ${this.p.key.length} characters (hidden)` });
    contentEl.createEl("p", {
      cls: "wds-warn",
      text: this.hasKey ? "This replaces the settings currently saved on this device." : "End-to-end encryption will be enabled.",
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Apply and sync")
          .setCta()
          .onClick(() => {
            this.close();
            this.apply();
          })
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}
