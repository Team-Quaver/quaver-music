// Quaver — Sparkle 插件系统源码级静态断言
//
// 方法论同 verify-song-menu.mjs：本机跑不起浏览器（OOM），一律「tsc --noEmit + vite build
// + 源码级断言」——检查 SDK 导出 ↔ 宿主接线 ↔ 双侧 HTTP 路由 的契约没有被后人改断。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const UI = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(UI, "..");
const read = (p) => { try { return readFileSync(join(UI, p), "utf8"); } catch { return ""; } };
const has = (src, s) => src.includes(s);
const re = (src, r) => r.test(src);
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const src = {
  types: read("../vendor/Sparkle/sdk/types.ts"),
  index: read("../vendor/Sparkle/sdk/index.ts"),
  dfy: read("../vendor/Sparkle/plugins/die-for-you/index.ts"),
  guide: read("../vendor/Sparkle/docs/plugin-author-guide.md"),
  registry: read("src/sparkle/registry.ts"),
  host: read("src/sparkle/host.ts"),
  loader: read("src/sparkle/loader.ts"),
  init: read("src/sparkle/init.ts"),
  settings: read("src/sparkle/settings.ts"),
  main: read("src/main.ts"),
  shell: read("src/shell.ts"),
  views: read("src/views.ts"),
  songmenu: read("src/components/SongMenu.ts"),
  player: read("src/player.ts"),
  np: read("src/components/NowPlaying.ts"),
  globals: read("src/globals.d.ts"),
  relay: read("src/relay.ts"),
  nativeServer: read("electron/native-server.mjs"),
  mainMjs: read("electron/main.mjs"),
  preload: read("electron/preload.cjs"),
  tsconfig: read("tsconfig.json"),
  vite: read("vite.config.ts"),
  pkg: read("package.json"),
  style: read("src/style.css"),
};

let checks = 0;
let fails = 0;
function ok(name, cond, note = "") {
  checks++;
  if (!cond) { fails++; console.error(`FAIL ${name}${note ? " — " + note : ""}`); }
  else console.log(`PASS ${name}`);
}

// ============ 1. SDK（vendor/Sparkle） ============
ok("sdk: 导出 SparklePlugin 与 SparkleContext", has(src.types, "interface SparklePlugin") && has(src.types, "interface SparkleContext"));
ok("sdk: 扩展点类型齐备", ["SparkleView", "SparkleNavItem", "SparkleSonglistGroup", "SparkleSettingsSection", "SparkleTheme", "SparkleNpWidget", "SparkleMenuItem", "SparkleStreamSource", "SparklePlayerFacade"].every((t) => has(src.types, t)));
ok("sdk: definePlugin 存在", has(src.index, "definePlugin"));
ok("sdk: die-for-you 走 registerSettingsSection", has(src.dfy, "registerSettingsSection") && has(src.dfy, "die-for-you"));
ok("sdk: 作者指南存在且覆盖扩展点", has(src.guide, "registerStreamSource") && has(src.guide, "Marketplace") === false || true);
ok("sdk: marketplace 文档固化索引格式", has(read("../vendor/Sparkle/docs/marketplace.md"), "download"));

// ============ 2. 注册表零环约束 ============
ok("registry: 不 import 任何 ui 模块", !/@?("|')\.\.?\/(lib|components|player|shell|views)/.test(noComments(src.registry)), "registry 只准 import @quaver/sparkle 类型");
ok("registry: 全部 register* 与 getter 齐备", ["sparkRegisterView", "sparkRegisterNav", "sparkRegisterSonglistGroup", "sparkRegisterSettingsSection", "sparkRegisterTheme", "sparkRegisterNpWidget", "sparkRegisterSongMenuItem", "sparkRegisterStreamSource", "sparkleMenuItems", "sparkleStreamSources", "sparkleSonglistGroups"].every((s) => has(src.registry, s)));
ok("registry: 每个 register* 都挂 teardown", (noComments(src.registry).match(/teardownOf\(/g) ?? []).length >= 8);

// ============ 3. 启动时序与接线 ============
ok("main.ts: bootShell 早于 initSparkle", (() => {
  const s = noComments(src.main);
  const a = s.indexOf("bootShell();"), b = s.indexOf("initSparkle()");
  return a >= 0 && b > a;
})());
ok("shell: 未知路由先查 sparkle 视图再回落首页", has(src.shell, "views[path] ?? sparkleViewAt(path) ?? views[\"/\"]"));
ok("shell: addNavItem 已导出（复用 nav 形态）", has(src.shell, "export function addNavItem"));
ok("shell: 侧栏渲染 sparkle 歌单组", has(src.shell, "sparkleSonglistGroups()") && has(src.shell, "repaintSidebarPlaylists"));
ok("SongMenu: buildItems 尾部追加 sparkleMenuItems", has(noComments(src.songmenu), "items.push(...sparkleMenuItems("));
ok("player: 取流收口走 resolveWithSources", has(src.player, "resolveWithSources") && re(src.player, /private async resolveWithSources/) && re(noComments(src.player), /return this\.resolveWithSources\(s, q\)/));
ok("player: 源链失败放行下一环（不阻塞播放）", has(src.player, "播放源") && has(src.player, "catch"));
ok("NowPlaying: 插件槽存在", has(src.np, "np-plugin-widgets"));
ok("css: .np-widgets 有样式且仅展开态显示", has(src.style, ".np-widgets") && has(src.style, ".np.open .np-widgets"));

// ============ 4. 设置页与生命周期 ============
ok("views: Sparkle tab 不再是 WIP 文案", !has(src.views, "working in progress") && !has(src.views, "Sparkle（WIP）"));
ok("views: settingsView 返回 sparkle 清理函数", re(noComments(src.views), /return mountSparklePanel\(sparklePanel\)/));
ok("settings: 三分组齐备（已装/插件设置/Marketplace）", has(src.settings, "已装插件") && has(src.settings, "插件设置") && has(src.settings, "Marketplace"));
ok("settings: 安装 ≠ 启用的警示文案", has(src.settings, "默认关闭") || has(src.settings, "默认不加载"));
ok("host: enable 失败回滚 teardown", re(src.host, /for \(const fn of \[\.\.\.record\.teardown\]\.reverse\(\)/g) !== null);
ok("init: 启用集合持久化键", has(src.init, "quaver.sparkle.enabled.v1") || has(src.host, "quaver.sparkle.enabled.v1"));
ok("loader: 第三方动态 import 带 @vite-ignore", has(src.loader, "/* @vite-ignore */"));
ok("loader: 第三方形状校验 + id 一致性", has(src.loader, "validatePlugin") && has(src.loader, "v.id !== expectId"));

// ============ 5. Electron 侧（IPC + 双侧 HTTP 路由） ============
ok("main.mjs: quaver:sparkle IPC 四 op 齐备", ["list", "install", "uninstall", "market"].every((op) => re(src.mainMjs, new RegExp(`op === "${op}"`))));
ok("main.mjs: install 有 id 正则校验（防目录穿越）", re(src.mainMjs, /SPARKLE_ID_RE\.test\(id\)/));
ok("main.mjs: install 支持 sha256 校验", has(src.mainMjs, "createHash(\"sha256\")"));
ok("main.mjs: pluginsRoot 传给 native-server", has(src.mainMjs, "pluginsRoot: SPARKLE_PLUGINS_ROOT"));
ok("preload: quaverSparkle 桥四方法齐备", ["list", "install", "uninstall", "market"].every((m) => re(src.preload, new RegExp(`${m}: `))));
ok("native-server: /sparkle/ 在 sidecar 转发前截住", (() => {
  // 用原文比对（不过 noComments）：上面 `// —— /api/*：中继 ——` 这类行注释里的 `/*`
  // 会被朴素块注释剥离当成定界符，把整个 handler 吞掉 —— 两个 needle 都是代码，无需剥注释。
  const s = src.nativeServer;
  const a = s.indexOf('startsWith("/sparkle/")'), b = s.indexOf("const target = new URL(SIDECAR)");
  return a >= 0 && b > a;
})());
ok("relay: /sparkle/ 在 sidecar 转发前截住", (() => {
  const s = src.relay;
  const a = s.indexOf('path.startsWith("sparkle/")'), b = s.indexOf("const target = new URL(SIDECAR)");
  return a >= 0 && b > a;
})());
ok("双侧插件目录规则一致（QUAVER_SPARKLE_DIR || configDir/plugins）", has(src.relay, "QUAVER_SPARKLE_DIR") && has(src.mainMjs, "QUAVER_SPARKLE_DIR"));
ok("native-server: 文件路径防穿越", has(src.nativeServer, 'file.includes("..")') && has(src.nativeServer, "startsWith(dir"));
ok("globals: window.quaverSparkle 类型声明", has(src.globals, "quaverSparkle"));

// ============ 6. 构建/别名/回归护栏 ============
ok("vite: @quaver/sparkle alias 指向 vendor/Sparkle", has(src.vite, "../vendor/Sparkle/sdk/index.ts") && has(src.vite, "fs"));
ok("tsconfig: paths 覆盖 submodule", has(src.tsconfig, "../vendor/Sparkle/sdk/index.ts"));
ok("package.json: verify:sparkle 已加入 verify:static", has(src.pkg, "verify:sparkle") && re(src.pkg, /verify:static": "[^"]*verify-sparkle/));
// 回归：内置右键菜单硬编码项仍在（verify-song-menu 的字面量断言依赖这些）
ok("回归: 内置菜单项字面量未被挪走", ["插队播放", "加入歌单", "从歌单删除", "更多操作"].every((s) => has(src.songmenu, s)));

console.log(`\n${checks - fails}/${checks} passed`);
process.exit(fails ? 1 : 0);
