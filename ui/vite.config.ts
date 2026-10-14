// Quaver UI — Vite 配置（MPA：多页 html 入口，壳层由 src/layout.ts 注入）
// dev/preview：同源 /api 中继 -> sidecar(:3200)，见 src/relay.ts。
// 为什么不用 server.proxy：中继除转发外还要做封面取色代理与流中断收敛；会话凭证只被
// Electron 主进程持有（系统密钥管理器加密，磁盘上只有密文），浏览器侧全程拿不到。
// 桌面壳（Electron/QtWebEngine/Tauri）后续直接加载 dist/ 或 preview 服务即可。
import { defineConfig, type Connect, type PreviewServer, type ViteDevServer } from "vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiRelay } from "./src/relay.ts";

// 关于页版本号：CI 显式指定 > 最近 git tag（如 v0.1.1）> package.json version。
// 为什么要有 CI 这一路：CI 是浅克隆，`git describe` 拿不到 tag，而 electron-builder 的
// 版本号是 CI 另外传的（tag 发布 / 每夜版带 commit id）—— 不给注入口的话，
// 「关于」页会一直显示 package.json 里的 0.0.1，和产物文件名对不上。
// describe 必须钉 --match "v*"：滚动 Release 的 tag 名就叫 nightly，且永远比最新版 tag 新，
// 不排除的话本地构建的 __APP_VERSION__ 会是裸字符串 "nightly" —— 不是合法 semver，
// Sparkle 的 minHostVersion 门对所有声明最低版本的插件一律误拒。
function appVersion(): string {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const explicit = process.env.QUAVER_VERSION?.trim();
  if (explicit) return explicit;
  try {
    return execSync('git describe --tags --abbrev=0 --match "v*"', { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "v" + (JSON.parse(readFileSync(root + "package.json", "utf8")).version as string);
  }
}

// desktop-lyrics 是真页面（透明覆盖层独立入口），其余旧 <name>.html 只是 SPA 深链跳转壳
const PAGES = ["index", "guess", "daily", "liked", "playlist", "user", "settings", "login", "desktop-lyrics"];

function attachRelay(server: ViteDevServer | PreviewServer) {
  (server.middlewares as Connect.Server).use("/api", apiRelay());
}

export default defineConfig({
  // 项目根钉死在本文件所在目录（= ui/）。vite 的 root **默认取 process.cwd()**，而开发态的
  // preview 是主进程用程序化 API 起的（electron/main.ts），进程 cwd 未必是 ui/：从启动器里
  // 点 linux-desktop 写的桌面项时 cwd 是 $HOME，root 跟着 cwd 走 → preview 去服务
  // <cwd>/dist（不存在）→ 窗口拿到 404 白页，表现就是「applications 里那个 Desktop 点不开」。
  // 绝对 root 让 vite dev/build/preview 全部与 cwd 无关，进程在哪儿起都对。
  root: fileURLToPath(new URL(".", import.meta.url)),
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  resolve: {
    // 歌词引擎（AMLL）是宿主内置功能（src/lyrics），依赖由 ui 自己声明；保留 dedupe：
    // vendor/Sparkle 里的第三方插件/主题也可能 import 它，双实例会让 core 的样式与状态打架
    dedupe: ["@applemusic-like-lyrics/core", "@applemusic-like-lyrics/lyric"],
    alias: [
      // Sparkle 插件系统 SDK（git submodule vendor/Sparkle，源码级打进 dist，见 quaver-sparkle/README）
      // 顺序要紧：子路径的正则必须在前 —— 字符串 "@quaver/sparkle" 会前缀命中 "@quaver/sparkle/xxx"。
      { find: /^@quaver\/sparkle\//, replacement: fileURLToPath(new URL("../vendor/Sparkle/", import.meta.url)) },
      { find: "@quaver/sparkle", replacement: fileURLToPath(new URL("../vendor/Sparkle/sdk/index.ts", import.meta.url)) },
    ],
  },
  server: {
    fs: {
      // dev 态放行 ui 之外的 submodule 源码（vendor/Sparkle）
      allow: [fileURLToPath(new URL("..", import.meta.url))],
    },
  },
  build: {
    rollupOptions: {
      input: Object.fromEntries(
        PAGES.map((p) => [p, fileURLToPath(new URL(`./${p}.html`, import.meta.url))]),
      ),
    },
  },
  plugins: [
    {
      name: "quaver-api-relay",
      configureServer: attachRelay,
      configurePreviewServer: attachRelay,
    },
  ],
});
