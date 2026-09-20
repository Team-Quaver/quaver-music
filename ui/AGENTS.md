## Development

Vite MPA（无框架）。启动 dev server 用后台模式：

```sh
npm run dev -- --port 5173 --strictPort --host 127.0.0.1
```

健康检查：`curl -s http://127.0.0.1:5173/index.html | head -5` 应返回 HTML；
`curl -s http://127.0.0.1:5173/api/login/status` 验证中继（需 sidecar :3200 在跑，
否则返回 502 JSON 也算中继活着）。

## Conventions

- 页面 = 根目录 `<name>.html` + `src/entries/<name>.ts`；新页面要同时加进
  `vite.config.ts` 的 `PAGES`。
- 页面脚本第一行必须 `mountLayout("标题")`（注入顶栏/侧栏/播放条并搬运 `.page` 内容），
  之后才可查询页面 DOM。
- `/api/*` 由 `src/relay.ts`（vite 插件中间件，dev 与 preview 都挂）转发 sidecar :3200 —— 纯透传 +
  封面取色代理；凭证只在主进程与 sidecar 之间流转（**永不进渲染层、也永不落明文**，见下节）。

## 凭证存储（系统密钥管理器）

真相在 `electron/keyring.mjs`（零依赖、不 import electron，可单测）。三条硬约束：

- **`--password-store` 必须在 `app ready` 之前钉死**（`main.mjs` 顶层 `appendSwitch`）：Chromium
  只在初始化时读一次，ready 之后再改是空操作。自定义合成器（Hyprland/sway）不在 Chromium 的桌面
  白名单里 → 不显式钉就会静默退到 `basic_text`（硬编码口令的假加密，而 `isEncryptionAvailable()`
  仍然返回 true）。探测顺序：桌面名 → `/proc` 里的守护进程 → 钱包/keyrings 目录 → 保守试 Secret Service。
  探测只负责**选开关**，真正算数的是 ready 之后的 `getSelectedStorageBackend()` 校验。
- **凭证归属在 Electron 主进程**（打包态）。main 把已存凭证写进 sidecar 的 stdin（`QCRED1 {json}` /
  `QCRED1 null` 一行），sidecar 登录/刷新/登出时从 stdout 交回同一格式 → main 加密落盘。
  前缀常量两侧必须逐字一致：`ui/electron/keyring.mjs:HANDOFF_PREFIX` ↔
  `vendor/Typhoeus/quaver_server/session.py:HANDOFF_PREFIX`（含末尾空格，verify:keyring 会比对）。
  sidecar 侧只在 `QUAVER_CREDENTIAL_MODE=external` 下启用（stdin 阻塞读、save/clear 改交接）；
  不设该变量（手工单跑）= memory 模式，什么都不落盘。
- **日志卫生**：sidecar 的 stdout 是混着的 —— 必须**先按行切**（`drainLines`）**再判前缀**，
  凭证行走 `applySidecarCredential`，其余才 `log()`。日志文件里凭证一个字符都不许出现
  （`credentialSummary` 只报 musicid 与字段长度）。同理绝不用 stderr 传凭证。

三级降级与边界：`keyring` → **`memory`（只驻内存，绝不退明文）**。`CredentialStore` 值域里没有
`file`，源码里也没有任何写出明文的路径（`verify:keyring` 有源码级护栏）。解不开的 `credential.enc`
**不删**（可能只是这次没拿到钥匙）；遗留明文**回读校验通过才删**，且只在明文比存档新时才导入
（更旧的残留不许顶掉新登录态）。设备指纹 `device.json` 不是密钥，保持明文。

**开发态也走同一条交接通道**（踩过一次）：`npm run app` 时主进程自己拉起
`vendor/Typhoeus/run.py`（优先 `.venv/bin/python`，退回 `uv run`），必须在 vite 加载**之前**拉
（`relay.ts` 在模块加载时读一次 `QUAVER_API`）。手工起的 sidecar 拿不到交接管道 → 只能 memory 模式，
所以**不要再手工起 sidecar 并期望登录被持久化** —— 环境里已有 `QUAVER_API` 时主进程不抢，并在日志里说明。
打包态与开发态的启动方式只在 `sidecarCommand()` 一处分叉，凭证通道完全一致。

## 配置持久化（quaver.conf）

真相在 `electron/config.mjs`：平台路径规则、INI 解析（保注释）、schema 默认值与值域、原子落盘。
渲染层经 `src/lib/config.ts` 读写（桌面端过 preload 的 `quaverConfig` 桥，浏览器 dev 回落 localStorage）。

- 目录：Linux `~/.config/quaver-music`｜Windows `%AppData%\Quaver Music`｜macOS `Application Support/Quaver Music`；
  `QUAVER_CONFIG_DIR` 可整体顶掉（主进程也用它下发给 sidecar，两边规则必须一致：
  `ui/electron/config.mjs:configDir` ↔ `vendor/Typhoeus/quaver_server/session.py:_config_dir`）。
- 加新设置项：改 `electron/config.mjs` 的 `SCHEMA` + `src/lib/config.ts` 的 `FALLBACK`
  + `src/lib/prefs.ts` 的类型化 getter/setter（三处都要动）。**例外**：只有主进程消费的项
  （`[Security]` 三项）只需前两处，渲染层不加 getter。
- 字体两项是 **CSS font-family 列表**（空串 = 不覆盖，合法）。写入统一走 `setUiFontList` /
  `setLyricFontList`（逐字符输入 → `cfgSetSoon` 合并 400ms）。设置页 = 预设下拉 + 可直编输入框，
  两边靠 `fontKeyOf` 反向匹配同步；`fontCssOf` 负责把 `sans` 这类预设名简写展开成族列表
  （直接塞进 CSS 变量是无效声明）。`normalizeFontList` 是前端清洗（allowlist，比后端更严）。
- 打包态页面跑在**固定端口**（`main.mjs:STABLE_PORT`）：origin 稳定，Chromium 的
  localStorage/IndexedDB/Cache 才能跨启动延续；端口被占时 native-server 自动回落随机端口。
- `app.setPath("userData")` 钉在配置目录，必须在任何 `app.getPath("userData")` 之前执行。
- 跨页导航一律 `.html` 后缀绝对路径（Vite dev 对 `/foo.html` 与 `/foo` 都可解析；
  壳层直接加载 dist 文件时只有 `.html` 形式可用）。
- 播放全局对象 `window.QuaverPlayer` 由 `PlayerBar()` 挂载。

## 「跟随系统」深浅色（Linux 特有的坑）

渲染层只认 `matchMedia("(prefers-color-scheme: dark)")`（`src/lib/prefs.ts`），但**这个值由谁决定
是平台相关的**：Linux 上 Chromium 只按 GTK 设置判（`gtk-theme-name` 含 dark /
`gtk-application-prefer-dark-theme=true`），而 KDE 下那份 GTK 设置是 kde-gtk-config 写的
**静态快照**，不跟 KDE 配色方案联动 —— 实测 `kdeglobals` 的配色在 `noctalia` ⇄ `BreezeLight`
之间来回切，`~/.config/gtk-{3,4}.0/settings.ini` 里始终是 `adw-gtk3`（浅），于是「跟随系统」
永远是浅色。

所以这件事由**主进程**兜（`electron/systheme.mjs`）：

- 探测真相：KDE 会话读 `kdeglobals` 的 `[Colors:Window] BackgroundNormal` 按亮度判（不猜方案名，
  「BreezeLight」「noctalia」这类名字没法可靠分类）；其他桌面读 GTK settings.ini 兜底；
  都拿不到返回 `null`，交回 Electron 自己判。
- `nativeTheme.themeSource` 只有 system/light/dark 三档，跟随系统时写成**探测到的** dark/light ——
  Electron 会把它同步给渲染进程的 `prefers-color-scheme`，**渲染层零改动**。
- 变化监听用 `fs.watchFile`（stat 轮询，1.5s）而不是 `fs.watch`：KDE 走 KConfig 重写文件，
  inode 会换，`fs.watch` 会跟丢。也别用 `nativeTheme` 的 `updated` 事件 —— themeSource 写死之后
  它不会再来，盯文件才是真来源。
- 主题偏好经 `quaver:config` 的 `set` 落盘时同步进主进程（`themePref`），`reset` 也要同步，
  否则切回明/暗固定档后还挂着探测值。
- 单测：`node scripts/verify-systheme.mjs`（INI 解析 / 亮度判据 / 来源优先级 / 变化监听，真文件真解析）。

## Documentation

Vite guide: https://vite.dev/guide/
- Static sites / MPA: https://vite.dev/guide/static-deploy
- Backend for /api middleware: https://vite.dev/guide/backend-integration
- Proxy & server options: https://vite.dev/config/server-options
