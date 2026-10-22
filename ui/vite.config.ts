// Quaver UI — Vite 配置（MPA：多页 html 入口，壳层由 src/layout.ts 注入）
// dev/preview：同源 /api 中继 -> sidecar(:3200)，见 src/relay.ts。
// 为什么不用 server.proxy：中继除转发外还要做封面取色代理与流中断收敛；会话凭证只被
// Electron 主进程持有（系统密钥管理器加密，磁盘上只有密文），浏览器侧全程拿不到。
// 桌面壳（Electron/QtWebEngine/Tauri）后续直接加载 dist/ 或 preview 服务即可。
import { defineConfig, type Connect, type PreviewServer, type ViteDevServer } from "vite";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
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
const PAGES = ["index", "guess", "daily", "liked", "playlist", "playlists", "user", "settings", "login", "desktop-lyrics"];

function attachRelay(server: ViteDevServer | PreviewServer) {
  (server.middlewares as Connect.Server).use("/api", apiRelay());
}

// —— 构建图导出（dist/.vite/chunk-graph.json）——
// 清单（manifest）只说「谁静态引谁」；这份图额外说「每块里装了哪些模块、各占多少字节」。
// 有了它，verify-bundle.ts 能钉住「设置页不在首屏」「词典不在首屏」「AMLL 仍按需求」这类
// **形状**断言，而不是只盯着总大小看数字（总大小会随依赖漂移，形状不会）。
function chunkGraphPlugin() {
  let outDir = "dist";

  return {
    name: "quaver-chunk-graph",
    apply: "build",
    configResolved(cfg: any) { outDir = resolve(cfg.root ?? ".", cfg.build?.outDir ?? "dist"); },
    writeBundle(_opts: any, bundle: any) {
      const graph: Record<string, unknown> = {};

      for (const [file, item] of Object.entries<any>(bundle)) {
        if (item.type !== "chunk") continue;

        const mods = Object.entries<any>(item.modules ?? {})
          .map(([id, m]) => ({ id, bytes: m.renderedLength ?? 0 }))
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 60);

        graph[file] = {
          kind: item.isEntry ? "entry" : item.isDynamicEntry ? "dynamic" : "shared",
          bytes: Buffer.byteLength(item.code ?? "", "utf8"),
          modules: mods,
        };
      }

      mkdirSync(join(outDir, ".vite"), { recursive: true });
      writeFileSync(join(outDir, ".vite", "chunk-graph.json"), JSON.stringify(graph, null, 1));
    },
  };
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
    // 构建清单常开（dist/.vite/manifest.json）：入口静态闭包与懒加载边界的唯一机器可读来源，
    // verify-bundle.ts 与 probe-bundle.ts 都靠它 —— 不能指望谁跑构建时都记得加 --manifest。
    manifest: true,
    // —— Rolldown（Vite 8 的内核；`rollupOptions` 只是别名，已 deprecated）——
    // 形状约定：入口只有两个真页面（index = SPA 壳，desktop-lyrics = 覆盖层），其余 <name>.html
    // 是薄跳转壳。首屏预算由 scripts/verify-bundle.ts 按「入口的静态闭包」把关，
    // 所以这里的分组只服务两件事：给重量级第三方懒加载块**稳定可断言的名字**，
    // 以及让循环依赖在构建期就报出来（分组名固定 = 预算断言不用跟着 hash 漂）。
    rolldownOptions: {
      input: Object.fromEntries(
        PAGES.map((p) => [p, fileURLToPath(new URL(`./${p}.html`, import.meta.url))]),
      ),
      checks: {
        // 环依赖既撑大包也可能引出执行顺序问题：构建期直接报，别等运行时「undefined is not a function」
        circularDependency: true,
      },
      output: {
        codeSplitting: {
          groups: [
            // 歌词引擎（AMLL core + 逐字解析）：宿主内置能力，但只在要渲染逐字时按需拉
            { name: "amll", test: /node_modules[\\/]@applemusic-like-lyrics[\\/]/, priority: 30 },
            // 繁简词典：纯数据（简→繁 ~1MB / 繁→简 ~110KB），只有选了那一档且歌词里真有汉字才拉
            { name: "cjk-cn2t", test: /opencc-js[\\/]dist[\\/]esm[\\/]cn2t\.js/, priority: 30 },
            { name: "cjk-t2cn", test: /opencc-js[\\/]dist[\\/]esm[\\/]t2cn\.js/, priority: 30 },
            // 预装 Sparkle 插件**不**分组：每个插件本来就是一条独立的动态 import，
            // 自动分组按模块名切块（die-for-you-xxx.js）；写组反而会把它们并进一块，
            // 装一个插件就把所有插件的字节一起拉走。
          ],
        },
      },
    },
    // Electron 44 = Chromium 1xx，原生支持 modulepreload：那份 polyfill（探测 relList +
    // MutationObserver）是写给老浏览器与「非模块脚本兜底」的，在本应用里永远是死代码。
    modulePreload: { polyfill: false },
    // 产物的唯一运行时是随附的 Electron（Chromium 与 Electron 一起升），没有「兼容老引擎」这个
    // 约束：写死 chromeNN 只会在 Electron 升级后悄悄过时，往下多打一层语法税。
    // 渲染层源码该不该用某语法由 tsconfig 的 target/lib 说话（那里仍是 ES2022 口径）。
    target: "esnext",
    // 词典块（~1.05MB）是这份构建里唯一超过 500kB 的 chunk，且它是**懒加载纯数据**。
    // 把上限抬到刚好放过它，是为了让 Rolldown 那条警告继续有意义 —— 真正的红线
    // （首屏静态闭包 ≤ 预算、除词典外无大 chunk、词典必须不在首屏）在 verify-bundle.ts 里。
    chunkSizeWarningLimit: 1100,
    // gzip 体积对本应用没有决策价值（产物从磁盘/asar 读，不走传输编码），只拖慢构建
    reportCompressedSize: false,
    // 发布产物不带 sourcemap：多几百 KB 的磁盘与内存映射，而崩溃栈由 Crotchet 日志兜
    sourcemap: false,
  },
  plugins: [
    chunkGraphPlugin(),
    {
      name: "quaver-api-relay",
      configureServer: attachRelay,
      configurePreviewServer: attachRelay,
    },
  ],
});
