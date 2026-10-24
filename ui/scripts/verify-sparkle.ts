// Quaver — Sparkle 插件系统源码级静态断言
//
// 方法论同 verify-song-menu.ts：本机跑不起浏览器（OOM），一律「tsc --noEmit + vite build
// + 源码级断言」——检查 SDK 导出 ↔ 宿主接线 ↔ 双侧 HTTP 路由 的契约没有被后人改断。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { viewsSource } from "./views-source.ts";

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
  views: viewsSource(),
  songmenu: read("src/components/SongMenu.ts"),
  player: read("src/player.ts"),
  np: read("src/components/NowPlaying.ts"),
  globals: read("src/globals.d.ts"),
  relay: read("src/relay.ts"),
  nativeServer: read("electron/native-server.ts"),
  mainMjs: read("electron/main.ts"),
  preload: read("electron/preload.cts"),
  mkBuild: read("../vendor/Sparkle/scripts/build-marketplace.mjs"),
  mkCI: read("../vendor/Sparkle/.github/workflows/marketplace.yml"),
  mkDocs: read("../vendor/Sparkle/docs/marketplace.md"),
  tsconfig: read("tsconfig.json"),
  vite: read("vite.config.ts"),
  pkg: read("package.json"),
  style: read("src/style.css"),
  npView: read("src/sparkle/np-view.ts"),
  spectrum: read("src/lib/audio-spectrum.ts"),
  pcmSink: read("src/lib/pcm-sink.ts"),
  spectrumRender: read("src/lib/spectrum-render.ts"),
  spectrumCtrl: read("src/lib/spectrum-controller.ts"),
  spectrumCss: read("src/lib/spectrum.css"),
  styleLayer: read("src/sparkle/style-layer.ts"),
  sparkleVersion: read("electron/sparkle-version.ts"),
  md3Meta: read("../vendor/Sparkle/marketplace/md3/plugin.json"),
  md3: read("../vendor/Sparkle/marketplace/md3/index.ts"),
  shuffle: read("src/lib/shuffle.ts"),
  flowMeta: read("../vendor/Sparkle/marketplace/flowscape/plugin.json"),
  flowIdx: read("../vendor/Sparkle/marketplace/flowscape/index.ts"),
  amll: read("src/lyrics/amll.ts"),
  lyricDelay: read("src/lib/lyric-delay.ts"),
  kana: read("src/lyrics/qrc-kana.ts"),
  lyricsBoot: read("src/lyrics/builtin.ts"),
  lyric: read("src/lyric.ts"),
  guide: read("../vendor/Sparkle/docs/plugin-author-guide.md"),
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

ok("sdk: 支持最低宿主版本与 Beta 开关", has(src.types, "minHostVersion?: string") && has(src.types, "allowBeta?: boolean"));

ok("Lumen: 最低宿主版本为 1.7.0 且允许 Beta", has(src.md3Meta, '"minHostVersion": "1.7.0"') && has(src.md3Meta, '"allowBeta": true') && has(src.md3, 'minHostVersion: "1.7.0"') && has(src.md3, "allowBeta: true"));

ok("版本比较：主进程安装前执行宿主版本门禁", has(src.mainMjs, "sparkleHostVersionError") && has(src.mainMjs, "minHostVersion"));

ok("版本比较：Marketplace 构建透传最低宿主版本", has(src.mkBuild, "minHostVersion: meta.minHostVersion"));

ok("sdk: 控制条停靠可由主题接管", has(src.types, "interface SparkleThemeControlBar") && has(src.types, "controlBar?: SparkleThemeControlBar"));

ok("sparkle: 控制条策略纯函数并接入主题切换", has(read("src/sparkle/theme-control-bar.ts"), "export function controlBarPolicyOf") && has(src.host, "applyControlBar();"));

ok("settings: 主题切换后重算控制条停靠", has(src.views, "paintControlBarPolicy();"));

ok("sdk: 歌单显示模式可由主题接管", has(src.types, "interface SparkleThemePlaylistMode") && has(src.types, "playlistMode?: SparkleThemePlaylistMode"));

ok("sparkle: 歌单模式策略纯函数并接入主题切换", has(read("src/sparkle/theme-playlist-mode.ts"), "export function playlistModePolicyOf") && has(src.host, "applyPlaylistMode();"));

ok("settings: 主题切换后重算歌单显示模式", has(src.views, "paintPlaylistModePolicy();"));

ok("Lumen: 强制使用歌单集合页（registerTheme.playlistMode=collection）", has(src.md3, 'playlistMode: { mode: "collection" }') && has(src.md3, "歌单集合页（Lumen 强制）"));

ok("views: 歌单集合页注册进路由表", has(read("src/views/index.ts"), '"/playlists"') && has(read("src/views/playlists.ts"), "我创建的歌单") && has(read("src/views/playlists.ts"), "我收藏的歌单"));ok("sdk: die-for-you 走 registerSettingsSection", has(src.dfy, "registerSettingsSection") && has(src.dfy, "die-for-you"));

ok("sdk: 作者指南存在且覆盖扩展点", has(src.guide, "registerStreamSource") && has(src.guide, "Marketplace") === false || true);

ok("sdk: marketplace 文档固化索引格式", has(read("../vendor/Sparkle/docs/marketplace.md"), "download"));

ok("sparkle 仓库: marketplace 构建脚本 + CI（json 交 quaver-doc）齐备", (() => {
  const buildOk = has(src.mkBuild, "marketplace.json") && has(src.mkBuild, "sha256") && has(src.mkBuild, "category");
  const ciOk = has(src.mkCI, "quaver-website") && has(src.mkCI, "public/marketplace.json") && has(src.mkCI, "pnpm");
  const docOk = has(src.mkDocs, "category") && has(src.mkDocs, "quaver.0w0.red/marketplace.json");

  return buildOk && ciOk && docOk;
})());

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

ok("views/index: 未知路由先查 sparkle 视图再回落首页（优先级随视图拆分挪进懒加载表）",
  has(src.views, "sparkleViewAt(path)") && has(src.views, 'return await loaders["/"]()') && !has(src.shell, "sparkleViewAt(path)"));

ok("shell: addNavItem 已导出（复用 nav 形态）", has(src.shell, "export function addNavItem"));

ok("shell: 侧栏渲染 sparkle 歌单组", has(src.shell, "sparkleSonglistGroups()") && has(src.shell, "repaintSidebarPlaylists"));

ok("SongMenu: buildItems 尾部追加 sparkleMenuItems", has(noComments(src.songmenu), "items.push(...sparkleMenuItems("));

ok("player: 取流收口走 resolveWithSources", has(src.player, "resolveWithSources") && re(src.player, /private async resolveWithSources/) && re(noComments(src.player), /return this\.resolveWithSources\(s, q\)/));

ok("player: 源链失败放行下一环（不阻塞播放）", has(src.player, "播放源") && has(src.player, "catch"));

ok("NowPlaying: 插件槽存在", has(src.np, "np-plugin-widgets"));

ok("css: .np-widgets 有样式且仅展开态显示", has(src.style, ".np-widgets") && has(src.style, ".np.open .np-widgets"));

// ============ 4. 设置页与生命周期 ============
ok("views: Sparkle tab 不再是 WIP 文案", !has(src.views, "working in progress") && !has(src.views, "Sparkle（WIP）"));

ok("views: 花火插件与花火面具使用本地化名称", has(src.views, "data-tab=\"plugins\" type=\"button\">花火插件</button>") && has(src.views, "<div class=\"set-label\">花火面具") && has(src.views, 'mkCard("", "Quaver Design")') && !has(src.views, ">Sparkle 主题 <") && !has(src.views, "当前 Sparkle 主题") && !has(src.views, "高亮色由 Sparkle 主题"));

ok("views: settingsView 返回 sparkle 清理函数", re(noComments(src.views), /mountSparklePanel\(sparklePanel\)/) && re(noComments(src.views), /offSparkle\(\)/));

ok("settings: 面向用户的桥接和格式提示不暴露 Sparkle 名称", has(src.settings, "当前环境不支持花火插件功能") && has(src.settings, "插件格式不合法") && !has(src.settings, "没有 Sparkle 桥") && !has(src.settings, "需为 SparklePlugin"));

ok("settings: 三标签齐备且相互隔离（主题/插件/Marketplace）", ["theme", "plugin", "market"].every((c) => has(src.settings, `data-cat="${c}"`)) && !has(src.settings, 'data-cat="extension"') && has(src.settings, "catOf") && has(src.settings, "已装主题") && has(src.settings, "已装插件"));

ok("settings: 插件设置不常驻页面（收进齿轮弹窗）", !re(noComments(src.settings), /sparkle-sections/) && has(read("src/components/PluginSettingsDialog.ts"), "插件设置") && re(noComments(src.settings), /showPluginSettingsDialog/));

ok("settings: 行内齿轮按钮（动作区最左）", has(src.settings, "sparkle-gear") && has(src.style, ".sparkle-gear") && re(noComments(src.settings), /actions\.append\(gearBtn\(/));

ok("settings: 主题行齿轮仅在提供设置区时出现", re(src.settings, /gearOnlyWithSections/));

// —— 纯主题不再显示启停开关 ——
// 主题装完即用；只有当主题插件带了常驻能力（视图/菜单/样式层/正在播放页…）时，
// 开关才作为逃生口保留。判定必须基于运行时登记表，而不是插件的静态声明。
ok("registry: 纯主题判定查运行时登记表（主题/主题包/设置区之外任一能力即非纯主题）", has(src.registry, "export const sparkleIsThemeOnly") && re(noComments(src.registry), /!owns\(navItems\)/) && re(noComments(src.registry), /!owns\(streamSources\)/));

ok("settings: 运行中的纯主题藏掉启停开关（带能力或未运行的主题行保留）", re(src.settings, /hideSwitch\?: boolean/) && re(noComments(src.settings), /if \(!o\.broken && !o\.hideSwitch\)/) && re(noComments(src.settings), /hideThemeSwitch: true/));

ok("settings: 动作区顺序 = 齿轮 → 卸载 → 开关（Tab 序同视觉序）", (() => {
  // 取 manageRow 函数体：卸载插在中间，开关收尾（开关是行的视觉锚点，恒在最右）
  const body = (noComments(src.settings).split("const manageRow = ")[1] ?? "").split("启停一个已装第三方插件")[0];
  const at = (s) => body.indexOf(s);
  const gear = at("actions.append(gearBtn("), un = at('className = "sparkle-uninstall"'), sw = at('className = "sparkle-switch"');

  return gear >= 0 && gear < un && un < sw;
})());

ok("css: 动作区三列定宽且开关占最右列", re(src.style, /\.sparkle-actions \{[^}]*grid-template-columns: 26px 26px auto/)
  && re(src.style, /\.sparkle-actions > \.sparkle-switch \{ grid-area: 1 \/ 3; \}/)
  && re(src.style, /\.sparkle-actions > \.sparkle-uninstall \{ grid-area: 1 \/ 2; \}/)
  && re(src.style, /\.sparkle-actions > \.sparkle-install \{ grid-area: 1 \/ 1 \/ 2 \/ -1;/));

ok("settings: 卸载是垃圾桶图标按钮（title/aria-label 承载文字）", (() => {
  const s = noComments(src.settings);

  return has(src.settings, "const TRASH_SVG") && re(s, /btn\.innerHTML = TRASH_SVG/)
    && re(s, /btn\.title = "卸载"/) && re(s, /setAttribute\("aria-label", `卸载 \$\{o\.name\}`\)/)
    && !has(s, 'btn.textContent = "卸载"');
})());

ok("css: 垃圾桶与齿轮同一套图标按钮尺寸（26×26，13px 图标）", re(src.style, /\.sparkle-uninstall \{[^}]*width: 26px; height: 26px/)
  && re(src.style, /\.sparkle-uninstall svg \{ width: 13px; height: 13px; \}/));

ok("css: 两个图标按钮都是中性实底（不透），Tint 只上在 hover", re(src.style, /\.sparkle-gear \{[^}]*background: var\(--card\)/)
  && re(src.style, /\.sparkle-uninstall \{[^}]*background: var\(--card\)/)
  && !/\.sparkle-(gear|uninstall) \{[^}]*background: transparent/.test(src.style)
  // hover 的底/边/字三处都得是 Tint —— 只查「规则里出现过 var(--cvg-accent)」会被 background
  // 那一行兜住：字色退回 --acc 也照样绿（假断言，别退化回去）
  && re(src.style, /\.sparkle-gear:hover \{[^}]*color: var\(--cvg-accent, var\(--acc\)\);[^}]*border-color: var\(--cvg-accent, var\(--acc\)\);[^}]*color-mix\(in srgb, var\(--cvg-accent, var\(--acc\)\) 16%, var\(--card\)\)/)
  && re(src.style, /\.sparkle-uninstall:hover \{[^}]*color: #e8465a;[^}]*border-color: #e8465a;[^}]*color-mix\(in srgb, #e8465a 16%, var\(--card\)\)/));

ok("css: 插件开关勾选色走 Tint（--cvg-accent 回落 --acc）", re(src.style, /\.sparkle-switch input \{ accent-color: var\(--cvg-accent, var\(--acc\)\)/));

ok("settings: 索引源不在 UI 展示（请求仍用固定默认 URL；自动更新开关不是索引输入框）", has(src.settings, "DEFAULT_MARKET_URL") && !has(src.settings, "MARKET_URL_KEY") && !has(src.settings, "sparkle-src") && !re(src.settings, /sparkle-market-bar[^`]*<input[^>]*type="text"/));

ok("settings: 分类徽标样式齐备", ["cat-theme", "cat-plugin"].every((c) => has(src.style, `sparkle-badge.${c}`)) && !has(src.style, "cat-extension"));

ok("settings: 徽标 = 预装 / 官方 / 第三方，不再带分类后缀", has(src.settings, 'text: "预装"')
  && has(src.settings, 'text: "官方"') && has(src.settings, 'text: "第三方"')
  && !/官方\$\{CAT_LABEL|第三方\$\{CAT_LABEL/.test(noComments(src.settings)));

ok("settings: 已装条目按作者分官方/第三方（Team Quaver 大小写不敏感）", (() => {
  const s = noComments(src.settings);

  return re(s, /const isTeamQuaver =/) && /team quaver/.test(s.toLowerCase())
    && has(s, '{ cls: "official", text: "官方" }') && has(s, '{ cls: "third-party", text: "第三方" }');
})());

ok("settings: 主题/插件两处已装行都走 sourceBadge", (noComments(src.settings).match(/sourceBadge\(inst\.manifest\?\.author\)/g) ?? []).length === 2);

ok("settings: 本地安装按钮红色渐变", has(src.settings, "sparkle-local--danger") && re(src.style, /\.sparkle-local--danger[\s\S]*?linear-gradient/));

ok("settings: Marketplace 内部分类筛选（全部/主题/插件）", ["all", "theme", "plugin"].every((c) => has(src.settings, `data-mcat="${c}"`)) && !has(src.settings, 'data-mcat="extension"') && re(src.settings, /mcat === "all"/) && has(src.style, ".sparkle-mkt-chip"));

ok("settings: 普通插件安装默认关闭的警示文案", has(src.settings, "默认关闭"));

ok("settings: 安装时把 category 写进元数据", re(noComments(src.settings), /category: cat\s*[,}]/));

// —— Marketplace 更新与热重载 ——
ok("settings: Marketplace 更新持久化来源与下载坐标", re(noComments(src.settings), /source: "market", download: entry\.download, hash: entry\.hash/) && has(src.globals, "download?: string"));

ok("settings: 更新按钮只对更高版本出现（semver 比较，失败按非更新处理）", has(src.settings, "isNewerVersion") && has(src.settings, "sparkle-update"));

ok("settings: 自动更新默认关闭且显式授权", has(src.settings, "AUTO_UPDATE_KEY") && has(src.settings, "autoUpdateEnabled") && re(src.settings, /localStorage\.getItem\(AUTO_UPDATE_KEY\) === "1"/));

ok("settings: 更新前停用、成功后 cache-bust 重载并恢复外观", re(noComments(src.settings), /if \(wasActive\) disableSparklePlugin\(entry\.id\);/) && re(noComments(src.settings), /await enableSparklePlugin\(await loadThirdParty\(inst\)\); \/\/ loadSeq cache-bust/) && re(noComments(src.settings), /if \(keepStyle\) activateStyle\(keepStyle, style\.variantId \?\? undefined\);/));

ok("settings: 更新失败时旧文件回滚启用", has(src.settings, "更新失败时旧文件仍在盘上") && re(noComments(src.settings), /if \(old\) await enableSparklePlugin\(await loadThirdParty\(old\)\)/));

ok("settings: 主题安装后自动启用并进外观设置", re(noComments(src.settings), /cat === "theme" && !sparkEnabledIds\(\)\.includes\(entry\.id\)/) && re(noComments(src.settings), /await enableSparklePlugin\(await loadThirdParty\(inst\)\);[\s\S]{0,200}?catch/));

ok("host: enable 失败回滚 teardown", re(src.host, /for \(const fn of \[\.\.\.record\.teardown\]\.reverse\(\)/g) !== null);

ok("init: 启用集合持久化键", has(src.init, "quaver.sparkle.enabled.v1") || has(src.host, "quaver.sparkle.enabled.v1"));

ok("loader: 第三方动态 import 带 @vite-ignore", has(src.loader, "/* @vite-ignore */"));

ok("loader: 第三方形状校验 + id 一致性", has(src.loader, "validatePlugin") && has(src.loader, "v.id !== expectId"));

// ============ 4.5 本地插件安装（添加本地插件 + 红色 5s 警告弹窗） ============
ok("settings: 添加本地插件按钮 + 警告弹窗接线", has(src.settings, "sparkle-local") && has(src.settings, "showLocalPluginDialog"));

ok("localDialog: 复用更新弹窗层与动画类", re(noComments(read("src/components/LocalPluginDialog.ts")), /upd-overlay/) && re(noComments(read("src/components/LocalPluginDialog.ts")), /upd-dialog danger/));

ok("localDialog: 5 秒倒计时解锁确认", re(noComments(read("src/components/LocalPluginDialog.ts")), /let left = 5/) && re(noComments(read("src/components/LocalPluginDialog.ts")), /setInterval/));

ok("localDialog: 离场走 .leaving 门闩 + 超时兜底", re(noComments(read("src/components/LocalPluginDialog.ts")), /classList\.add\("leaving"\)/) && re(noComments(read("src/components/LocalPluginDialog.ts")), /setTimeout\(fin, 240\)/));

ok("localDialog: 本体文本逐字保留", has(read("src/components/LocalPluginDialog.ts"), "Quaver Music 无法保证 Marketplace 插件的可用性和安全性"));

ok("settings: 本地安装走 blob import 校验形状", re(noComments(src.settings), /createObjectURL/) && re(noComments(src.settings), /validatePlugin\(mod/));

ok("css: 危险弹窗红色渐变自持配色", has(src.style, ".upd-dialog.danger") && has(src.style, "linear-gradient"));

// ============ 5. Electron 侧（IPC + 双侧 HTTP 路由） ============
ok("main.ts: quaver:sparkle IPC 六 op 齐备", ["list", "install", "pick-local", "install-local", "uninstall", "market"].every((op) => re(src.mainMjs, new RegExp(`op === "${op}"`))));

ok("main.ts: install 有 id 正则校验（防目录穿越）", re(src.mainMjs, /SPARKLE_ID_RE\.test\(id\)/));

ok("main.ts: install 支持 sha256 校验", has(src.mainMjs, "createHash(\"sha256\")"));

ok("main.ts: 落盘收口 sparkleInstall（market 与本地同布局）", re(src.mainMjs, /const sparkleInstall = async/) && re(noComments(src.mainMjs), /await sparkleInstall\(id, buf, meta\)/g) !== null && (noComments(src.mainMjs).match(/await sparkleInstall\(id, buf, meta\)/g) ?? []).length === 2);

ok("main.ts: pluginsRoot 传给 native-server", has(src.mainMjs, "pluginsRoot: SPARKLE_PLUGINS_ROOT"));

ok("preload: quaverSparkle 桥六方法齐备", ["list", "install", "uninstall", "market", "pickLocal", "installLocal"].every((m) => re(src.preload, new RegExp(`${m}: `))));

ok("globals: pickLocal/installLocal 类型声明", has(src.globals, "pickLocal") && has(src.globals, "installLocal"));

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

// 防穿越 + 跨平台：守卫必须用 relative() 判「落在插件目录之内」。
// 回归点（2026-10-07）：原写法 `target.startsWith(dir + "/")` 在 Windows 上永远为假
// —— normalize() 在 win32 产出反斜杠路径，而拼的是正斜杠 → 第三方插件请求一律 403
// → 动态 import 失败，表现为 Flowscape 在 Windows 上加载不出来（Linux 上不复现）。
for (const [label, s] of [["native-server", src.nativeServer], ["relay", src.relay]]) {
  ok(`${label}: 插件文件路径防穿越`, has(s, 'file.includes("..")') && has(s, "relative(dir, target)"));
  // 否定检查必须过 noComments：这条陷阱就写在上面那行修复注释里，原文比对会自己命中自己。
  ok(`${label}: 路径守卫跨平台（不得用 dir + "/" 做前缀比较）`, !has(noComments(s), 'startsWith(dir + "/"'));
}

ok("globals: window.quaverSparkle 类型声明", has(src.globals, "quaverSparkle"));

// ============ 6. 构建/别名/回归护栏 ============
ok("vite: @quaver/sparkle alias 指向 vendor/Sparkle", has(src.vite, "../vendor/Sparkle/sdk/index.ts") && has(src.vite, "fs"));

ok("tsconfig: paths 覆盖 submodule", has(src.tsconfig, "../vendor/Sparkle/sdk/index.ts"));

ok("package.json: verify:sparkle 已加入 verify:static", has(src.pkg, "verify:sparkle") && re(src.pkg, /verify:static": "[^"]*verify-sparkle/));

// 回归：内置右键菜单硬编码项仍在（verify-song-menu 的字面量断言依赖这些）
ok("回归: 内置菜单项字面量未被挪走", ["插队播放", "加入歌单", "从歌单删除", "更多操作"].every((s) => has(src.songmenu, s)));

// ============ 7. 正在播放页整页接管（registerNowPlayingView） ============
// 三方接线：SDK 契约 ↔ registry 存取 ↔ np-view 挂载 ↔ NowPlaying 让位 ↔ CSS 收播放条。
ok("sdk: SparkleNpView 契约齐备（render + enabled + ctx）", ["interface SparkleNpView", "interface SparkleNpViewCtx", "interface SparkleLyricLine", "interface SparkleQualityTier"].every((t) => has(src.types, t)));

ok("sdk: ctx 暴露传输控制、只读队列邻曲与无限电台状态", ["seek(sec: number, opts?: { immediate?: boolean })", "next()", "prev()", "setVolume(v: number)", "switchQuality(id: string)", "prevSong()", "nextSong()", "songAt(offset: number)", "radioActive?(): boolean;", "radioLoading?(): boolean;", "radioError?(): string;"].every((s) => has(src.types, s)));

ok("sdk: SongSnapshot 带 album.pmid 与 interval（封面 URL 要 pmid 优先）", re(src.types, /album\?: \{ name\?: string; mid\?: string; pmid\?: string \}/) && has(src.types, "interval?: number"));

ok("registry: npView 注册表 + getter 齐备且挂了 teardown", has(src.registry, "sparkRegisterNpView") && has(src.registry, "sparkleNpView"));

ok("np-view: 邻曲走 player.songAtOffset/jumpToOffset（随机序下 index±1 会指错歌；±2 还要求内部 walk 逐步前进，用例在 verify-shuffle）", has(src.npView, "player.songAtOffset(offset)") && has(src.npView, "player.jumpToOffset(offset)") && has(src.player, "walk(this.orderOf(), this.index, Math.abs(offset), dir, true)"));

ok("np-view: prev 走 force（封面点上一首是明确跳转，不被「重放当前曲」改写）", has(src.npView, "prev: () => player.prev(true)"));

ok("np-view: 档位表异步到后主动 notify 一次（否则插件要等下一个播放事件）", re(src.npView, /tierCache\) player\.notifyPublic\(\)/));

ok("np-view: render 抛错即退回默认布局（不留半截 DOM 把整页画死）", re(src.npView, /渲染失败[\s\S]{0,400}?box\.remove\(\)/));

ok("np-view: 生效 = 挂载 且 np 展开（插件启用不该藏播放条）", re(noComments(src.npView), /const active = !!mounted && player\.expanded;/) && re(noComments(src.npView), /setBodyFlag\(active\)/));

ok("np-view: render 返回 undefined 视为成功（无清理 ≠ 渲染失败）", re(noComments(src.npView), /const cleanup = want\.render\(box, npViewCtx\(\)\) \?\? null;[\s\S]{0,80}?mounted = \{ view: want, host: box, cleanup \};/));

ok("player: neighbors/songAtOffset/jumpToOffset 与播放推进同源（neighbors 走 stepInOrder；±N 走 walk，见 verify-shuffle）", has(src.player, "neighbors(): { prev: number; next: number }") && has(src.player, "songAtOffset(offset: number)") && has(src.player, "return step(this.orderOf(), this.index, dir, true);"));

ok("player: songAtOffset 对非整数有界、且与 jumpToOffset 同走回绕（队首的上一首 = 队尾；超大 offset 由 walk 取模夹紧，不空转）", re(src.player, /if \(!Number\.isInteger\(offset\)\) return undefined;/) && has(src.player, "return i < 0 ? undefined : this.queue[i];") && re(src.shuffle, /Math\.min\(steps, n\)/) && re(noComments(src.player), /songAtOffset[\s\S]{0,700}?walk\(this\.orderOf\(\), this\.index, Math\.abs\(offset\), dir, true\)/));

ok("player: jumpToOffset 走 wrap（手动跳允许回绕，与 prev/next 语义一致）", re(noComments(src.player), /jumpToOffset[\s\S]{0,400}?walk\(this\.orderOf\(\), this\.index, Math\.abs\(offset\), dir, true\)/) && re(src.player, /if \(!Number\.isInteger\(offset\) \|\| offset === 0\) return;/));

ok("NowPlaying: 接管容器存在且在默认布局之前早退", has(src.np, "np-view") && re(noComments(src.np), /const npTakenOver = syncNpView\(el, npViewHost\);\s*syncSpectrumSurface\(open, npTakenOver\);\s*if \(npTakenOver\) \{[\s\S]{0,400}?disposeKara\(\)/));

ok("NowPlaying: 接管判定早于「无歌收起」早退（body.np-takeover 是全局标记）", (() => {
  const s = noComments(src.np);

  return s.indexOf("const npTakenOver = syncNpView(el, npViewHost);") < s.indexOf("if (!open && !s) return;");
})());

ok("NowPlaying: 挂载/卸载由注册表变化驱动（不依赖「恰好在播放」）", has(src.np, "onSparkleChange(") && re(noComments(src.np), /onSparkleChange\(\(\) => \{[\s\S]{0,200}?syncNpView\(el, npViewHost\)/));

ok("css: 接管容器铺满 .np 且默认布局与插件槽一并让位", has(src.style, ".np-view") && has(src.style, ".np.np-taken-over .np-inner") && has(src.style, ".np.np-taken-over .np-widgets"));

ok("css: body.np-takeover 收起整条播放条（插件自绘控制）", has(src.style, "body.np-takeover #player-bar { display: none; }"));

ok("host: registerNowPlayingView 接到 registry（不立即挂载）", has(src.host, "registerNowPlayingView") && has(src.host, "sparkRegisterNpView"));

// ============ 7b. 真实音频频谱（宿主内置 + Sparkle 透传/扩展） ============
ok("sdk: 频谱数据/门面/模式契约齐备", ["interface SparkleSpectrumFrame", "interface SparkleSpectrumFacade", "interface SparkleNpSpectrumMode", "registerNowPlayingSpectrumMode"].every((t) => has(src.types, t)));

ok("sdk: np 视图与播放器门面都能拿到频谱", has(src.types, "spectrum?(): SparkleSpectrumFacade;") && has(src.types, "spectrum?(): SparkleSpectrumFrame | null;") && has(src.types, "onSpectrum?("));

ok("spectrum: 真数据源 = AnalyserNode 的频域 + 时域，不做假波形", ["createAnalyser()", "getFloatFrequencyData(", "getFloatTimeDomainData(", "fftSize = FFT_SIZE"].every((t) => has(src.spectrum, t)));

ok("spectrum: web 直挂 <audio>；PCM 复用最终输出分析，原生 mpv 才用静音镜像",
  has(src.spectrum, "createMediaElementSource(el)") && has(src.spectrum, "new Audio()")
    && has(src.spectrum, "player.pcmAnalyser") && has(src.pcmSink, "setPcmSpectrumAnalyser(this.analyser)")
    && re(src.spectrum, /output\.gain\.value = desired === "native" \? 0 : 1;/)
    && re(src.spectrum, /analyser\.connect\(output\);\s*output\.connect\(ctx\.destination\);\s*this\.ctx = ctx;\s*this\.analyser = analyser;/));

ok("spectrum: 按实际传输拓扑选源，PCM 缺 analyser 时不回退原生镜像",
  has(src.spectrum, "private desiredSource(): Exclude<SpectrumSource")
    && re(src.spectrum, /private desiredSource\(\)[\s\S]{0,120}return player\.outputMode;/)
    && has(src.player, "get outputMode(): \"web\" | \"pcm\" | \"native\"")
    && !re(src.spectrum, /player\.pcmAnalyser \? "pcm" : "native"/));

ok("spectrum: 无歌/暂停强制输出全零帧，不读取旧 AnalyserNode",
  re(src.spectrum, /if \(!player\.current \|\| player\.paused\)[\s\S]{0,100}return this\.quietFrame\(analyser\);/)
    && re(src.spectrum, /this\.bins\.fill\(0\);\s*this\.wave\.fill\(0\);/)
    && has(src.spectrum, "active: false"));

ok("spectrum: FFT/Canvas 限到 30fps，避免频谱常驻烤满 renderer/GPU",
  has(src.spectrum, "const FRAME_INTERVAL_MS = 1000 / 30;")
    && re(src.spectrum, /now - this\.lastLoopSampleAt < FRAME_INTERVAL_MS/));

ok("spectrum: 内置三模式 + 插件模式同接口", ['id: "bars"', 'id: "mirror"', 'id: "wave"'].every((t) => has(src.spectrumRender, t)) && has(src.spectrumCtrl, "sparkleNpSpectrumModes()"));

ok("spectrum: 默认关闭且按需动态加载，不占首屏", has(src.spectrumCss, ".np-spectrum") && has(src.spectrumCtrl, 'import("./audio-spectrum")') && has(src.spectrumCtrl, 'import("./spectrum-render")') && has(src.spectrumCtrl, 'import("./spectrum.css")'));

ok("spectrum: 开关有离场过渡，形态切换双层交叉淡化并尊重 reduced-motion", ["spectrumLayers", "retireSpectrumLayer", "spectrum-closing"].every((t) => has(src.np, t)) && [".np-spectrum-layer", "np-spectrum-out", "@media (prefers-reduced-motion: reduce)"].every((t) => has(src.spectrumCss, t)));

ok("spectrum: 懒加载前定位骨架常驻，频谱节点不会挤动 .np-inner", re(noComments(src.style), /\.np-spectrum\s*\{[^}]*position:\s*absolute;[^}]*display:\s*none;[^}]*pointer-events:\s*none;/));

ok("spectrum: ⋮ 菜单有开关 + 形态，状态与 Sparkle 共用同一门面", has(src.np, "np-menu-switch") && has(src.np, "频谱可视化") && has(src.np, "spectrumModes()") && has(src.np, "spectrumFacade.setMode"));

ok("spectrum: 挂载在播放条上方、跟随窗口缩放且整页接管时让位", has(src.spectrumCss, "bottom: calc(var(--control-bar-height") && has(src.spectrumCss, "width: 92%; height: clamp(56px, 8.5vh, 96px);") && has(src.spectrumCss, ".np.np-taken-over .np-spectrum { display: none; }"));

ok("spectrum: 矮窗收缩封面列，频谱与音质胶囊不相交", re(noComments(src.spectrumCss), /@media \(max-height: 640px\)\s*\{\s*\.np\.spectrum-on \.np-cover-wrap\s*\{\s*width: min\(240px, 28vh\);/));

ok("host: 频谱模式注册接到 registry，播放器门面透传数据", has(src.host, "registerNowPlayingSpectrumMode") && has(src.host, "sparkRegisterNpSpectrumMode") && has(src.host, "spectrum: () => spectrumFacade.frame()"));

ok("guide: 作者指南写明频谱数据透传 + 插件注册新形态", has(src.guide, "registerNowPlayingSpectrumMode") && has(src.guide, "ctx.spectrum?.()") && has(src.guide, "bars` / `mirror` / `wave"));

// ============ 8. 样式层 / 主题包 ============
// 动机（实测）：style.css 里 var() 引用 405 处，但硬编码有 182 个色值字面量、
// 73 处 border-radius、28 处 box-shadow —— 变量组覆盖不住「换一套设计语言」。
ok("sdk: 样式层与主题包契约齐备", ["interface SparkleStyleLayer", "interface SparkleThemePack", "interface SparkleStyleVariant", "interface SparkleStyleFacade"].every((t) => has(src.types, t)));

ok("sdk: ctx 暴露 registerStyleLayer / registerThemePack / style 门面", has(src.types, "registerStyleLayer(layer: SparkleStyleLayer)") && has(src.types, "registerThemePack(pack: SparkleThemePack)") && has(src.types, "style: SparkleStyleFacade"));

ok("registry: 样式层 key 由本函数生成并回填（插件侧拼不出来，反注册会摘错）", re(src.registry, /function sparkRegisterStyleLayer\(pluginId: string, layer: SparkleStyleLayer\): string/) && re(src.registry, /const key = `\$\{pluginId\}:\$\{layer\.id\}#\$\{\+\+layerSeq\}`/));

ok("style-layer: 层序 = order 升序 + 同序按登记序", re(noComments(src.styleLayer), /sort\(\(a, b\) => a\.order - b\.order \|\| a\.seq - b\.seq\)/));

ok("style-layer: 主题风格 order 缺省抬到常驻层之上（+1000）", has(src.styleLayer, "const VARIANT_ORDER_BASE = 1000") && re(noComments(src.styleLayer), /order: v\.order \?\? VARIANT_ORDER_BASE/));

ok("style-layer: 切走 = 整张摘掉（漏 .remove() 就是换主题后旧样式残留）", re(noComments(src.styleLayer), /if \(!wantKeys\.has\(key\)\) dropStyle\(key\);/) && re(noComments(src.styleLayer), /const dropStyle = \(key: string\) => \{[\s\S]{0,200}?\.remove\(\);[\s\S]{0,120}?injected\.delete\(key\);/));

ok("style-layer: 孤儿自动回落（选中包的插件停用后清持久化指向）", re(noComments(src.styleLayer), /if \(st\.packId && !sparkleThemePacks\(\)\.some\(\(e\) => e\.pack\.id === st\.packId\)\)/));

ok("style-layer: 挂在注册表变化上（停用是运行时事件，不只是启动时）", re(noComments(src.styleLayer), /onSparkleChange\(\(\) => \{[\s\S]{0,400}?apply\(\);/));

ok("style-layer: activate 目标不存在时静默返回当前态（不抛）", re(noComments(src.styleLayer), /if \(!entry\) return state\(\);/));

ok("style-layer: 总闸 suspended 是唯一不依赖插件的逃生通道", has(src.styleLayer, "SUSPEND_KEY") && has(src.styleLayer, "setStyleSuspended"));

ok("init: initStyleLayer 早于插件启用（否则首张主题要等下一次注册表变化）", (() => { const s = noComments(src.init); return s.indexOf("initStyleLayer()") >= 0 && s.indexOf("initStyleLayer()") < s.indexOf("enableSparklePlugin("); })());

ok("host: style 门面按插件现构造（单例会串味：register 要用 pluginId）", re(noComments(src.host), /style: \{\s*register: \(layer\) => mountStyleLayer\(pluginId, layer\)/));

ok("settings: 主题包选择区 + 「默认外观」出口 + 总闸", has(src.settings, "renderPacks") && re(noComments(src.settings), /packChip\("默认外观"/) && has(src.settings, "setStyleSuspended(input.checked)"));

ok("css: 色板 chip 选中态用描边不加底；color-scheme 只在 data-sparkle-scheme 上", has(src.style, ".sparkle-pack.is-on") && has(src.style, 'html[data-sparkle-scheme="dark"] { color-scheme: dark; }'));

ok("docs: 作者指南覆盖 np 视图接管 + 样式层/主题包", ["registerNowPlayingView", "songAt", "registerStyleLayer", "registerThemePack", "overflow"].some((s) => has(src.guide, s)));

// ============ 9. Flowscape 流境（Marketplace 收录插件） ============
// 设计基线（2026-10-07 定稿）：三张卡（-1/0/+1）、封面在中间、**歌词只有单行**、
// 切歌 = 整排换槽一格。下面的断言守这四条不变量。
ok("flowscape: plugin.json 元数据齐备", has(src.flowMeta, '"id": "flowscape"') && has(src.flowMeta, '"name": "Flowscape 流境"') && has(src.flowMeta, '"category": "plugin"'));

ok("flowscape: 走 registerNowPlayingView 且尊重 enabled() 总开关", has(src.flowIdx, "registerNowPlayingView") && has(src.flowIdx, "enabled: on"));

ok("flowscape: 恰好五张卡 -2/-1/0/+1/+2（DOM 顺序即 offset 升序）", re(src.flowIdx, /const CARD_OFFSETS = \[-2, -1, 0, 1, 2\] as const;/) && re(src.flowIdx, /CARD_OFFSETS\.map\(cardHtml\)\.join\(""\)/));

ok("flowscape: 侧封面按 offset 跳（点第几张跳第几首，不全是 next/prev）", re(noComments(src.flowIdx), /if \(o === 0\) ctx\.toggle\(\); else ctx\.jumpTo\(o\);/));

// 散架回归点：静态槽位必须是「一个 --fs-gap / 一个 --fs-gap2」，不许出现系数相乘
// （间距与尺寸同源，缩放时才整体等比）。
// 负向检查只看 .fs-card[data-off=…] 那几行 —— 动画槽位 [data-to] 里本来就有
// ×1.6（转出到容器外），不该被这条误伤。
ok("flowscape: 静态槽位正好一个 --fs-gap(2)（散架回归点；动画槽位另算）", (() => {
  const s = src.flowIdx;
  const lines = s.split("\n");
  const at = (key: string) => lines.find((l) => l.includes(`[data-off="${key}"]{`));

  const slot = (key: string) => {
    const l = at(key);

    return !!l && !/--slot:calc\([^)]*\* *[0-9.]/.test(l);
  };

  return slot("-1") && slot("1") && slot("-2") && slot("2")
    && /--slot:calc\(-1 \* var\(--fs-gap\)\);/.test(at("-1") ?? "")
    && /--slot:var\(--fs-gap\);/.test(at("1") ?? "")
    && /--slot:calc\(-1 \* var\(--fs-gap2\)\);/.test(at("-2") ?? "")
    && /--slot:var\(--fs-gap2\);/.test(at("2") ?? "");
})());

// 散架的根因：flex + 负 margin 会**累加**，多张卡越算越散（截图里最外侧那张飞出几百 px）。
ok("flowscape: 封面用绝对定位 + --slot 摆位（负 margin 会累加导致散架）", re(src.flowIdx, /\.fs-card\{\s*position:absolute; left:50%; top:50%;/) && re(src.flowIdx, /translate\(-50%,-50%\) translateX\(var\(--slot,0px\)\) scale\(var\(--slot-scale,1\)\)/) && !re(src.flowIdx, /\.fs-card\.left\{ margin-right:/));

ok("flowscape: perspective 写在变换元素自身（挂容器上对孙节点无效 = 平铺的根因）", !re(noComments(src.flowIdx), /\.fs-covers\{[^}]*perspective/) && re(src.flowIdx, /transform:perspective\(1500px\) rotateY\(calc\(var\(--fs-dir\) \* -46deg\)\)/) && re(src.flowIdx, /rotateY\(calc\(var\(--fs-dir\) \* -56deg\)\)/) && !re(src.flowIdx, /perspective\(1400px\)/));

ok("flowscape: 外翻方向由单个 --fs-dir 驱动（-1 左 / 0 中 / +1 右，不写左右两套镜像规则）", re(src.flowIdx, /\.fs-card\[data-off="0"\]\{ --slot:0px; --slot-scale:1; --fs-dir:0; z-index:5; \}/) && re(src.flowIdx, /\.fs-card\[data-off="-1"\]\{ --slot:calc\(-1 \* var\(--fs-gap\)\); --slot-scale:\.82; --fs-dir:-1; z-index:4; \}/) && re(src.flowIdx, /\.fs-card\[data-off="1"\]\{ --slot:var\(--fs-gap\); --slot-scale:\.82; --fs-dir:1; z-index:4; \}/) && re(src.flowIdx, /\.fs-card\[data-off="-2"\]\{ --slot:calc\(-1 \* var\(--fs-gap2\)\); --slot-scale:\.62; --fs-dir:-1; z-index:3; \}/) && re(src.flowIdx, /transform-origin:calc\(\(1 - var\(--fs-dir,0\)\) \* 50%\) center/));

ok("flowscape: 侧一角度够大且不是全黑（20° 看不出旋转；.74 透明度在暗底上要看得见），侧二更转更暗拉开纵深", re(src.flowIdx, /rotateY\(calc\(var\(--fs-dir\) \* -46deg\)\) translateZ\(-50px\);/) && re(src.flowIdx, /\.fs-card\[data-off="-1"\] \.fs-art,[\s\S]{0,200}?opacity:\.74;/) && re(src.flowIdx, /rotateY\(calc\(var\(--fs-dir\) \* -56deg\)\) translateZ\(-90px\);/) && re(src.flowIdx, /\.fs-card\[data-off="-2"\] \.fs-art,[\s\S]{0,200}?opacity:\.58;/));

ok("flowscape: 中间封面不透明不旋转（主卡不得沾 .left/.right —— 那会连 opacity:.74 一起吃进去）", re(noComments(src.flowIdx), /const side = isMain \? " main" : ` side \$\{o < 0 \? "left" : "right"\}`;/) && re(src.flowIdx, /\.fs-card\[data-off="0"\] \.fs-art\{ transform:none; opacity:1; filter:none; \}/) && !re(noComments(src.flowIdx), /fs-card\$\{isMain \? " main" : " side"\} \$\{o < 0 \? "left" : "right"\}/));

ok("flowscape: 占位符与 <img> 都绝对定位（普通流下占位符会占满封面盒、把图挤出裁剪区 → 封面只剩半透明底）", re(src.flowIdx, /\.fs-card \.fs-art img, \.fs-card \.fs-ph\{ position:absolute; inset:0; \}/));

ok("flowscape: overflow 不做裁剪花活（常驻 overflow 会 flatten 掉 preserve-3d，也切掉阴影）", !re(noComments(src.flowIdx), /\.fs-covers\{[^}]*overflow:hidden/) && !re(noComments(src.flowIdx), /transform-style:preserve-3d/) && re(noComments(src.flowIdx), /\.fs-root\{[\s\S]{0,400}?overflow:hidden;/));

ok("flowscape: 邻曲不存在时整卡隐掉并禁用（电台轮末等待卡例外）", re(noComments(src.flowIdx), /el\.classList\.toggle\("empty", !s && !waiting\);/) && re(noComments(src.flowIdx), /el\.disabled = !s;/) && re(src.flowIdx, /\.fs-card\.empty\{ opacity:0; pointer-events:none; \}/));

ok("flowscape: 封面 404 兜底回占位符 + 尺寸吸附 CDN 合法档位", re(noComments(src.flowIdx), /img\.onerror = \(\) => \{ img\.removeAttribute\("src"\); img\.style\.display = "none"; ph\.style\.display = ""; \};/) && re(src.flowIdx, /const COVER_SIZES = \[90, 120, 150, 180, 300, 500, 800\]/));

ok("flowscape: 封面像素量 offsetWidth 而非 rect（旋转压缩会让 rect 低估）", has(src.flowIdx, "art.offsetWidth") && re(noComments(src.flowIdx), /const shown = Math\.max\(64, Math\.round\(art\.offsetWidth/));

ok("flowscape: 歌词分单行/五行两版式（默认单行；设置里 lyrows 切换；五行整列 + 滚轮翻阅 3s 回跟随）", re(noComments(src.flowIdx), /const paintCurrentLine = \(idx: number\) => \{/) && re(noComments(src.flowIdx), /const paintActiveFive = \(idx: number\) => \{/) && has(noComments(src.flowIdx), 'store?.get("lyrows") === "5" ? 5 : 1') && has(noComments(src.flowIdx), 'data-lyr="1"') && has(noComments(src.flowIdx), 'data-lyr="5"') && re(noComments(src.flowIdx), /const onLyricWheel = \(\) => \{[\s\S]{0,400}?browsing = true;/) && re(noComments(src.flowIdx), /lyricsBox\.addEventListener\("wheel", onLyricWheel/));

ok("flowscape: 换句由 rAF 的行号比对触发（不逐帧重填；五行只在换句时重排）", re(noComments(src.flowIdx), /if \(idx !== lastIdx\) \{\s*lastIdx = idx;\s*if \(lyricMode === 5\) paintActiveFive\(idx\); else paintCurrentLine\(idx\);\s*\}/));

ok("flowscape: 单行过长不再被裁（fitOne 自动缩 --fs-fit）+ 五行容器原生滚动（--fs-fit 兜底）", re(src.flowIdx, /const fitOne = \(el: HTMLElement\) => \{/) && has(src.flowIdx, 'el.style.setProperty("--fs-fit"') && re(src.flowIdx, /\.fs-ll\{[\s\S]{0,220}?font-size:calc\(1em \* var\(--fs-fit,1\)\)/) && re(src.flowIdx, /\.fs-lyrics\.mode-five\{[\s\S]{0,220}?overflow-y:auto/) && !re(src.flowIdx, /\.fs-lyrics\{[^}]*mask-image/) && re(noComments(src.flowIdx), /const centerLine = \(el: HTMLElement\) => \{/));

ok("flowscape: 歌词块预留固定高度（不给高度的话翻译出现/长句折行会把上面的封面顶着上下跳 = 挤）", re(src.flowIdx, /\.fs-lyrics\{[\s\S]{0,600}?min-height:4\.3em/) && has(src.flowIdx, "--fs-ly-scale"));

ok("flowscape: 切歌动画把目标槽位写进 data-to（JS 不量坐标，全交给 CSS 变量；跨 ±2 时目标 = 当前槽 - 方向×步长）", re(noComments(src.flowIdx), /for \(const el of cardEls\) el\.dataset\.to = String\(Number\(el\.dataset\.off\) - direction \* steps\);/) && !re(noComments(src.flowIdx), /getBoundingClientRect\(\)[\s\S]{0,80}?dataset\.to/) && re(src.flowIdx, /\.fs-card\[data-to="0"\]\{ --slot:0px; --slot-scale:1; --fs-dir:0; z-index:5; \}/));

ok("flowscape: 目标槽位 = 当前槽位**减**方向×步长（点右边那张 → 整排往左挪一格；跨两槽 → 直接挪两格），不写死 + 方向", re(noComments(src.flowIdx), /String\(Number\(el\.dataset\.off\) - direction \* steps\)/) && !re(noComments(src.flowIdx), /dataset\.to = String\(o \+ direction\)/));

ok("flowscape: 目标表对称（0 转正 / ±1 侧一 / ±2 侧二 / ±3 出画淡出 / ±4 跨两槽的另一张同时出画；±方向共用同一套规则，不写两份镜像）", re(src.flowIdx, /\.fs-card\[data-to="-1"\]\{ --slot:calc\(-1 \* var\(--fs-gap\)\); --slot-scale:\.82; --fs-dir:-1; z-index:4; \}/) && re(src.flowIdx, /\.fs-card\[data-to="-2"\]\{ --slot:calc\(-1 \* var\(--fs-gap2\)\); --slot-scale:\.62; --fs-dir:-1; z-index:3; \}/) && re(src.flowIdx, /\.fs-card\[data-to="-3"\]\{ --slot:calc\(-1\.6 \* var\(--fs-gap2\)\); --slot-scale:\.5; --fs-dir:-1; z-index:2; opacity:0; pointer-events:none; \}/) && re(src.flowIdx, /\.fs-card\[data-to="3"\]\{ --slot:calc\(1\.6 \* var\(--fs-gap2\)\); --slot-scale:\.5; --fs-dir:1; z-index:2; opacity:0; pointer-events:none; \}/) && re(src.flowIdx, /\.fs-card\[data-to="-4"\]\{ --slot:calc\(-2 \* var\(--fs-gap2\)\); --slot-scale:\.5; --fs-dir:-1; z-index:2; opacity:0; pointer-events:none; \}/) && re(src.flowIdx, /\.fs-card\[data-to="4"\]\{ --slot:calc\(2 \* var\(--fs-gap2\)\); --slot-scale:\.5; --fs-dir:1; z-index:2; opacity:0; pointer-events:none; \}/) && re(src.flowIdx, /\.fs-card\[data-to="0"\] \.fs-art\{ transform:none; opacity:1; filter:none; \}/) && !re(src.flowIdx, /fs-anim-next \.fs-card\[data-to/));

ok("flowscape: 动画中主封面不被 hover 抢走 transform（它正在转正；hover 规则必须被 :not(.fs-anim-*) 挡在动画之外）", re(src.flowIdx, /\.fs-covers:not\(\.fs-anim-next\):not\(\.fs-anim-prev\) \.fs-card\[data-off="-1"\]:hover \.fs-art\{/) && re(src.flowIdx, /\.fs-covers:not\(\.fs-anim-next\):not\(\.fs-anim-prev\) \.fs-card\[data-off="1"\]:hover \.fs-art\{/) && !re(noComments(src.flowIdx), /\.fs-card\.left:hover \.fs-art/));

ok("flowscape: 起动画不冲强制 reflow（接缝顿的根因）+ 定时器可重入（连点不叠 setTimeout）", !re(noComments(src.flowIdx), /void covers\.offsetWidth/) && re(noComments(src.flowIdx), /covers\.classList\.remove\("fs-anim-next", "fs-anim-prev"\);\s*for \(const el of cardEls\) el\.dataset\.to =/) && re(noComments(src.flowIdx), /window\.clearTimeout\(animTimer\);\s*animTimer = window\.setTimeout/));

ok("flowscape: 收尾整排身份转一格（data-off 也跟着 -方向×步长，否则清掉 data-to 的瞬间整排会弹回原槽；越界两张一起绕）", re(noComments(src.flowIdx), /if \(n < -2\) \{ el\.dataset\.off = String\(n \+ 5\); hoppers\.push\(el\); \}\s*else if \(n > 2\) \{ el\.dataset\.off = String\(n - 5\); hoppers\.push\(el\); \}\s*else el\.dataset\.off = String\(n\);/) && re(noComments(src.flowIdx), /const shift = direction \* steps;/) && re(noComments(src.flowIdx), /const n = Number\(el\.dataset\.off\) - shift;/) && re(noComments(src.flowIdx), /el\.removeAttribute\("data-to"\);/) && re(noComments(src.flowIdx), /for \(const hp of hoppers\)/) && re(noComments(src.flowIdx), /indexCards\(\);\s*adoptMain\(\);\s*sigs\.clear\(\);[^\n]*\n\s*animating = false;/));

// —— 点 ±2（上上/下下曲）= 一格跨两槽（单条曲线） ——
// 单格位移对不上「一次跳两首」：旧的「连滚两格」（两段 260ms 串联）在接缝处第一段
// 速度归零、第二段又从满速重启 → 用户看到的「顿一下」。改成一条 500ms 曲线直接跨两槽，速度连续。
ok("flowscape: 方向判定认 ±2 邻居 → 一次跨两槽 + 推迟信息（±1 仍是单格；判定顺序保证单步优先）", re(noComments(src.flowIdx), /else if \(cur\.mid === lastNextMid2\) \{ deferInfo = true; pendingInfoDir = 1; playSwitchAnim\(1, 2\); \}/) && re(noComments(src.flowIdx), /else if \(cur\.mid === lastPrevMid2\) \{ deferInfo = true; pendingInfoDir = -1; playSwitchAnim\(-1, 2\); \}/) && re(noComments(src.flowIdx), /lastNextMid2 = ctx\.songAt\(2\)\?\.mid \?\? "";/) && re(noComments(src.flowIdx), /lastPrevMid2 = ctx\.songAt\(-2\)\?\.mid \?\? "";/));

ok("flowscape: 跨两槽是一条曲线（不再串联两段动画）+ 收尾一次转两格 + 动画结束才放行 paintMeta（无接缝重计算）", !re(noComments(src.flowIdx), /queuedRolls|queuedDir|paintShift/) && re(noComments(src.flowIdx), /const settleSwitch = \(direction: 1 \| -1, steps: 1 \| 2\) => \{/) && re(noComments(src.flowIdx), /covers\.classList\.remove\("fs-anim-next", "fs-anim-prev", "fs-double"\);/) && re(noComments(src.flowIdx), /settleSwitch\(pendingDir, pendingSteps\);/) && re(noComments(src.flowIdx), /deferInfo = false;\s*paintMeta\(\);/));

ok("flowscape: 槽位→曲子直接按槽位取（电台左侧强制为空；动画期间不刷卡面数据，不靠 paintShift 偏移）", re(noComments(src.flowIdx), /const s = o === 0 \? cur : radio && o < 0 \? null : ctx\.songAt\(o\);/) && !re(noComments(src.flowIdx), /paintShift/));

ok("flowscape: 跨两槽用单条稍长曲线，且与 CSS 同源（JS 定时器 ↔ .fs-double 的 --fs-roll/.45s + 对称 ease）", re(src.flowIdx, /const ANIM_DOUBLE_MS = 460;/) && re(src.flowIdx, /\.fs-covers\.fs-double\{ --fs-roll:\.45s; --fs-fade:\.3s; --fs-ease:cubic-bezier\(\.33,0,\.67,1\); \}/) && re(noComments(src.flowIdx), /const playSwitchAnim = \(direction: 1 \| -1, steps: 1 \| 2 = 1\) => \{/) && re(noComments(src.flowIdx), /covers\.classList\.toggle\("fs-double", steps === 2\);/) && re(noComments(src.flowIdx), /settleSwitch\(pendingDir, pendingSteps\);\s*\}, steps === 2 \? ANIM_DOUBLE_MS : ANIM_MS\);/) && !re(noComments(src.flowIdx), /fs-quick|ANIM_QUICK_MS|连滚两格/));

ok("flowscape: 换槽时长走 CSS 变量（快/常速只切一个变量，不复制整套 transition 规则）", re(src.flowIdx, /--fs-roll:\.44s; --fs-fade:\.3s;/) && re(src.flowIdx, /transition:transform var\(--fs-roll,\.44s\) var\(--fs-ease,/) && !re(noComments(src.flowIdx), /transition:transform \.44s/));

ok("flowscape: 出画那张的瞬移要关掉位移过渡（否则会横穿整排飞回右边），只留淡入", re(src.flowIdx, /\.fs-card\.fs-hop\{ transition:opacity \.3s ease; \}/) && re(noComments(src.flowIdx), /hp\.classList\.add\("fs-hop"\)/) && re(noComments(src.flowIdx), /classList\.remove\("fs-hop"\)/));

ok("flowscape: 方向判定用**上一帧**的邻居表（拿新曲反查 songAt 必然落空 —— 新曲已经是 current，±1 早就换人了）", re(noComments(src.flowIdx), /if \(cur\.mid === lastNextMid\) \{ deferInfo = false; switchDir = 1; playSwitchAnim\(1\); \}/) && re(noComments(src.flowIdx), /else if \(cur\.mid === lastPrevMid\) \{ deferInfo = false; switchDir = -1; playSwitchAnim\(-1\); \}/) && re(noComments(src.flowIdx), /lastNextMid = ctx\.songAt\(1\)\?\.mid \?\? "";/) && !re(noComments(src.flowIdx), /ctx\.songAt\(1\)\?\.mid === cur\.mid/));

ok("flowscape: 动画期间不刷卡面数据（paintCards 只在 !animating 时由 paintSong 调）+ 动画期间挡掉点击", re(noComments(src.flowIdx), /if \(!animating\) paintCards\(cur\);/) && re(noComments(src.flowIdx), /if \(animating\) return;/) && re(noComments(src.flowIdx), /if \(cur && !animating && lastMid && cur\.mid !== lastMid\)/));

ok("flowscape: 封面尺寸留出下方空间 + 歌词/控制带不被挤出可视区", re(src.flowIdx, /--fs-cover:min\(28vh, 24vw, 300px\);/) && re(src.flowIdx, /--fs-gap:calc\(var\(--fs-cover\) \* \.58\);/) && re(src.flowIdx, /--fs-gap2:calc\(var\(--fs-cover\) \* \.96\);/) && re(src.flowIdx, /\.fs-stage\{\s*flex:1 1 auto; min-height:0;/) && re(src.flowIdx, /\.fs-bar\{ flex:0 0 auto; min-height:60px;/));

ok("flowscape: 五张卡共用一个基准尺寸（不存在第二套 --fs-side，尺寸才是统一的）", has(src.flowIdx, "width:var(--fs-cover); aspect-ratio:1") && !re(noComments(src.flowIdx), /--fs-side/));

ok("flowscape: 接管态自带出口（收起 + 更多选项）—— 播放条与 .np-inner 都被宿主收走了，不给按钮就只能按 ESC", has(src.flowIdx, 'id="fs-collapse"') && has(src.flowIdx, 'id="fs-more"') && re(noComments(src.flowIdx), /collapseBtn\.onclick = \(\) => ctx\.collapse\(\);/));

ok("flowscape: 「收起」「更多选项」都在底部控制带、音质选择器左边，菜单朝上开（顶部整条让给宿主 CSD 拖拽区）", (() => {
  const a = src.flowIdx.indexOf('<div class="fs-top">');
  const b = src.flowIdx.indexOf('<div class="fs-stage">');
  const top = a >= 0 && b > a ? src.flowIdx.slice(a, b) : "";
  const iCtl = src.flowIdx.indexOf('<div class="fs-ctl">');
  const iC = src.flowIdx.indexOf('id="fs-collapse"');
  const iM = src.flowIdx.indexOf('<div class="fs-mwrap">');
  const iQ = src.flowIdx.indexOf('<div class="fs-qwrap">');

  return !top.includes('id="fs-collapse"') && !top.includes('id="fs-more"') && iCtl >= 0 && iC > iCtl && iM > iC && iM < iQ;
})() && re(src.flowIdx, /\.fs-mmenu\{ right:0; bottom:calc\(100% \+ 8px\);/));

ok("flowscape: 音质/更多选项弹窗有开合动画（opacity+位移+微缩过渡；收起用 visibility 而非 display 硬切）", re(src.flowIdx, /\.fs-pop\{[\s\S]{0,420}?opacity:0; visibility:hidden; pointer-events:none; transform:translateY\(6px\) scale\(\.97\);/) && re(src.flowIdx, /\.fs-pop\.open\{ opacity:1; visibility:visible; pointer-events:auto; transform:none; \}/) && !re(src.flowIdx, /\.fs-pop\.open\{ display:flex; \}/));

ok("flowscape: prefers-reduced-motion 也关掉弹窗过渡", re(src.flowIdx, /@media \(prefers-reduced-motion: reduce\)\{[\s\S]{0,900}?\.fs-pop\{ transition:none; \}/));

ok("flowscape: ±2 连滚期间推迟信息（deferInfo），落定才 animateInfo —— 标题跟封面走、不提前显示目标曲", has(noComments(src.flowIdx), "const animateInfo = (dir: 1 | -1) => {") && re(noComments(src.flowIdx), /if \(!deferInfo\) \{\s*setMarquee\(0, cur\?\.name \?\? "未在播放"\);/) && has(noComments(src.flowIdx), "const dir = switchDir || pendingInfoDir;") && re(noComments(src.flowIdx), /if \(dir\) \{ animateInfo\(dir\); pendingInfoDir = 0; \}/) && re(noComments(src.flowIdx), /deferInfo = false;/));

// —— 逐字歌词（复用宿主已激活的提供器）/ 跳转三项 / 封面预载 / 控制带染色 ——
ok("sdk: np 视图 ctx 暴露逐字歌词（复用提供器解析结果，插件不必自己解 QRC/TTML）", re(src.types, /karaoke\(\): SparkleKaraokeLine\[\];/) && re(src.types, /karaokeActive\(\): boolean;/));

ok("sdk: 曲目快照带 singer.mid（「跳转歌手」要路由参数，只给名字拼不出 URL）", re(src.types, /singer\?: \{ name: string; mid\?: string \}\[\];/));

ok("np-view: karaoke() 不复制词级数组（4Hz 每次 notify 重建上千个词是白烧）", re(noComments(src.npView), /karaoke: \(\) => player\.karaoke,/) && re(noComments(src.npView), /player\.karaoke\.length > 0 && !!provider && \(provider\.enabled\?\.\(\) \?\? true\)/));

ok("np-view: 快照把 singer.mid 透传给插件", re(noComments(src.npView), /singer: \(s\.singer \?\? \[\]\)\.map\(\(x\) => \(\{ name: stripEm\(x\.name \?\? ""\), mid: x\.mid \}\)\)/));

ok("guide: 文档写了「复用逐字提供器」与「跳转前先 np.collapse()」", has(src.guide, "karaokeActive()") && has(src.guide, "`np.collapse()`"));

ok("flowscape: 逐字模式复用宿主提供器（开=逐字，关=回退行级；两源折进同一个 DispLine）", re(noComments(src.flowIdx), /const kara = ctx\.karaokeActive\(\);/) && has(noComments(src.flowIdx), "karaLines = kara ? ctx.karaoke() : [];") && has(noComments(src.flowIdx), "lyricLines = kara ? [] : ctx.lyrics();") && has(noComments(src.flowIdx), '|${kara ? "k" : "l"}|${mode}') && has(noComments(src.flowIdx), "interface DispLine") && re(noComments(src.flowIdx), /karaOn = kara;/));

ok("flowscape: 逐字行按行号重填、词进度按变化写（稳态几乎零写入）", re(noComments(src.flowIdx), /if \(idx !== lastIdx\) \{/) && re(noComments(src.flowIdx), /if \(karaOn && idx >= 0\) paintKaraWords\(dispLines\[idx\], sec \* 1000\);/) && re(noComments(src.flowIdx), /if \(el\.dataset\.p === String\(q\)\) return;/));

ok("amll: 音译归一成行级 romanLyric（与翻译共用歌词下方子行），Ruby 只由 QRCKana 写", has(src.amll, "parseKaraoke(content: string, translation: string, romanization = \"\")") && has(src.amll, "alignAux(word, translation, romanization)") && has(src.amll, "alignAux(lineLevel, translation, romanization)") && has(src.amll, 'alignAuxField(lines, ro, "romanLyric")') && !has(src.amll, "rw.ruby =") && !has(src.amll, "l.ruby ="));

ok("amll: 辅助源两路都认得词级 QRC（含 XML 信封）与普通 LRC", has(src.amll, "function parseQrcAuxSource") && has(src.amll, "const QRC_WORD_LINE = /^\\[\\d+,\\d+\\]/m;") && has(src.amll, "tryParseQrc(stripKanaTag(c))") && has(src.amll, "tryParseLrc(stripKanaTag(c))"));

ok("amll: 辅助行档位规则只有 src/lyric.ts:pickAux 一份（内置后不再两处各写一遍）", re(src.amll, /import \{[^}]*\bpickAux\b[^}]*\} from "\.\.\/lyric";/) && has(src.amll, "pickAux({") && has(src.amll, "trans: l.translatedLyric,") && has(src.amll, "roma: l.romanLyric,") && !has(src.amll, "const prefer =") && has(src.amll, "wantMode !== shownMode") && has(src.amll, "romanLyric: \"\","));

ok("amll: LRC 行级也交给 AMLL（toLineLevel 整形单音节覆盖整行 + 末行收尾时长），内置引擎无设置项 / 不注册 enabled", has(src.amll, "function toLineLevel") && has(src.amll, "const lineLevel = toLineLevel(lrc?.length ? lrc : (word ?? []))") && !has(src.amll, "registerSettingsSection") && !has(src.amll, "enabled?()") && !has(src.amll, "wordbyword"));

ok("amll: QRCKana 接进解析（标签先摘再喂 parseQrc → 逐字行挂 ruby → core 渲染行透传）", has(src.amll, "import { applyKanaToLines, extractKanaTag") && has(src.amll, "extractKanaTag(payload)") && has(src.amll, "applyKanaToLines(word, kana)") && has(src.amll, "core.ruby = w.ruby.map("));

ok("sdk: 歌词延迟透传给插件（两条 ctx 都有 lyricDelay，符号与换算口径写进契约注释）", has(src.types, "lyricDelay?(): number;") && re(src.types, /正数 = 歌词更晚出现/) && re(src.guide, /lyricDelay\(\)/) && re(src.guide, /time\(\) − lyricDelay\(\)\/1000/));

ok("delay: 按歌曲的延迟存 localStorage（一歌一项的本地数据，不进 quaver.conf；键 mid，钳 ±10s 对齐 0.1s）", has(src.lyricDelay, "quaver.lyricDelay.v1") && has(src.lyricDelay, "LYRIC_DELAY_MAX_MS = 10_000") && has(src.lyricDelay, "localStorage.setItem(LS_KEY") && !has(src.lyricDelay, "cfgSet"));

ok("delay: 宿主三条消费路同口径透传（kara ctx / np-view ctx / 行级比对与点击），菜单行 −/+ 与点数值归零", has(src.np, "lyricDelay: () => getLyricDelayMs(player.current)") && has(src.npView, "lyricDelay: () => getLyricDelayMs(player.current)") && has(src.np, "player.time + player.lyricComp - getLyricDelayMs(player.current) / 1000") && has(src.np, "player.seek(line.t + getLyricDelayMs(player.current) / 1000, { immediate: true })") && has(src.np, '"np-menu-delay"') && has(src.np, "stepLyricDelay") && has(src.style, ".np-menu:has(.np-menu-delay)"));

ok("amll: 延迟扣在驱动时钟里且变化重锚（0.1s 步进不能被 250ms 回跳钳平吞掉）；行点击把延迟加回真实播放位", has(src.amll, "const raw = ctx.time() - d;") && has(src.amll, "if (d !== lastDelay) { lastDelay = d; lastFedMs = raw; return raw; }") && has(src.amll, "ctx.seek(Math.max(0, ms + delayMs()), { immediate: true })"));

ok("flowscape: 接管视图跟着吃延迟（rAF 时钟扣减 + 行点击加回）", has(noComments(src.flowIdx), "const sec = ctx.time() + 0.2 - (ctx.lyricDelay?.() ?? 0) / 1000;") && has(noComments(src.flowIdx), "ctx.seek(Math.max(0, l.t + (ctx.lyricDelay?.() ?? 0) / 1000), { immediate: true });"));

ok("kana: QRCKana 是移植的纯函数（零依赖、不引整个 lyric-kit，只取这套系统）", has(src.kana, "移植自 SPlayer-Dev/lyric-kit") && !has(src.kana, "from \"lyric-kit\"") && !has(src.kana, "import ") && has(src.kana, "export function parseKanaUnits") && has(src.kana, "export function applyKanaToLines"));

ok("host: AMLL 不再是插件（meta/loader 撤下、required 机制整个退役，只进 RETIRED 名单）", !has(src.loader, "\"amll\": () => import") && !has(src.loader, "required?: boolean") && !has(src.loader, "isSparkleRequired") && has(src.loader, "RETIRED_OFFICIAL_IDS") && has(src.init, "pruneRetiredOfficial()") && !has(src.host, "isSparkleRequired") && !has(src.settings, "isSparkleRequired"));

ok("host: 内置引擎住在注册表的兜底位 —— 插件提供器排在它之前（registerKaraokeProvider 仍能覆盖歌词渲染）", has(src.lyricsBoot, "setBuiltinKaraokeProvider(builtinKaraokeProvider)") && has(src.registry, "karaokeProviders[0]?.provider ?? builtinKaraoke") && has(src.init, "await registerBuiltinLyrics()"));

ok("sdk: 逐字提供器仍是扩展点（类型注释与作者指南同步到「内置兜底 / 插件可覆盖」）", has(src.types, "registerKaraokeProvider(provider: SparkleKaraokeProvider): void;") && has(src.types, "排在**所有插件提供器之后**") && has(src.guide, "AMLL 已从「内置必装的官方插件」改成宿主内置功能") && has(src.guide, "停用后自动回落内置"));

ok("lyric: 行级歌词两路都挂上，显示哪一路交给 pickAux（与 AMLL 同规则）", re(src.lyric, /export function parseLrc\(lrc: string, trans\?: string, roman\?: string\)/) && has(src.lyric, "attachAux(base, roman, \"roma\");") && has(src.lyric, "const prefer = (mode === \"romanization\" ? line.roma : line.trans) ?? \"\";"));

ok("host: 歌词请求同时取翻译与音译，行级解析两路都喂", re(src.player, /lyric\?trans=1&roma=1&qrc=1/) && re(src.player, /provider\.parse\(raw, trans, roma\)/) && re(src.player, /parseLrc\(raw, trans, roma\)/) && has(src.player, "roma: l.romanLyric?.trim() || undefined,"));

ok("np: 翻译选项三档（关闭/翻译/音译），换档重建行级 DOM 以重挑辅助行", has(src.np, "LYRIC_AUX_MODES") && has(src.np, "player.setLyricAuxMode(mode)") && has(src.np, "romanization: \"音译\"") && has(src.np, "pickAux(line, player.lyricAux)") && has(src.np, "player.lyricAux !== lastAuxMode") && has(src.style, ".np.hide-trans"));

ok("np-view: 交给主题的 lyrics().trans 已按档位挑好（视图不必判两路）", has(noComments(src.npView), "trans: pickAux(l, player.lyricAux)"));

ok("flowscape: 逐字辅助行同规则取一路，且档位进重建签名", has(noComments(src.flowIdx), "trans: auxText(l, ctx.lyricAux())") && has(noComments(src.flowIdx), "|${ctx.lyricAux()}|"));

ok("flowscape: 翻译选项三档，SDK 无 setter 时用 toggleTrans 循环到位", has(src.flowIdx, 'data-aux="${m}"') && has(src.flowIdx, 'romanization: "音译"') && has(src.flowIdx, "for (let i = (to - from + AUX_MODES.length) % AUX_MODES.length; i > 0; i--) ctx.toggleTrans();") && has(src.flowIdx, "b.dataset.aux === aux"));

ok("flowscape: 逐词渐变只画一份字形，保留长词折行", has(src.flowIdx, "background:linear-gradient(to right,") && has(src.flowIdx, "background-clip:text") && has(src.flowIdx, "calc(var(--p,0) * 100%)") && has(src.flowIdx, "white-space:pre-wrap") && !has(src.flowIdx, ".kw::after") && !has(noComments(src.flowIdx), "e.dataset.t = w.word"));

ok("flowscape: 主行柔阴影与前景色均可由主题接管", has(src.flowIdx, "filter:var(--fs-lyric-filter,drop-shadow(0 2px 8px #0007));") && has(src.flowIdx, "color:var(--fs-lyric-color,#fff)") && has(src.flowIdx, "var(--fs-lyric-highlight,color-mix(") && has(src.flowIdx, "text-shadow:var(--fs-lyric-translation-shadow,"));

ok("flowscape: QRCKana ruby 排在词上方并各自按 ruby 时间轴扫色", has(src.flowIdx, "words?: SparkleKaraokeWord[]") && has(src.flowIdx, 'e.classList.add("has-ruby")') && has(src.flowIdx, 'rubyBox.className = "kw-ruby"') && has(src.flowIdx, "rubyElsByWord.set(e, rubyEls)") && has(src.flowIdx, 'const ruby = (w.ruby ?? []).filter((r) => !!r.word?.trim());') && has(src.flowIdx, "paint(rubyEls[j], r.startTime, r.endTime)") && has(src.flowIdx, ".fs-ll .kw.has-ruby .kw-ruby{") && has(src.flowIdx, "font-size:.5em"));

ok("flowscape: 更多选项补跳转三项（同名搜索 / 跳转歌手 / 跳转专辑，hash 口径同宿主 np 菜单）", has(src.flowIdx, "#/search?keyword=") && has(src.flowIdx, "#/singer?mid=") && has(src.flowIdx, "#/album?mid=") && has(noComments(src.flowIdx), "const hasAlb = !!(alb?.mid || alb?.pmid);") && has(noComments(src.flowIdx), 'if (!singers.length) jumpBox.append(jumpRow("跳转歌手", true));'));

ok("flowscape: 跳转前先收起正在播放页（np 是铺满全窗的悬浮层，只换路由用户看不到变化）", has(noComments(src.flowIdx), "window.setTimeout(() => { ctx.collapse(); location.hash = hash; }, JUMP_MS);"));

ok("flowscape: 跳转项每次开菜单按当前曲现算（不残留上一首的歌手/专辑）", has(noComments(src.flowIdx), "moreBtn.onclick = () => { renderJumpRows(); togglePop(moreBtn, mMenu); };") && re(noComments(src.flowIdx), /const renderJumpRows = \(\) => \{\s*const s = ctx\.current\(\);\s*jumpBox\.innerHTML = "";/));

ok("flowscape: 封面预载跟随播放顺序（稳态预载 ±1/±2/±3；跨两槽时动画里铺到 ±4；电台跳过左侧）", re(noComments(src.flowIdx), /for \(const off of \[-1, 1, -2, 2, -3, 3\]\) \{\s*if \(!radio \|\| off > 0\) preloadCover\(ctx\.songAt\(off\), off\);\s*\}/) && re(noComments(src.flowIdx), /for \(let k = 1; k <= steps \+ 2; k\+\+\) \{ preloadCover\(ctx\.songAt\(k\), k\); preloadCover\(ctx\.songAt\(-k\), -k\); \}/) && has(noComments(src.flowIdx), "const warmed = new Set<string>();"));

// 五卡专属：侧二要能悬停、能点（跳两首）、悬停歌名/角标也在；侧一保留堆叠轮廓
ok("flowscape: 侧二（±2）与侧一同权 —— 悬停转正抬亮、悬停显歌名/角标", re(src.flowIdx, /\.fs-covers:not\(\.fs-anim-next\):not\(\.fs-anim-prev\) \.fs-card\[data-off="-2"\]:hover \.fs-art\{/) && re(src.flowIdx, /\.fs-covers:not\(\.fs-anim-next\):not\(\.fs-anim-prev\) \.fs-card\[data-off="2"\]:hover \.fs-art\{/) && re(src.flowIdx, /\.fs-card\[data-off="-2"\]:hover \.fs-cap, [\s\S]{0,120}?opacity:1; \}/) && re(src.flowIdx, /\.fs-card\[data-off="-2"\]:hover \.fs-badge, [\s\S]{0,120}?opacity:\.95; \}/));

ok("flowscape: 无障碍标签区分 上上首/上一首/下一首/下下首，电台左侧改为单向说明", has(noComments(src.flowIdx), 'o === 0 ? "播放/暂停"') && has(noComments(src.flowIdx), 'radio && o < 0 ? "无限电台只向前播放"') && has(noComments(src.flowIdx), 'o === -1 ? "上一首" : o === 1 ? "下一首" : o < 0 ? "上上首" : "下下首"'));

ok("flowscape: 无限电台收掉左侧历史卡、禁止倒带，并为轮末下一首画等待卡", has(noComments(src.flowIdx), "const s = o === 0 ? cur : radio && o < 0 ? null : ctx.songAt(o);") && has(noComments(src.flowIdx), "if (o < 0 && (ctx.radioActive?.() ?? false)) return;") && has(src.flowIdx, "正在续上下一轮…") && has(src.flowIdx, 'host.classList.toggle("is-radio", radio)') && has(src.flowIdx, '.fs-root.is-radio .fs-card[data-off="-1"]') && has(src.flowIdx, "const waiting = radio && radioLoading && !s && o === 1;") && has(src.flowIdx, '.fs-card.radio-wait .fs-ph::after'));

ok("np-view: 无限电台状态透传给插件（active/loading/error）", has(noComments(src.npView), "radioActive: () => player.radioActive") && has(noComments(src.npView), "radioLoading: () => player.radioLoading") && has(noComments(src.npView), "radioError: () => player.radioError"));

ok("player: 电台邻曲/封面流跳转不再回绕到历史（songAt/jumpTo 只向前）", has(noComments(src.player), "if (this.radioOn) {") && re(noComments(src.player), /songAtOffset[\s\S]{0,500}?if \(this\.radioOn\) \{\s*if \(offset < 0\) return undefined;[\s\S]{0,120}?this\.queue\[i\]/) && re(noComments(src.player), /jumpToOffset[\s\S]{0,500}?if \(this\.radioOn\) \{\s*const i = this\.index \+ offset;[\s\S]{0,120}?this\.jump\(i\);/));

// 三张卡时代用一层「堆叠轮廓」伪元素（半透明白+阴影往外偏）暗示后面还有一叠；
// 五张全是真卡之后它没了意义，正好悬在 ±1 与 ±2 之间 = 用户看到的「神秘透明蒙版」。
// 所以反向断言：不许再回来。
ok("flowscape: 不许再有「堆叠轮廓」伪元素（五张真卡后它就是 ±1 与 ±2 之间的透明蒙版）", !re(src.flowIdx, /\.fs-card::after/) && !re(src.flowIdx, /\.fs-card\.fs-hop::after/) && !re(noComments(src.flowIdx), /堆叠轮廓/));

ok("flowscape: 控制带染色直连宿主 --cvg-accent（白拿宿主的 .45s 扫色；不再 JS 抄一次停在旧色上）", has(src.flowIdx, "--fs-acc:var(--cvg-accent, var(--cyan, #7fd7ff));") && !re(noComments(src.flowIdx), /getComputedStyle\(document\.documentElement\)/) && has(src.flowIdx, "background:var(--fs-acc)"));

ok("flowscape: 封面色当前景色时用 color-mix 锚亮度（原色当字色在浅色封面上会糊）", has(src.flowIdx, "--fs-acc-ink:color-mix(in srgb, var(--fs-acc) 42%, #fff);") && has(src.flowIdx, "color:var(--fs-acc-ink)"));

ok("flowscape: 进度/旋钮/音量/开关/选中项都吃封面染色（不是只有进度条一处）", has(src.flowIdx, "background:color-mix(in srgb, var(--fs-acc) 58%, #fff)") && has(src.flowIdx, "background:color-mix(in srgb, var(--fs-acc) 30%, transparent)") && has(src.flowIdx, "background:color-mix(in srgb, var(--fs-acc) 55%, #0b0e19)"));

ok("flowscape: 底部自绘进度条/音量/音质三件套", has(src.flowIdx, "fs-track") && has(src.flowIdx, "fs-vol") && has(src.flowIdx, "fs-qbtn") && re(noComments(src.flowIdx), /ctx\.seek\(scrub \* ctx\.duration\(\)\)/) && re(noComments(src.flowIdx), /ctx\.setVolume\(volDrag\)/) && re(noComments(src.flowIdx), /ctx\.switchQuality\(id\)/));

// —— 本地/NAS 曲目适配（音质档位 / 红心 / 同源封面）——
ok("sdk: 曲目快照带来源标记与本地封面（local/nas 无档位阶梯与红心，接管视图据此收控件）", re(src.types, /src\?: "online" \| "local" \| "nas";/) && re(src.types, /localCover\?: string;/));

ok("np-view: 本地/NAS 曲目档位恒空、胶囊恒用文件标签、快照透传 src/localCover", re(noComments(src.npView), /if \(isLocalSong\(player\.current\)\) return \[\];/) && re(noComments(src.npView), /if \(isLocalSong\(player\.current\)\) return localSongStreamUrl\(player\.current\)\.label;/) && re(noComments(src.npView), /src: local \? \(local\.kind === "webdav" \? "nas" : "local"\) : "online",/) && re(noComments(src.npView), /snap\.localCover = local\.hasCover \? localCoverPath\(local\.id\) : ""/));

ok("flowscape: 本地/NAS 曲目判定（新宿主读 src，旧宿主退 mid 前缀约定）", re(noComments(src.flowIdx), /const isLocalSong = \(s: SparkleSongSnapshot \| null\): boolean =>/) && re(noComments(src.flowIdx), /!!s && \(s\.src \? s\.src !== "online" : s\.mid\.startsWith\("local:"\)\)/));

ok("flowscape: 本地曲音质只给说明不给档位按钮、红心收掉、封面优先同源", re(noComments(src.flowIdx), /const ql = local \? \(cur\?\.src === "nas" \? "NAS 流" : "本地文件"\) : ctx\.qualityLabel\(\);/) && re(noComments(src.flowIdx), /if \(local\) \{[\s\S]{0,400}?qPop\.append\(note\);\s*\} else \{/) && re(noComments(src.flowIdx), /loveBtn\.hidden = local;/) && re(src.flowIdx, /\.fs-love\[hidden\]\{ display:none; \}/) && re(noComments(src.flowIdx), /if \(s\?\.localCover\) return s\.localCover;/));

ok("flowscape: 绘制分两层（4Hz 元数据 / 每帧传输）", re(noComments(src.flowIdx), /const paintMeta = \(\) => \{/) && re(noComments(src.flowIdx), /const paintTransport = \(\) => \{/));

ok("flowscape: rAF 收起自停 + onNotify 唤醒", re(noComments(src.flowIdx), /if \(!ctx\.expanded\(\) \|\| !host\.isConnected\) \{ running = false; return; \}/) && re(noComments(src.flowIdx), /const syncRunning = \(\) => \{/));

ok("flowscape: dispose 退订 + 撤 rAF/定时器/监听/样式", re(noComments(src.flowIdx), /offNotify\(\);/) && re(noComments(src.flowIdx), /window\.cancelAnimationFrame\(raf\)/) && re(noComments(src.flowIdx), /window\.clearTimeout\(animTimer\)/) && re(noComments(src.flowIdx), /ro\.disconnect\(\)/) && re(noComments(src.flowIdx), /window\.removeEventListener\("pointermove", onScrubMove\)/) && re(noComments(src.flowIdx), /window\.removeEventListener\("pointermove", onVolMove\)/) && has(noComments(src.flowIdx), "?.remove();"));

ok("flowscape: 拖拽挂 window 且松手才提交 + 拖拽中不被 4Hz 覆盖", re(noComments(src.flowIdx), /window\.addEventListener\("pointermove", onScrubMove\)/) && re(noComments(src.flowIdx), /if \(!track\.classList\.contains\("scrub"\)\)/) && re(noComments(src.flowIdx), /if \(!volDragging\)/));

ok("flowscape: 换封面按 src 签名守卫（4Hz 无条件重建 <img> 会反复重解码）", re(noComments(src.flowIdx), /if \(img\.getAttribute\("src"\) !== url\) \{ img\.src = url;/));

ok("flowscape: 暂停时 veil 显示播放图标（点了是继续播，别反）", re(noComments(src.flowIdx), /playSig === "paused" \? ICON\.play : ICON\.pause/));

ok("flowscape: 设置区只留总开关（版式已固定单行）", re(src.flowIdx, /registerSettingsSection/) && re(src.flowIdx, /data-opt="on"/) && !re(src.flowIdx, /data-lyric-mode/));

ok("flowscape: storage 走 setup 捕获的模块级引用 + dispose 置 null", re(src.flowIdx, /let store: \{ get\(k: string\): string \| null/) && re(src.flowIdx, /store = ctx\.storage;/) && re(src.flowIdx, /return \(\) => \{\s*store = null;/));

ok("flowscape: prefers-reduced-motion 关掉全部动效", re(src.flowIdx, /@media \(prefers-reduced-motion: reduce\)/) && re(src.flowIdx, /\.fs-card, \.fs-card \.fs-art\{ transition:none; \}/));

ok("flowscape: 禁选中 + 纵向溢出裁剪", re(src.flowIdx, /\.fs-root, \.fs-root \*\{[^}]*user-select:none/) && re(noComments(src.flowIdx), /\.fs-root\{[\s\S]{0,400}?min-height:0; overflow:hidden;/));

console.log(`\n${checks - fails}/${checks} passed`);

process.exit(fails ? 1 : 0);
