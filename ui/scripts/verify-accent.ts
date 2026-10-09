// Quaver — 系统强调色探测（electron/accent.ts）的护栏。跑： node scripts/verify-accent.ts
//
// 两头抓：
//   • 纯逻辑：各来源的解析函数（HEX 规范化 / KDE 三元组 / 宽松 JSON 抽色 / GNOME 命名色 /
//     GTK css / macOS / Windows）与 systemAccent 的来源优先级（注入 env + 假子进程，零真实 IO）。
//   • 源码级接线：/api/accent 在两个服务端（src/relay.ts 与 electron/native-server.ts）都有
//     同构实现、渲染层薄封装在 src/lib/accent.ts、探测模块没有 Electron 依赖。
//
// 反向断言（把「回归写法」当输入）防正则失配让断言永远为真 —— 本仓库踩过 verify 脚本自毁。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accentPayload,
  extractAccent,
  gtkCssAccent,
  newestFile,
  noctaliaPalettePaths,
  noctaliaTemplateOutputs,
  normalizeHex,
  parseGnomeAccent,
  parseMacAccent,
  parseRGBTriple,
  parseWindowsAccent,
  systemAccent,
} from "../electron/accent.ts";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const UI = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(join(UI, rel), "utf8");

// ================= 字面量 =================
section("HEX 规范化与三元组");
eq("#ffffff", normalizeHex("#ffffff"), "#ffffff");
eq("#fff 展开", normalizeHex("fff"), "#ffffff");
eq("大写归小写", normalizeHex("#A6E22E"), "#a6e22e");
eq("8 位丢 alpha（有些模板会带）", normalizeHex("#a6e22e88"), "#a6e22e");
eq("裸色名不合法", normalizeHex("cyan"), null);
eq("空串不合法", normalizeHex(""), null);
eq("KDE 三元组 → hex", parseRGBTriple("61, 174, 233"), "#3daee9");
eq("KDE 三元组越界不合法", parseRGBTriple("300,0,0"), null);
eq("KDE 三元组空串", parseRGBTriple(""), null);

// ================= 宽松 JSON 抽色 =================
section("extractAccent（各工具的 JSON 形状）");
// Noctalia v4 / 社区配色：{"dark":{"mPrimary":…},"light":{"mPrimary":…}}
const noctalia = JSON.stringify({
  dark: { mPrimary: "#a6e22e", mSurface: "#272822" },
  light: { mPrimary: "#111111", mSurface: "#f8f8f2" },
});
eq("Noctalia 形状 + dark", extractAccent(noctalia, "dark"), "#a6e22e");
eq("Noctalia 形状 + light（mode 决定挑哪支）", extractAccent(noctalia, "light"), "#111111");
// matugen 模板形状：{"primary":{"dark":{"color":…},"light":{"color":…}}}
eq("matugen 形状（嵌套 color 键）",
  extractAccent(JSON.stringify({ primary: { dark: { color: "#123456" }, light: { color: "#654321" } } }), "light"), "#654321");
// 扁平：{"colors":{"primary":"#…"}}
eq("扁平形状（colors 包一层）", extractAccent(JSON.stringify({ colors: { primary: "#010203" } }), "dark"), "#010203");
eq("键优先级：primary 赢过 accent", extractAccent(JSON.stringify({ accent: "#111111", primary: "#222222" }), "dark"), "#222222");
eq("不认得的键不捡（免得捡到 surface 底色）", extractAccent(JSON.stringify({ surface: "#ff0000", onSurface: "#00ff00" }), "dark"), null);
eq("坏 JSON → null", extractAccent("{oops", "dark"), null);
eq("空对象 → null", extractAccent("{}", "dark"), null);

// ================= 各来源解析 =================
section("GNOME / GTK / macOS / Windows");
eq("gsettings 的 'pink'", parseGnomeAccent("'pink'"), "#d56199");
eq("gsettings 的 'default'（没表态）", parseGnomeAccent("'default'"), null);
eq("gsettings 空输出", parseGnomeAccent(""), null);
eq("GTK css 的 accent_bg_color", gtkCssAccent("@define-color accent_bg_color #3584e4;"), "#3584e4");
eq("GTK css 的 accent_color 兜底", gtkCssAccent("@define-color accent_color #0f0;"), "#00ff00");
eq("GTK css 没有 accent 段", gtkCssAccent("@define-color window_bg_color #fff;"), null);
eq("macOS AppleAccentColor=4（蓝）", parseMacAccent("4"), "#0a84ff");
eq("macOS 空输出（键不存在 = 出厂蓝，交调用方兜底）", parseMacAccent(""), null);
eq("Windows AccentColor（ABGR DWORD，低字节 = R）", parseWindowsAccent("AccentColor    REG_DWORD    0xffe9ae3d"), "#3daee9");
eq("Windows ColorizationColor（AARRGGBB）兜底", parseWindowsAccent("ColorizationColor    REG_DWORD    0xcc3daee9"), "#3daee9");
eq("Windows 都没有 → null", parseWindowsAccent("没匹配上"), null);

// ================= systemAccent 的来源优先级（注入 env，零真实 IO） =================
section("systemAccent 来源优先级");
const tmp = mkdtempSync(join(tmpdir(), "qaccent-"));
try {
  const confDir = join(tmp, "conf");
  const xdgConf = join(tmp, "xdg-conf");
  const xdgCache = join(tmp, "xdg-cache");
  mkdirSync(confDir); mkdirSync(xdgConf); mkdirSync(join(xdgCache, "matugen"), { recursive: true });
  /** 假子进程：color-scheme 没表态（不干扰 mode），accent-color 由用例自己给。
   *  返回值类型标 any：AccentOpts.run 收的是 spawnSync 的完整形状，测试注入只给用到的那两个字段。 */
  const fakeRun = (accent: string | null) => ((_c: string, a: string[]): any => {
    if (a.includes("color-scheme")) return { stdout: "'default'", error: false };
    if (a.includes("accent-color")) return { stdout: accent ?? "", error: false };
    return { stdout: "", error: true };
  });
  const envOf = (extra: Record<string, string> = {}) => ({
    QUAVER_CONFIG_DIR: confDir, XDG_CONFIG_HOME: xdgConf, XDG_CACHE_HOME: xdgCache,
    XDG_STATE_HOME: join(tmp, "state"),
    // XDG_DATA_HOME 必须指进沙箱：否则会读到真机 ~/.local/share/color-schemes（Noctalia 模板产物）
    XDG_DATA_HOME: join(tmp, "data"),
    XDG_CURRENT_DESKTOP: "", ...extra,
  });

  eq("什么都没有 → null（调用方回落默认青色）",
    systemAccent({ env: envOf(), run: fakeRun(null), fresh: true }), null);

  // 1) Quaver 交接文件最优先（Noctalia / matugen 模板的落点）
  writeFileSync(join(confDir, "system-theme.json"), JSON.stringify({ dark: { primary: "#111111" }, light: { primary: "#222222" } }));
  let hit = systemAccent({ env: envOf(), run: fakeRun(null), fresh: true });
  eq("交接文件最优先", hit && { color: hit.color, source: hit.source }, { color: "#111111", source: "quaver-template" });
  check("命中带回文件路径（排障用）", !!hit?.path && hit.path.endsWith("system-theme.json"), hit?.path);

  // 2) CSS 形态也认
  rmSync(join(confDir, "system-theme.json"));
  writeFileSync(join(confDir, "system-theme.css"), "@define-color accent_bg_color #3daee9;\n");
  hit = systemAccent({ env: envOf(), run: fakeRun(null), fresh: true });
  eq("CSS 形态的交接文件", hit && hit.source, "quaver-template");
  rmSync(join(confDir, "system-theme.css"));

  // 3) Noctalia 的 kcolorscheme 模板产物（color-schemes/*.colors；换配色即重写 —— 实测 Hyprland 也成立）
  const schemes = join(tmp, "data", "color-schemes");
  mkdirSync(schemes, { recursive: true });
  writeFileSync(join(schemes, "noctalia.colors"),
    "[Colors:Selection]\nBackgroundNormal=237,193,72\n");
  hit = systemAccent({ env: envOf(), run: fakeRun(null), fresh: true });
  eq("Noctalia 的 .colors 模板产物（Selection 底 = primary）",
    hit && { color: hit.color, source: hit.source }, { color: "#edc148", source: "noctalia-colors" });

  // 4) Noctalia colors.json（v4 / 社区惯例；.colors 不在时落到这）
  rmSync(schemes, { recursive: true, force: true });
  mkdirSync(join(xdgConf, "noctalia"), { recursive: true });
  writeFileSync(join(xdgConf, "noctalia", "colors.json"), JSON.stringify({ dark: { mPrimary: "#a6e22e" } }));
  hit = systemAccent({ env: envOf(), run: fakeRun(null), fresh: true });
  eq("Noctalia colors.json", hit && { color: hit.color, source: hit.source }, { color: "#a6e22e", source: "noctalia" });

  // 5) matugen 缓存
  rmSync(join(xdgConf, "noctalia"), { recursive: true, force: true });
  writeFileSync(join(xdgCache, "matugen", "colors.json"), JSON.stringify({ primary: "#0b57d0" }));
  hit = systemAccent({ env: envOf(), run: fakeRun(null), fresh: true });
  eq("matugen colors.json", hit && { color: hit.color, source: hit.source }, { color: "#0b57d0", source: "matugen" });

  // 5) KDE：AccentColor（要 XDG_CURRENT_DESKTOP 认账）
  rmSync(join(xdgCache, "matugen"), { recursive: true, force: true });
  writeFileSync(join(xdgConf, "kdeglobals"), "[General]\nAccentColor=61,174,233\n");
  hit = systemAccent({ env: envOf({ XDG_CURRENT_DESKTOP: "KDE" }), run: fakeRun(null), fresh: true });
  eq("KDE AccentColor", hit && { color: hit.color, source: hit.source }, { color: "#3daee9", source: "kde" });
  // 非 KDE 会话不认 kdeglobals（别的桌面残留一份旧配置会带偏）→ 落到 gsettings
  hit = systemAccent({ env: envOf(), run: fakeRun("'teal'"), fresh: true });
  eq("非 KDE 会话不认 kdeglobals，落到 gsettings", hit && { color: hit.color, source: hit.source }, { color: "#2190a4", source: "gnome" });
  rmSync(join(xdgConf, "kdeglobals"));

  // 6) GNOME 命名色
  hit = systemAccent({ env: envOf(), run: fakeRun("'pink'"), fresh: true });
  eq("GNOME 命名色", hit && hit.color, "#d56199");

  // 7) 缓存：1s 内的重复调用不重读盘（改文件也不生效，除非 fresh）
  writeFileSync(join(confDir, "system-theme.json"), JSON.stringify({ primary: "#010203" }));
  const before = systemAccent({ env: envOf(), run: fakeRun("'pink'"), fresh: false });
  eq("命中缓存（读到刚才那份 GNOME 色）", before && before.color, "#d56199");

  eq("accentPayload 的形状", accentPayload({ env: envOf(), run: fakeRun(null), fresh: true }),
    { ok: true, color: "#010203", source: "quaver-template", label: "系统主题交接文件", path: join(confDir, "system-theme.json"), mode: "dark" });
  eq("读不到时 accentPayload 的 color 为 null", accentPayload({ env: envOf({ QUAVER_CONFIG_DIR: join(tmp, "nope") }), run: fakeRun(null), fresh: true }).color, null);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

section("Noctalia palette 路径（source 把关）与模板产物");
{
  const tmp2 = mkdtempSync(join(tmpdir(), "qaccent2-"));
  try {
    const cfg = join(tmp2, "noctalia");
    const state = join(tmp2, "state", "noctalia");
    mkdirSync(join(cfg, "palettes"), { recursive: true });
    mkdirSync(state, { recursive: true });
    const env = { XDG_CONFIG_HOME: tmp2, XDG_STATE_HOME: join(tmp2, "state") };
    eq("没写 source → 只认 v4 的 colors.json（custom_palette 是定义不是活配色）",
      noctaliaPalettePaths(env), [join(cfg, "colors.json")]);
    writeFileSync(join(cfg, "config.toml"), "[theme]\ncustom_palette = \"MyScheme\"\nsource = \"custom\"\n");
    let paths = noctaliaPalettePaths(env);
    eq("source=custom → palettes/<custom_palette>.json 进候选", paths[1], join(cfg, "palettes", "MyScheme.json"));
    writeFileSync(join(cfg, "config.toml"), "[theme]\ncustom_palette = \"MyScheme\"\nsource = \"wallpaper\"\n");
    eq("source=wallpaper → 不认 custom palette（它不会跟着壁纸更新，读了就是「压根不变」的坑）",
      noctaliaPalettePaths(env), [join(cfg, "colors.json")]);
    // 用户模板的 JSON 产物：output_path 里的 ~ 与 $XDG_* 要展开
    writeFileSync(join(cfg, "templates.toml"),
      '[theme.templates.user.q]\noutput_path = "$XDG_CONFIG_HOME/noctalia/out.json"\n');
    eq("用户模板的 JSON 产物进候选（$XDG_* 展开）",
      noctaliaTemplateOutputs(env), [join(tmp2, "noctalia", "out.json")]);
    eq("目录不存在 → 模板产物为空", noctaliaTemplateOutputs({ XDG_CONFIG_HOME: join(tmp2, "nope") }), []);
    // newestFile：多份取最后被写的（Noctalia 每次换配色重写 .colors）
    const schemes = join(tmp2, "share", "color-schemes");
    mkdirSync(schemes, { recursive: true });
    writeFileSync(join(schemes, "a.colors"), "");
    eq("newestFile：目录里一份 → 那一份", newestFile(schemes, ".colors"), join(schemes, "a.colors"));
    writeFileSync(join(schemes, "b.colors"), "");
    eq("newestFile：多份取最新", newestFile(schemes, ".colors"), join(schemes, "b.colors"));
    eq("newestFile：目录不存在 → null", newestFile(join(schemes, "nope"), ".colors"), null);
  } finally {
    rmSync(tmp2, { recursive: true, force: true });
  }
}

// ================= 源码接线 =================
section("源码接线 · /api/accent 与渲染层");
const relay = src("src/relay.ts");
const nserver = src("electron/native-server.ts");
const rAccent = src("src/lib/accent.ts");
const eAccent = src("electron/accent.ts");

check("relay 有 /api/accent（dev/preview）", relay.includes('if (path === "accent")') && relay.includes("accentPayload()"));
check("native-server 有 /api/accent（打包态，同构实现）", nserver.includes('sub === "/accent"') && nserver.includes("accentPayload()"));
check("两个服务端都标注了同构实现", relay.includes("native-server.ts 有同构实现") && nserver.includes("src/relay.ts 有同构实现"));
check("渲染层薄封装在 src/lib/accent.ts（有缓存 + 轮询 + 订阅）",
  rAccent.includes('"/api/accent"') && /export function currentAccent/.test(rAccent)
  && /export function watchAccent/.test(rAccent) && /setInterval/.test(rAccent));
check("轮询只在有人订阅时开、最后一人退订就停（不养常驻定时器）",
  /if \(!timer\)/.test(rAccent) && /if \(!listeners\.size && timer\)/.test(rAccent));
check("值没变不广播（轮询空转不该唤醒订阅方）", /prev\.color === now\.color/.test(rAccent));
check("响应里的 color 过一道再收（探测端规范过，这里守一道）", /\^#\[0-9a-f\]\{6\}\$/.test(rAccent));
check("accent.ts 没有 Electron 依赖（dev 中间件与单测都要能 import）",
  !/from ["']electron["']/.test(eAccent) && eAccent.includes('from "./config.ts"') && eAccent.includes('from "./systheme.ts"'));
check("探测模块复用 systheme 的既定口径（iniValue / gtkCssNewest / readSystemTheme）",
  ["iniValue", "gtkCssNewest", "readSystemTheme"].every((f) => eAccent.includes(f)));

// —— 安全口径：候选路径写死，不接受渲染层传路径 ——
check("候选路径全写死：accentPayload 不接受路径参数（渲染层传不进来）",
  accentPayload.length === 0
  && accentPayload({ run: ((_c: string, _a: string[]) => ({ stdout: "", error: true })) as never }).ok === true);
check("设置页没把任何用户输入喂给 accent 通路",
  !src("src/views.ts").includes("api/accent?") && src("src/views.ts").includes('from "./lib/accent"'));
check("tint.ts 只从 lib/accent 拿色值（自己不发请求、不拼路径）",
  src("src/lib/tint.ts").includes('from "./accent"') && !/fetch\(|["']\/api\/accent["']/.test(src("src/lib/tint.ts")));

// ================= 反向自证 =================
section("反向自证（回归写法必须能被逮住）");
check("…反向：mode 判断写死 dark 会被逮住",
  extractAccent(JSON.stringify({ dark: { primary: "#111111" }, light: { primary: "#222222" } }), "light") === "#222222");
check("…反向：normalizeHex 原样透传 8 位色（不丢 alpha）会被逮住", normalizeHex("#3daee900") !== "#3daee900");
check("…反向：normalizeHex 放过裸色名会被逮住", normalizeHex("cyan") === null);
check("…反向：accent.ts 开始 import electron 会被逮住", !/from ["']electron["']/.test(eAccent));
check("…反向：relay 的 accent 路由被改名会被逮住", !relay.includes('if (path === "accentx")'));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-accent: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
