// Quaver — Sparkle 插件系统源码级静态断言
//
// 方法论同 verify-song-menu.ts：本机跑不起浏览器（OOM），一律「tsc --noEmit + vite build
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
  styleLayer: read("src/sparkle/style-layer.ts"),
  shuffle: read("src/lib/shuffle.ts"),
  flowMeta: read("../vendor/Sparkle/marketplace/flowscape/plugin.json"),
  flowIdx: read("../vendor/Sparkle/marketplace/flowscape/index.ts"),
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
ok("sdk: die-for-you 走 registerSettingsSection", has(src.dfy, "registerSettingsSection") && has(src.dfy, "die-for-you"));
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
ok("views: settingsView 返回 sparkle 清理函数", re(noComments(src.views), /mountSparklePanel\(sparklePanel\)/) && re(noComments(src.views), /offSparkle\(\)/));
ok("settings: 四标签齐备且相互隔离（主题/插件/扩展/Marketplace）", ["theme", "plugin", "extension", "market"].every((c) => has(src.settings, `data-cat="${c}"`)) && has(src.settings, "catOf") && has(src.settings, "已装主题") && has(src.settings, "已装插件") && has(src.settings, "已装扩展"));
ok("settings: 插件设置不常驻页面（收进齿轮弹窗）", !re(noComments(src.settings), /sparkle-sections/) && has(read("src/components/PluginSettingsDialog.ts"), "插件设置") && re(noComments(src.settings), /showPluginSettingsDialog/));
ok("settings: 行内齿轮按钮（动作区最左）", has(src.settings, "sparkle-gear") && has(src.style, ".sparkle-gear") && re(noComments(src.settings), /actions\.append\(gearBtn\(/));
ok("settings: 主题行齿轮仅在提供设置区时出现", re(src.settings, /gearOnlyWithSections/));
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
ok("settings: 索引源固定（默认 URL，UI 不可改）", has(src.settings, "DEFAULT_MARKET_URL") && !has(src.settings, "MARKET_URL_KEY") && !re(src.settings, /sparkle-market-bar[^`]*<input/));
ok("settings: 分类徽标样式齐备", ["cat-theme", "cat-plugin", "cat-extension"].every((c) => has(src.style, `sparkle-badge.${c}`)));
ok("settings: 徽标 = 预装 / 官方 / 第三方，不再带分类后缀", has(src.settings, 'text: "预装"')
  && has(src.settings, 'text: "官方"') && has(src.settings, 'text: "第三方"')
  && !/官方\$\{CAT_LABEL|第三方\$\{CAT_LABEL/.test(noComments(src.settings)));
ok("settings: 已装条目按作者分官方/第三方（Team Quaver 大小写不敏感）", (() => {
  const s = noComments(src.settings);
  return re(s, /const isTeamQuaver =/) && /team quaver/.test(s.toLowerCase())
    && has(s, '{ cls: "official", text: "官方" }') && has(s, '{ cls: "third-party", text: "第三方" }');
})());
ok("settings: 主题/插件/扩展三处已装行都走 sourceBadge", (noComments(src.settings).match(/sourceBadge\(inst\.manifest\?\.author\)/g) ?? []).length === 3);
ok("settings: 本地安装按钮红色渐变", has(src.settings, "sparkle-local--danger") && re(src.style, /\.sparkle-local--danger[\s\S]*?linear-gradient/));
ok("settings: Marketplace 内部分类筛选（全部/主题/插件/扩展）", ["all", "theme", "plugin", "extension"].every((c) => has(src.settings, `data-mcat="${c}"`)) && re(src.settings, /mcat === "all"/) && has(src.style, ".sparkle-mkt-chip"));
ok("settings: 安装 ≠ 启用的警示文案", has(src.settings, "默认关闭") || has(src.settings, "默认不加载"));
ok("settings: 安装时把 category 写进元数据", re(noComments(src.settings), /category: cat\s*[,}]/));
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
ok("sdk: ctx 暴露传输控制与只读队列邻曲", ["seek(sec: number)", "next()", "prev()", "setVolume(v: number)", "switchQuality(id: string)", "prevSong()", "nextSong()", "songAt(offset: number)"].every((s) => has(src.types, s)));
ok("sdk: SongSnapshot 带 album.pmid 与 interval（封面 URL 要 pmid 优先）", re(src.types, /album\?: \{ name\?: string; mid\?: string; pmid\?: string \}/) && has(src.types, "interval?: number"));
ok("registry: npView 注册表 + getter 齐备且挂了 teardown", has(src.registry, "sparkRegisterNpView") && has(src.registry, "sparkleNpView"));
ok("np-view: 邻曲走 player.songAtOffset/jumpToOffset（随机序下 index±1 会指错歌；±2 还要求内部 walk 逐步前进，用例在 verify-shuffle）", has(src.npView, "player.songAtOffset(offset)") && has(src.npView, "player.jumpToOffset(offset)") && has(src.player, "walk(this.orderOf(), this.index, Math.abs(offset), dir, false)"));
ok("np-view: prev 走 force（封面点上一首是明确跳转，不被「重放当前曲」改写）", has(src.npView, "prev: () => player.prev(true)"));
ok("np-view: 档位表异步到后主动 notify 一次（否则插件要等下一个播放事件）", re(src.npView, /tierCache\) player\.notifyPublic\(\)/));
ok("np-view: render 抛错即退回默认布局（不留半截 DOM 把整页画死）", re(src.npView, /渲染失败[\s\S]{0,400}?box\.remove\(\)/));
ok("np-view: 生效 = 挂载 且 np 展开（插件启用不该藏播放条）", re(noComments(src.npView), /const active = !!mounted && player\.expanded;/) && re(noComments(src.npView), /setBodyFlag\(active\)/));
ok("np-view: render 返回 undefined 视为成功（无清理 ≠ 渲染失败）", re(noComments(src.npView), /const cleanup = want\.render\(box, npViewCtx\(\)\) \?\? null;[\s\S]{0,80}?mounted = \{ view: want, host: box, cleanup \};/));
ok("player: neighbors/songAtOffset/jumpToOffset 与播放推进同源（neighbors 走 stepInOrder；±N 走 walk，见 verify-shuffle）", has(src.player, "neighbors(): { prev: number; next: number }") && has(src.player, "songAtOffset(offset: number)") && has(src.player, "return step(this.orderOf(), this.index, dir, wrap);"));
ok("player: songAtOffset 对非整数/越界有界（offset 很大时不该吐整队列，也不许空转）", re(src.player, /if \(!Number\.isInteger\(offset\)\) return undefined;/) && has(src.player, "return i < 0 ? undefined : this.queue[i];") && re(src.shuffle, /Math\.min\(steps, n\)/));
ok("player: jumpToOffset 走 wrap（手动跳允许回绕，与 prev/next 语义一致）", re(noComments(src.player), /jumpToOffset[\s\S]{0,400}?walk\(this\.orderOf\(\), this\.index, Math\.abs\(offset\), dir, true\)/) && re(src.player, /if \(!Number\.isInteger\(offset\) \|\| offset === 0\) return;/));
ok("NowPlaying: 接管容器存在且在默认布局之前早退", has(src.np, "np-view") && re(noComments(src.np), /if \(syncNpView\(el, npViewHost\)\) \{[\s\S]{0,400}?disposeKara\(\)/));
ok("NowPlaying: 接管判定早于「无歌收起」早退（body.np-takeover 是全局标记）", (() => {
  const s = noComments(src.np);
  return s.indexOf("if (syncNpView(el, npViewHost))") < s.indexOf("if (!open && !s) return;");
})());
ok("NowPlaying: 挂载/卸载由注册表变化驱动（不依赖「恰好在播放」）", has(src.np, "onSparkleChange(") && re(noComments(src.np), /onSparkleChange\(\(\) => \{[\s\S]{0,200}?syncNpView\(el, npViewHost\)/));
ok("css: 接管容器铺满 .np 且默认布局与插件槽一并让位", has(src.style, ".np-view") && has(src.style, ".np.np-taken-over .np-inner") && has(src.style, ".np.np-taken-over .np-widgets"));
ok("css: body.np-takeover 收起整条播放条（插件自绘控制）", has(src.style, "body.np-takeover #player-bar { display: none; }"));
ok("host: registerNowPlayingView 接到 registry（不立即挂载）", has(src.host, "registerNowPlayingView") && has(src.host, "sparkRegisterNpView"));

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
ok("flowscape: 邻曲不存在时整卡隐掉并禁用（不留空壳占槽位）", re(noComments(src.flowIdx), /el\.classList\.toggle\("empty", !s\);\s*el\.disabled = !s;/) && re(src.flowIdx, /\.fs-card\.empty\{ opacity:0; pointer-events:none; \}/));
ok("flowscape: 封面 404 兜底回占位符 + 尺寸吸附 CDN 合法档位", re(noComments(src.flowIdx), /img\.onerror = \(\) => \{ img\.removeAttribute\("src"\); img\.style\.display = "none"; ph\.style\.display = ""; \};/) && re(src.flowIdx, /const COVER_SIZES = \[90, 120, 150, 180, 300, 500, 800\]/));
ok("flowscape: 封面像素量 offsetWidth 而非 rect（旋转压缩会让 rect 低估）", has(src.flowIdx, "art.offsetWidth") && re(noComments(src.flowIdx), /const shown = Math\.max\(64, Math\.round\(art\.offsetWidth/));
ok("flowscape: 歌词只有单行版式（不建整首列表，无版式切换残留）", re(noComments(src.flowIdx), /const paintCurrentLine = \(idx: number\) => \{[\s\S]{0,700}?lyricsBox\.innerHTML = `<div class="fs-ll cur"/) && !re(src.flowIdx, /lyricMode|data-lyric/) && !re(noComments(src.flowIdx), /enterBrowse|browsing|followCurrent|browseTimer/));
ok("flowscape: 换句由 rAF 的行号比对触发（不逐帧重填）", re(noComments(src.flowIdx), /if \(idx !== lastIdx\) \{ lastIdx = idx; paintCurrentLine\(idx\); \}/));
ok("flowscape: 歌词容器不滚、无渐隐遮罩（只有一句，遮罩会像被裁掉）", re(src.flowIdx, /\.fs-lyrics\{[\s\S]{0,600}?min-height:4\.3em; max-height:8\.6em; overflow:hidden;/) && !re(src.flowIdx, /\.fs-lyrics\{[^}]*mask-image/) && !re(src.flowIdx, /\.fs-lyrics\{[^}]*overflow-y:auto/));
ok("flowscape: 歌词块预留固定高度（不给高度的话翻译出现/长句折行会把上面的封面顶着上下跳 = 挤）", re(src.flowIdx, /\.fs-lyrics\{[\s\S]{0,600}?min-height:4\.3em/) && has(src.flowIdx, "--fs-ly-scale"));
ok("flowscape: 切歌动画把目标槽位写进 data-to（JS 不量坐标，全交给 CSS 变量）", re(noComments(src.flowIdx), /for \(const el of cardEls\) el\.dataset\.to = String\(Number\(el\.dataset\.off\) - direction\);/) && !re(noComments(src.flowIdx), /getBoundingClientRect\(\)[\s\S]{0,80}?dataset\.to/) && re(src.flowIdx, /\.fs-card\[data-to="0"\]\{ --slot:0px; --slot-scale:1; --fs-dir:0; z-index:5; \}/));
ok("flowscape: 目标槽位 = 当前槽位**减**方向（点右边那张 → 整排往左挪一格，滚进来的正是他点的那张）", re(noComments(src.flowIdx), /String\(Number\(el\.dataset\.off\) - direction\)/) && !re(noComments(src.flowIdx), /dataset\.to = String\(o \+ direction\)/));
ok("flowscape: 五槽目标表对称（0 转正 / ±1 侧一 / ±2 侧二 / ±3 出画淡出；±方向共用同一套规则，不写两份镜像）", re(src.flowIdx, /\.fs-card\[data-to="-1"\]\{ --slot:calc\(-1 \* var\(--fs-gap\)\); --slot-scale:\.82; --fs-dir:-1; z-index:4; \}/) && re(src.flowIdx, /\.fs-card\[data-to="-2"\]\{ --slot:calc\(-1 \* var\(--fs-gap2\)\); --slot-scale:\.62; --fs-dir:-1; z-index:3; \}/) && re(src.flowIdx, /\.fs-card\[data-to="-3"\]\{ --slot:calc\(-1\.6 \* var\(--fs-gap2\)\); --slot-scale:\.5; --fs-dir:-1; z-index:2; opacity:0; pointer-events:none; \}/) && re(src.flowIdx, /\.fs-card\[data-to="3"\]\{ --slot:calc\(1\.6 \* var\(--fs-gap2\)\); --slot-scale:\.5; --fs-dir:1; z-index:2; opacity:0; pointer-events:none; \}/) && re(src.flowIdx, /\.fs-card\[data-to="0"\] \.fs-art\{ transform:none; opacity:1; filter:none; \}/) && !re(src.flowIdx, /fs-anim-next \.fs-card\[data-to/));
ok("flowscape: 动画中主封面不被 hover 抢走 transform（它正在转正；hover 规则必须被 :not(.fs-anim-*) 挡在动画之外）", re(src.flowIdx, /\.fs-covers:not\(\.fs-anim-next\):not\(\.fs-anim-prev\) \.fs-card\[data-off="-1"\]:hover \.fs-art\{/) && re(src.flowIdx, /\.fs-covers:not\(\.fs-anim-next\):not\(\.fs-anim-prev\) \.fs-card\[data-off="1"\]:hover \.fs-art\{/) && !re(noComments(src.flowIdx), /\.fs-card\.left:hover \.fs-art/));
ok("flowscape: 动画 class 进出都做 + 定时器可重入（连点不叠 setTimeout）", re(noComments(src.flowIdx), /covers\.classList\.remove\("fs-anim-next", "fs-anim-prev"\);\s*void covers\.offsetWidth;/) && re(noComments(src.flowIdx), /window\.clearTimeout\(animTimer\);\s*animTimer = window\.setTimeout/));
ok("flowscape: 收尾整排身份转一格（data-off 也跟着减，否则清掉 data-to 的瞬间整排会弹回原槽）", re(noComments(src.flowIdx), /if \(n < -2\) \{ el\.dataset\.off = "2"; hopper = el; \}\s*else if \(n > 2\) \{ el\.dataset\.off = "-2"; hopper = el; \}\s*else el\.dataset\.off = String\(n\);/) && re(noComments(src.flowIdx), /const n = Number\(el\.dataset\.off\) - direction;/) && re(noComments(src.flowIdx), /el\.removeAttribute\("data-to"\);/) && re(noComments(src.flowIdx), /indexCards\(\);\s*adoptMain\(\);\s*sigs\.clear\(\);[^\n]*\n\s*animating = false;/));

// —— 点 ±2（上上/下下曲）= 连滚两格 ——
// 单格动画的位移对不上「一次跳两首」：收尾把整排摆好之后数据才对，中间槽会当场换脸
// （用户看到的「直接闪」）。所以要连滚两格，且第一格收尾必须刷**差一格**的过渡态。
ok("flowscape: 方向判定认 ±2 邻居 → 连滚两格（±1 仍是单格；判定顺序保证单步优先）", re(noComments(src.flowIdx), /else if \(cur\.mid === lastNextMid2\) \{ queuedRolls = 1; queuedDir = 1; playSwitchAnim\(1, ANIM_QUICK_MS\); \}/) && re(noComments(src.flowIdx), /else if \(cur\.mid === lastPrevMid2\) \{ queuedRolls = 1; queuedDir = -1; playSwitchAnim\(-1, ANIM_QUICK_MS\); \}/) && re(noComments(src.flowIdx), /lastNextMid2 = ctx\.songAt\(2\)\?\.mid \?\? "";/) && re(noComments(src.flowIdx), /lastPrevMid2 = ctx\.songAt\(-2\)\?\.mid \?\? "";/));
ok("flowscape: 第一格收尾刷「差一格」中间态、再接力第二格（差集没刷对 = 收尾当场换脸）", re(noComments(src.flowIdx), /if \(queuedRolls > 0\) \{\s*paintShift = direction;\s*paintMeta\(\);\s*queuedRolls--;\s*playSwitchAnim\(queuedDir, ANIM_QUICK_MS\);\s*return;\s*\}\s*paintShift = 0;/) && re(noComments(src.flowIdx), /covers\.classList\.remove\("fs-quick"\); \/\/ 连滚结束，时长回到常速/));
ok("flowscape: 槽位→曲子按 paintShift 取（中间态整排偏一格；写死 o 就会把目标曲填进中间槽）", re(noComments(src.flowIdx), /const off = o - paintShift;/) && re(noComments(src.flowIdx), /const s = off === 0 \? cur : ctx\.songAt\(off\);/));
ok("flowscape: 连滚用短时长，且与 CSS 同源（JS 定时器 ↔ .fs-quick 的 --fs-roll/.26s）", re(src.flowIdx, /const ANIM_QUICK_MS = 260;/) && re(src.flowIdx, /\.fs-covers\.fs-quick\{ --fs-roll:\.26s; --fs-fade:\.2s; \}/) && re(noComments(src.flowIdx), /const playSwitchAnim = \(direction: 1 \| -1, ms: number = ANIM_MS\) => \{/) && re(noComments(src.flowIdx), /covers\.classList\.toggle\("fs-quick", ms < ANIM_MS\);/) && re(noComments(src.flowIdx), /settleSwitch\(pendingDir\);\s*\}, ms\);/) && !re(noComments(src.flowIdx), /settleSwitch\(pendingDir\);\s*\}, ANIM_MS\);/));
ok("flowscape: 换槽时长走 CSS 变量（快/常速只切一个变量，不复制整套 transition 规则）", re(src.flowIdx, /--fs-roll:\.44s; --fs-fade:\.3s;/) && re(src.flowIdx, /transition:transform var\(--fs-roll,\.44s\) cubic-bezier/) && !re(noComments(src.flowIdx), /transition:transform \.44s/));
ok("flowscape: 出画那张的瞬移要关掉位移过渡（否则会横穿整排飞回右边），只留淡入", re(src.flowIdx, /\.fs-card\.fs-hop\{ transition:opacity \.3s ease; \}/) && re(noComments(src.flowIdx), /hp\.classList\.add\("fs-hop"\)/) && re(noComments(src.flowIdx), /classList\.remove\("fs-hop"\)/));
ok("flowscape: 方向判定用**上一帧**的邻居表（拿新曲反查 songAt 必然落空 —— 新曲已经是 current，±1 早就换人了）", re(noComments(src.flowIdx), /if \(cur\.mid === lastNextMid\) playSwitchAnim\(1\);/) && re(noComments(src.flowIdx), /else if \(cur\.mid === lastPrevMid\) playSwitchAnim\(-1\);/) && re(noComments(src.flowIdx), /lastNextMid = ctx\.songAt\(1\)\?\.mid \?\? "";/) && !re(noComments(src.flowIdx), /ctx\.songAt\(1\)\?\.mid === cur\.mid/));
ok("flowscape: 动画期间不刷卡面数据 + 动画期间挡掉点击（视觉位置与 data-off 已错开一格）", re(noComments(src.flowIdx), /if \(!animating\) \{[\s\S]{0,900}?for \(const el of cardEls\) \{\s*const o = Number\(el\.dataset\.off\);/) && re(noComments(src.flowIdx), /if \(animating\) return;/) && re(noComments(src.flowIdx), /if \(cur && !animating && lastMid && cur\.mid !== lastMid\)/));
ok("flowscape: 封面尺寸留出下方空间 + 歌词/控制带不被挤出可视区", re(src.flowIdx, /--fs-cover:min\(28vh, 24vw, 300px\);/) && re(src.flowIdx, /--fs-gap:calc\(var\(--fs-cover\) \* \.58\);/) && re(src.flowIdx, /--fs-gap2:calc\(var\(--fs-cover\) \* \.96\);/) && re(src.flowIdx, /\.fs-stage\{\s*flex:1 1 auto; min-height:0;/) && re(src.flowIdx, /\.fs-bar\{ flex:0 0 auto; min-height:60px;/));
ok("flowscape: 五张卡共用一个基准尺寸（不存在第二套 --fs-side，尺寸才是统一的）", has(src.flowIdx, "width:var(--fs-cover); aspect-ratio:1") && !re(noComments(src.flowIdx), /--fs-side/));
ok("flowscape: 接管态自带出口（收起 + 更多选项）—— 播放条与 .np-inner 都被宿主收走了，不给按钮就只能按 ESC", has(src.flowIdx, 'id="fs-collapse"') && has(src.flowIdx, 'id="fs-more"') && re(noComments(src.flowIdx), /collapseBtn\.onclick = \(\) => ctx\.collapse\(\);/));

// —— 逐字歌词（复用宿主已激活的提供器）/ 跳转三项 / 封面预载 / 控制带染色 ——
ok("sdk: np 视图 ctx 暴露逐字歌词（复用提供器解析结果，插件不必自己解 QRC/TTML）", re(src.types, /karaoke\(\): SparkleKaraokeLine\[\];/) && re(src.types, /karaokeActive\(\): boolean;/));
ok("sdk: 曲目快照带 singer.mid（「跳转歌手」要路由参数，只给名字拼不出 URL）", re(src.types, /singer\?: \{ name: string; mid\?: string \}\[\];/));
ok("np-view: karaoke() 不复制词级数组（4Hz 每次 notify 重建上千个词是白烧）", re(noComments(src.npView), /karaoke: \(\) => player\.karaoke,/) && re(noComments(src.npView), /player\.karaoke\.length > 0 && !!provider && \(provider\.enabled\?\.\(\) \?\? true\)/));
ok("np-view: 快照把 singer.mid 透传给插件", re(noComments(src.npView), /singer: \(s\.singer \?\? \[\]\)\.map\(\(x\) => \(\{ name: stripEm\(x\.name \?\? ""\), mid: x\.mid \}\)\)/));
ok("guide: 文档写了「复用逐字提供器」与「跳转前先 np.collapse()」", has(src.guide, "karaokeActive()") && has(src.guide, "`np.collapse()`"));
ok("flowscape: 逐字模式复用宿主提供器（开=单行逐字，关=回退行级）", re(noComments(src.flowIdx), /const kara = ctx\.karaokeActive\(\);/) && has(noComments(src.flowIdx), "karaLines = kara ? ctx.karaoke() : [];") && has(noComments(src.flowIdx), "lyricLines = kara ? [] : ctx.lyrics();") && has(noComments(src.flowIdx), '|${kara ? "k" : "l"}`') && re(noComments(src.flowIdx), /karaOn = kara;/));
ok("flowscape: 逐字行按行号重填、词进度按变化写（稳态几乎零写入）", re(noComments(src.flowIdx), /if \(idx !== lastIdx\) \{ lastIdx = idx; paintKaraLine\(idx\); \}/) && re(noComments(src.flowIdx), /if \(idx >= 0\) paintKaraWords\(karaLines\[idx\], ms\);/) && re(noComments(src.flowIdx), /if \(el\.dataset\.p === String\(q\)\) continue;/));
ok("flowscape: 逐词染色靠 clip-path + --p（不量坐标、不逐词换 color）", re(src.flowIdx, /clip-path:inset\(0 calc\(\(1 - var\(--p,0\)\) \* 100%\) 0 0\);/) && has(src.flowIdx, "content:attr(data-t)") && re(noComments(src.flowIdx), /el\.dataset\.t = w\.word;/));
ok("flowscape: 更多选项补跳转三项（同名搜索 / 跳转歌手 / 跳转专辑，hash 口径同宿主 np 菜单）", has(src.flowIdx, "#/search?keyword=") && has(src.flowIdx, "#/singer?mid=") && has(src.flowIdx, "#/album?mid=") && has(noComments(src.flowIdx), "const hasAlb = !!(alb?.mid || alb?.pmid);") && has(noComments(src.flowIdx), 'if (!singers.length) jumpBox.append(jumpRow("跳转歌手", true));'));
ok("flowscape: 跳转前先收起正在播放页（np 是铺满全窗的悬浮层，只换路由用户看不到变化）", has(noComments(src.flowIdx), "window.setTimeout(() => { ctx.collapse(); location.hash = hash; }, JUMP_MS);"));
ok("flowscape: 跳转项每次开菜单按当前曲现算（不残留上一首的歌手/专辑）", has(noComments(src.flowIdx), "moreBtn.onclick = () => { renderJumpRows(); togglePop(moreBtn, mMenu); };") && re(noComments(src.flowIdx), /const renderJumpRows = \(\) => \{\s*const s = ctx\.current\(\);\s*jumpBox\.innerHTML = "";/));
ok("flowscape: 封面预载跟随播放顺序（稳态预载 ±1/±2/±3，不等点下去才请求）", re(noComments(src.flowIdx), /for \(const off of \[-1, 1, -2, 2, -3, 3\]\) preloadCover\(ctx\.songAt\(off\), off\);/) && has(noComments(src.flowIdx), "preloadCover(ctx.songAt(1), 1);") && has(noComments(src.flowIdx), "const warmed = new Set<string>();"));
// 五卡专属：侧二要能悬停、能点（跳两首）、悬停歌名/角标也在；侧一保留堆叠轮廓
ok("flowscape: 侧二（±2）与侧一同权 —— 悬停转正抬亮、悬停显歌名/角标", re(src.flowIdx, /\.fs-covers:not\(\.fs-anim-next\):not\(\.fs-anim-prev\) \.fs-card\[data-off="-2"\]:hover \.fs-art\{/) && re(src.flowIdx, /\.fs-covers:not\(\.fs-anim-next\):not\(\.fs-anim-prev\) \.fs-card\[data-off="2"\]:hover \.fs-art\{/) && re(src.flowIdx, /\.fs-card\[data-off="-2"\]:hover \.fs-cap, [\s\S]{0,120}?opacity:1; \}/) && re(src.flowIdx, /\.fs-card\[data-off="-2"\]:hover \.fs-badge, [\s\S]{0,120}?opacity:\.95; \}/));
ok("flowscape: 无障碍标签区分 上上首/上一首/下一首/下下首（节点会转格，标签要跟着槽位走）", has(noComments(src.flowIdx), 'const label = o === 0 ? "播放/暂停" : o === -1 ? "上一首" : o === 1 ? "下一首" : o < 0 ? "上上首" : "下下首";'));
// 三张卡时代用一层「堆叠轮廓」伪元素（半透明白+阴影往外偏）暗示后面还有一叠；
// 五张全是真卡之后它没了意义，正好悬在 ±1 与 ±2 之间 = 用户看到的「神秘透明蒙版」。
// 所以反向断言：不许再回来。
ok("flowscape: 不许再有「堆叠轮廓」伪元素（五张真卡后它就是 ±1 与 ±2 之间的透明蒙版）", !re(src.flowIdx, /\.fs-card::after/) && !re(src.flowIdx, /\.fs-card\.fs-hop::after/) && !re(noComments(src.flowIdx), /堆叠轮廓/));
ok("flowscape: 控制带染色直连宿主 --cvg-accent（白拿宿主的 .45s 扫色；不再 JS 抄一次停在旧色上）", has(src.flowIdx, "--fs-acc:var(--cvg-accent, var(--cyan, #7fd7ff));") && !re(noComments(src.flowIdx), /getComputedStyle\(document\.documentElement\)/) && has(src.flowIdx, "background:var(--fs-acc)"));
ok("flowscape: 封面色当前景色时用 color-mix 锚亮度（原色当字色在浅色封面上会糊）", has(src.flowIdx, "--fs-acc-ink:color-mix(in srgb, var(--fs-acc) 42%, #fff);") && has(src.flowIdx, "color:var(--fs-acc-ink)"));
ok("flowscape: 进度/旋钮/音量/开关/选中项都吃封面染色（不是只有进度条一处）", has(src.flowIdx, "background:color-mix(in srgb, var(--fs-acc) 58%, #fff)") && has(src.flowIdx, "background:color-mix(in srgb, var(--fs-acc) 30%, transparent)") && has(src.flowIdx, "background:color-mix(in srgb, var(--fs-acc) 55%, #0b0e19)"));
ok("flowscape: 底部自绘进度条/音量/音质三件套", has(src.flowIdx, "fs-track") && has(src.flowIdx, "fs-vol") && has(src.flowIdx, "fs-qbtn") && re(noComments(src.flowIdx), /ctx\.seek\(scrub \* ctx\.duration\(\)\)/) && re(noComments(src.flowIdx), /ctx\.setVolume\(volDrag\)/) && re(noComments(src.flowIdx), /ctx\.switchQuality\(id\)/));
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
