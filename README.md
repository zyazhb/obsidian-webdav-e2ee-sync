# WebDAV E2EE Sync（Obsidian 插件）

通过 WebDAV 同步 Vault，端到端加密（**rclone crypt 格式**），支持同步前预览（dry run）。支持桌面端与移动端。

## 安装

```bash
bun install && bun run build   # 生成 main.js（需要 Bun）
```

把 `main.js`、`manifest.json`、`styles.css` 复制到 `<vault>/.obsidian/plugins/webdav-e2ee-sync/`，然后在 Obsidian 里启用。

## 设计

**存储格式 = rclone crypt**：每个笔记对应服务器上的一个加密文件，不使用自定义协议和索引。
- 内容：NaCl secretbox（XSalsa20-Poly1305），64 KiB 分块；文件名与目录名：AES-EME 加密 + base32；密钥：scrypt。插件里没有自己实现的密码学，使用 [`@fyears/rclone-crypt`](https://www.npmjs.com/package/@fyears/rclone-crypt)。
- **随时可用 rclone 读写**：服务器上的数据不依赖本插件。在 rclone 里新建 crypt remote（`filename_encryption=standard`、`directory_name_encryption=true`、`filename_encoding=base32`，密码和 password2 与插件里一致，不设盐则用 rclone 默认盐）即可 `rclone ls/copy/mount`。测试里与真实 rclone 做了双向互通验证。
- 服务器能看到：目录层级、文件数量、每个文件的（加密后）大小和修改时间。看不到文件名和内容。

**同步**：对每个路径做三方比较——本地当前内容哈希、服务器上的签名（ETag，没有就用大小+修改时间）、上次同步时双方一致的记录（base，每台设备各自保存）。
- 只本地变了 → 上传；只服务器变了 → 下载；一边删了另一边没变 → 同步删除。
- 两边都变了，或第一次同步时两边都有 → 先比较内容（大小相同才下载比对），相同就直接认领，不同才算冲突。
- 冲突：mtime 较新的保留原名，另一份存为 `name (conflict 设备名 时间).md`，两份都不丢。
- 覆盖和删除都带 `If-Match`（上传新文件用 `If-None-Match: *`），别的设备同时改了同一文件时不会被悄悄覆盖，下次同步再处理。

**不做差量**：每个文件整份加密、整份传输（rclone crypt 格式本身没有差量）。笔记文件通常很小，实际影响不大。

**安全措施**：
- **Dry run**：只读服务器列表和本地文件，列出将要上传/下载/删除/冲突的文件，不修改任何东西。
- **防误删**：一次同步要删除 20 个以上且超过 30% 的文件时直接拒绝，需要在设置里手动允许。
- 服务器文件夹是空的而本机有同步历史（指错文件夹）时，不会清空本地，而是重新上传。
- 本插件自己的目录（含密码）、`.git`、`.trash`、`workspace*.json` 永远不同步。

> 旧版本（分块 + 加密索引）使用的服务器格式与现在不兼容。请换一个新的空文件夹，或先清空旧文件夹。
> 加密后的文件名比原名长约 1.7 倍，服务器通常限制单段 255 字节，所以过长的文件名（约 100 个汉字以上）无法上传，会单独报错，不影响其他文件。

## 使用
- 设置里填 URL、账号、远端文件夹、E2EE 密码（所有设备相同，**丢失不可恢复**）。
- 命令：`Sync now`、`Check changes (dry run)`、`Reset local sync state`。
- 可选：启动时同步、定时同步、编辑后 20 秒同步、同步 `.obsidian`、忽略规则（glob）。

## 多设备配对（二维码）
在已配置好的设备（如电脑）上：设置 → “Pair devices with a QR code” → **Show QR**，会显示含 E2EE 密钥（和盐）的二维码（可选是否同时包含 WebDAV 地址/账号/密码/文件夹，2 分钟后自动关闭）。
在手机或平板上：设置 → **Scan QR**，或命令面板 “Pair this device: scan QR code”（扫码入口只在移动端显示，电脑端只有 Show QR）。扫码后会先显示将要应用的内容（密钥不显示明文），确认后保存并开始首次同步。

摄像头在移动端 Obsidian 里不一定可用，所以还提供两种兜底：拍照/选择截图识别，或粘贴 “Copy code” 复制的文本。

> 二维码和配对码里是明文密钥：只给自己的设备看，不要截图外传，粘贴后清空剪贴板。
> 配对最好在手机上的空 Vault 里做；已有同名文件时，首次同步会按冲突规则保留两份。

## 移动端
- 手机/平板没有状态栏：手动同步时用一条常驻通知显示进度，完整列表在侧栏 “Show sync status”。
- 移动端并发降为 2，减轻 CPU、内存和流量压力；界面按触屏加大了点击区域。
- 定时同步只在 Obsidian 前台运行时有效（系统会挂起后台应用），建议开启 “Sync on startup”。

## 已知限制
- WebDAV 服务器需要支持 `PROPFIND`、`MKCOL`、`PUT`、`GET`、`DELETE`，最好支持 ETag / `If-Match`。服务器不返回 ETag 时用“大小+修改时间”判断，精度较差。
- 没有差量传输，大文件改动一点也会整份重传；整个文件读入内存，不适合 GB 级文件。
- 目录结构和文件数量对服务器可见（rclone crypt 的固有特点）。
- 冲突只做整文件保留，不做文本三方合并。重命名按“删除 + 新建”处理。
- 服务器地址、WebDAV 密码、E2EE 密码和盐以明文保存在插件 `data.json` 里（只在本机）。

## 开发
```bash
bun test          # 加密（含与真实 rclone 互通）、配对码、同步引擎（内存 WebDAV 服务器）
bun run dev       # esbuild watch
```
