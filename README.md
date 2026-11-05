# WebDAV E2EE Sync（Obsidian 插件）

通过 WebDAV 同步 Vault，端到端加密，块级差量同步。支持桌面端与移动端。

## 安装

```bash
bun install && bun run build   # 生成 main.js（需要 Bun）
```

把 `main.js`、`manifest.json`、`styles.css` 复制到 `<vault>/.obsidian/plugins/webdav-e2ee-sync/`，然后在 Obsidian 里启用。

## 设计

**差量同步**：文件用 FastCDC（内容定义分块，gear 滚动哈希 + 归一化切分，平均 64 KB）切块。每个块按内容寻址存储。
- 上传：只传远端索引里还没有的块。
- 下载：只拉本地缺失的块（本地旧版本的块会被复用）。
- 在文件中间插入内容时，后面的块边界不变，因此不会整文件重传。
- 相同内容的块在文件间自动去重。

**E2EE**：
- 密钥：PBKDF2-SHA256（60 万次迭代，随机盐）派生出 512 bit，一半做 AES-256-GCM 密钥，一半做 HMAC 密钥。
- 加密范围：块内容和文件索引都用 AES-GCM 加密，AAD 绑定块 id / 角色，防止服务器替换或调换数据。
- 块 id 是 `HMAC-SHA256(key, 内容)`，服务器无法由 id 反推内容哈希。
- 文件名、目录结构、大小、mtime 只存在加密索引里。服务器只能看到不透明的块和块数量/大小。
- 取舍：相同内容会得到相同 id，所以服务器能看出两个块相同（收敛加密的固有特性）。

**远端目录布局**：`meta.json`（明文：盐、迭代次数、密码校验块）、`index.bin`（加密索引）、`chunks/xx/<id>`。

**冲突与安全**：
- 三方比较（本地 / 远端索引 / 上次同步的 base）。
- 索引用 ETag + `If-Match` 做乐观并发，多设备同时同步时会自动重试。
- 两端同时修改同一文件：mtime 较新的保留原路径，较旧的另存为 `name (conflict 设备名 时间).md`。
- 一边删除、另一边修改：保留修改。
- 远端索引缺失（例如指到空文件夹）时不会清空本地，而是重新上传。
- 每个文件下载后都校验 SHA-256；删除本地文件时遵循 Obsidian 的回收设置。
- 本插件自己的目录（含密码）、`.git`、`.trash`、`workspace*.json` 永远不同步。

## 使用
- 设置里填 URL、账号、远端文件夹、E2EE 密码（所有设备相同，**丢失不可恢复**）。
- 命令：`Sync now`、`Delete unused remote chunks`（清理孤儿块，建议其它设备空闲时运行）、`Reset local sync state`。
- 可选：启动时同步、定时同步、编辑后 20 秒同步、同步 `.obsidian`、忽略规则（glob）。

## 已知限制
- WebDAV 服务器需要支持 `PROPFIND`、`MKCOL`、`PUT`、`GET`，并建议支持 ETag / `If-Match`（Nextcloud、ownCloud、Apache mod_dav、Synology、坚果云等基本都支持）。服务器不返回 ETag 时，多设备同时写索引无法被检测。
- 冲突只做整文件保留，不做文本三方合并。
- 整个文件读入内存，不适合 GB 级大文件。
- 服务器地址、WebDAV 密码、E2EE 密码以明文保存在插件 `data.json` 里（只在本机）。

## 开发
```bash
bun test          # 分块、加密、同步引擎（内存 WebDAV 服务器）
bun run dev       # esbuild watch
```
