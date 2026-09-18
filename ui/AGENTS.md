## Development

Vite SPA（无框架，hash 路由）。启动 dev server 用后台模式：

```sh
npm run dev -- --port 5173 --strictPort --host 127.0.0.1
```

健康检查：`curl -s http://127.0.0.1:5173/index.html | head -5` 应返回 HTML；
`curl -s http://127.0.0.1:5173/api/login/status` 验证中继（需 sidecar :3200 在跑，
否则返回 502 JSON 也算中继活着）。

## Conventions

- SPA 壳层（`src/main.ts` → `src/shell.ts:bootShell`）：标题栏 / 侧栏 / 播放条 /
  正在播放页 / 队列面板常驻，`#route` 按 hash 切视图（`src/views.ts:views`）。
  新视图 = `views` 加路由 + 渲染函数；根目录 `*.html` 只是旧深链的薄跳转层。
- 界面语言 = Verse（`src/verse/`，详见其 README）：`verse-tokens.css` 与
  `verse-components.css` 原样 vendor 不许手改；新增样式进 `verse-app.css` 且只许用
  `var()`。accent 只标记正在播放；分隔用线不用块；数字一律等宽 `mm:ss`。
- `/api/*` 由 `src/relay.ts`（vite 插件中间件，dev 与 preview 都挂）转发 sidecar :3200 —— 纯透传 +
  封面代理；会话凭证只存在本机配置目录（Linux `~/.config/quaver-music/credential.json`，0600），
  不进浏览器。

## 配置持久化（quaver.conf）

真相在 `electron/config.mjs`：平台路径规则、INI 解析（保注释）、schema 默认值与值域、原子落盘。
渲染层经 `src/lib/config.ts` 读写（桌面端过 preload 的 `quaverConfig` 桥，浏览器 dev 回落 localStorage）。

- 目录：Linux `~/.config/quaver-music`｜Windows `%AppData%\Quaver Music`｜macOS `Application Support/Quaver Music`；
  `QUAVER_CONFIG_DIR` 可整体顶掉（主进程也用它下发给 sidecar，两边规则必须一致：
  `ui/electron/config.mjs:configDir` ↔ `vendor/Typhoeus/quaver_server/session.py:_config_dir`）。
- 加新设置项：改 `electron/config.mjs` 的 `SCHEMA` + `src/lib/config.ts` 的 `FALLBACK`
  + `src/lib/prefs.ts` 的类型化 getter/setter（三处都要动）。
- 字体两项是 **CSS font-family 列表**（空串 = 不覆盖，合法）。写入统一走 `setUiFontList` /
  `setLyricFontList`（逐字符输入 → `cfgSetSoon` 合并 400ms）。设置页 = 预设下拉 + 可直编输入框，
  两边靠 `fontKeyOf` 反向匹配同步；`fontCssOf` 负责把 `sans` 这类预设名简写展开成族列表
  （直接塞进 CSS 变量是无效声明）。`normalizeFontList` 是前端清洗（allowlist，比后端更严）。
- 打包态页面跑在**固定端口**（`main.mjs:STABLE_PORT`）：origin 稳定，Chromium 的
  localStorage/IndexedDB/Cache 才能跨启动延续；端口被占时 native-server 自动回落随机端口。
- `app.setPath("userData")` 钉在配置目录，必须在任何 `app.getPath("userData")` 之前执行。
- 页内导航一律 hash 路由（`#/playlist?id=…`）；根目录 `.html` 薄跳转层只给旧外链保留。
- dev 钩子：`import.meta.env.DEV` 下 `window.__player` 即播放器实例（生产构建不含）。

## Documentation

Vite guide: https://vite.dev/guide/
- Static sites / MPA: https://vite.dev/guide/static-deploy
- Backend for /api middleware: https://vite.dev/guide/backend-integration
- Proxy & server options: https://vite.dev/config/server-options
