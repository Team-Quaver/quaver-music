// Quaver — 系统深浅色探测（electron/systheme.mjs）单测：纯 Node，不需要 Electron / 桌面环境。
// 跑：  node scripts/verify-systheme.mjs
//
// 这层是「跟随系统」能不能用的全部逻辑：解析各桌面的真相来源 → 交主进程写进 nativeTheme。
// 解析错一个字（段名大小写、行内注释、亮度阈值）在界面上就是「系统切了但应用不动」，
// 从 UI 上完全看不出是哪一步断的 —— 所以这里用真文件真解析，不写正则对源码。
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gsettingsColorScheme, gtkCssTheme, gtkCssThemeFromDirs, gtkTheme, iniValue, isLightHex,
  isLightRGB, kdeTheme, parseColorScheme, readMacShellTheme, readSystemTheme, watchSystemTheme,
} from "../electron/systheme.mjs";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// 真实取样（KDE BreezeLight / Breeze Dark 的窗口底色就长这样）
const KDE_LIGHT = [
  "[General]",
  "ColorScheme=BreezeLight",
  "Name=noctalia",
  "",
  "[Colors:Window]",
  "BackgroundAlternate=227,229,231",
  "BackgroundNormal=239,240,241",
  "ForegroundNormal=35,38,41",
  "",
].join("\n");
const KDE_DARK = KDE_LIGHT.replace("BackgroundNormal=239,240,241", "BackgroundNormal=30,32,36");
// 只有 Colors:View、没有 Colors:Window 的方案（少数）靠兜底读
const KDE_VIEW_ONLY = "[Colors:View]\nBackgroundNormal=24,26,30\n";
const GTK_LIGHT = "[Settings]\ngtk-theme-name=adw-gtk3\ngtk-application-prefer-dark-theme=false\n";
const GTK_DARK = "[Settings]\ngtk-theme-name=Adwaita-dark\ngtk-application-prefer-dark-theme=false\n";
const GTK_FORCE_DARK = "[Settings]\ngtk-theme-name=adw-gtk3\ngtk-application-prefer-dark-theme=true\n";
const GTK_BARE = "[Settings]\ngtk-font-name=Noto Sans 10\n";

const ROOT = mkdtempSync(join(tmpdir(), "quaver-systheme-"));
const write = (name, text) => { const p = join(ROOT, name); writeFileSync(p, text); return p; };
const kdePath = write("kdeglobals", KDE_LIGHT);
const gtkPath = write("gtk-settings.ini", GTK_LIGHT);

// ——— INI 解析 ———
section("INI 解析");
eq("取值命中", iniValue(KDE_LIGHT, "Colors:Window", "BackgroundNormal"), "239,240,241");
eq("段名大小写不敏感", iniValue(KDE_LIGHT, "colors:window", "backgroundnormal"), "239,240,241");
eq("值里的 = 原样保留", iniValue("[A]\nx=a=b\n", "A", "x"), "a=b");
eq("跨段取不到（[General] 里没有 BackgroundNormal）", iniValue(KDE_LIGHT, "General", "BackgroundNormal"), "");
check("注释行不当键", iniValue("[A]\n# k=v\n; k2=v\nZ=3\n", "A", "k") === "" && iniValue("[A]\n# k=v\nZ=3\n", "A", "Z") === "3");
eq("行内注释被剥掉", iniValue("[A]\nk=v # 说明\n", "A", "k"), "v");
eq("CRLF 与首尾空白归一", iniValue("[A]\r\n  k =  v  \r\n", "A", "k"), "v");
eq("段头被误当键的情况不会发生", iniValue("[A]\n[B]\nBackgroundNormal=1,2,3\n", "B", "BackgroundNormal"), "1,2,3");

// ——— 亮度判据 ———
section("亮度判据 (isLightRGB)");
eq("白 → 浅", isLightRGB("255,255,255"), true);
eq("黑 → 深", isLightRGB("0,0,0"), false);
eq("中灰 127 → 深（阈值 >127）", isLightRGB("127,127,127"), false);
eq("中灰 128 → 浅", isLightRGB("128,128,128"), true);
eq("绿色通道权重最高（Rec.709）", isLightRGB("0,255,0"), true);
eq("带空格也认", isLightRGB(" 239 , 240 , 241 "), true);
eq("越界值 → null", isLightRGB("300,0,0"), null);
eq("非三元组 → null", isLightRGB("239,240"), null);
eq("空串 → null", isLightRGB(""), null);
eq("十六进制（不是 KDE 的格式）→ null，不瞎猜", isLightRGB("#efF0f1"), null);

// ——— KDE / GTK 判据 ———
section("KDE 配色");
eq("BreezeLight → light", kdeTheme(KDE_LIGHT), "light");
eq("深色配色 → dark", kdeTheme(KDE_DARK), "dark");
eq("无 Colors 段 → null", kdeTheme("[General]\nx=1\n"), null);
eq("只有 Colors:View 时靠兜底读出深色", kdeTheme(KDE_VIEW_ONLY), "dark");
eq("BackgroundNormal 是脏值 → null（不硬掰成某一边）", kdeTheme("[Colors:Window]\nBackgroundNormal=?a?\n"), null);

section("GTK 设置");
eq("adw-gtk3 → light", gtkTheme(GTK_LIGHT), "light");
eq("Adwaita-dark → dark", gtkTheme(GTK_DARK), "dark");
eq("prefer-dark=true 直接判深（即使主题名是浅色款）", gtkTheme(GTK_FORCE_DARK), "dark");
eq("只有无关键 → null", gtkTheme(GTK_BARE), null);
eq("空文本 → null", gtkTheme(""), null);

// ——— 优先级：KDE 会话才认 kdeglobals ———
section("来源优先级");
// 注入用底稿：把「真实环境」那几层（gsettings / GTK 配色 css / dconf 库）钉成确定值，
// 免得单测随开发机的桌面状态飘（这层就是干探测的，测它必须自己先把环境关掉）
const base = {
  gtkCssDirs: [], dconfDb: join(ROOT, "none-dconf"), run: () => ({ stdout: "" }),
};
const mk = (o) => ({ kdeGlobals: kdePath, gtkInis: [gtkPath], desktop: "KDE", ...base, ...o });
eq("KDE 会话：以 kdeglobals 为准（GTK 那份是静态快照，忽略）",
  readSystemTheme(mk({ kdeGlobals: write("k1", KDE_DARK), gtkInis: [write("g1", GTK_LIGHT)] })), "dark");
eq("非 KDE 会话：忽略残留的 kdeglobals，走 GTK",
  readSystemTheme(mk({ kdeGlobals: write("k2", KDE_DARK), gtkInis: [write("g2", GTK_LIGHT)], desktop: "GNOME" })), "light");
eq("KDE 会话但 kdeglobals 判不出来 → 落回 GTK",
  readSystemTheme(mk({ kdeGlobals: write("k3", "[General]\nx=1\n"), gtkInis: [write("g3", GTK_DARK)] })), "dark");
eq("两个来源都没有 → null（交回 Electron）",
  readSystemTheme(mk({ kdeGlobals: join(ROOT, "none-kde"), gtkInis: [join(ROOT, "none-gtk")] })), null);
eq("gtk-4.0 也认（gtk-3.0 缺失时）",
  readSystemTheme({ ...base, kdeGlobals: join(ROOT, "none-kde"), gtkInis: [join(ROOT, "none3"), write("g4", GTK_DARK)], desktop: "X" }), "dark");
eq("XDG_CURRENT_DESKTOP 形态各异都认 KDE（KDE / plasmax11 / plasma-wayland）",
  ["KDE", "plasma", "plasma-wayland"].map((d) =>
    readSystemTheme({ ...base, kdeGlobals: write("kx" + d, KDE_DARK), gtkInis: [write("gx" + d, GTK_LIGHT)], desktop: d })),
  ["dark", "dark", "dark"]);
eq("非 KDE 会话（GNOME-Classic）走 GTK，不吃残留的 kdeglobals",
  readSystemTheme({ ...base, kdeGlobals: write("ky", KDE_DARK), gtkInis: [write("gy", GTK_LIGHT)], desktop: "GNOME-Classic" }), "light");

// ——— gsettings color-scheme ———
section("gsettings color-scheme");
eq("prefer-dark → dark", parseColorScheme("'prefer-dark'"), "dark");
eq("prefer-light → light", parseColorScheme("'prefer-light'"), "light");
eq("default = 系统没表态 → null（继续往下问，不当成浅色）", parseColorScheme("'default'"), null);
eq("空 / 垃圾 → null", [parseColorScheme(""), parseColorScheme("blue")], [null, null]);
eq("拿不到 gsettings 时返回 null（不猜）",
  gsettingsColorScheme({ run: () => ({ error: new Error("spawnSync gsettings ENOENT") }) }), null);
eq("有输出就解析（含结尾换行）", gsettingsColorScheme({ run: () => ({ stdout: "'prefer-dark'\n" }) }), "dark");
check("确实问的是 org.gnome.desktop.interface color-scheme", (() => {
  let argv = null;
  gsettingsColorScheme({ run: (bin, args) => { argv = [bin, ...args]; return { stdout: "" }; } });
  return argv?.[0] === "gsettings" && argv.includes("get") && argv.includes("org.gnome.desktop.interface") && argv.includes("color-scheme");
})());
// spawnSync 挂住 = 主进程假死（会话总线半死时真会这样），两层外部命令都必须钉 timeout
check("gsettings 调用带 timeout", (() => {
  let o = null;
  gsettingsColorScheme({ run: (_b, _a, opts) => { o = opts; return { stdout: "" }; } });
  return typeof o?.timeout === "number" && o.timeout > 0;
})());
check("macOS defaults 调用也带 timeout，且非 mac 平台直接不试", (() => {
  let o = null;
  const got = readMacShellTheme({ platform: "darwin", run: (_b, _a, opts) => { o = opts; return { stdout: "Dark" }; } });
  return got === "dark" && typeof o?.timeout === "number" && readMacShellTheme({ platform: "linux" }) === null;
})());

// ——— GTK 配色 css（主题生成器写的产物：Hyprland 这类桌面上它是外壳真底色）———
section("GTK 配色 css");
eq("noctalia 那种深色底 → dark",
  gtkCssTheme("/* Generated by Noctalia */\n@define-color window_bg_color #211d20;\n@define-color window_fg_color #f3f2f3;\n"), "dark");
eq("浅色底 → light", gtkCssTheme("@define-color window_bg_color #fafaf9;"), "light");
eq("theme_bg_color / view_bg_color 也认",
  [gtkCssTheme("@define-color theme_bg_color #111111;"), gtkCssTheme("@define-color view_bg_color #eeeeee;")], ["dark", "light"]);
eq("不认识的命名色 → null（不瞎猜）", gtkCssTheme("@define-color borders_breeze #494449;"), null);
eq("空文本 → null", gtkCssTheme(""), null);
eq("isLightHex 格式校验", [isLightHex("#ffffff"), isLightHex("#000000"), isLightHex("#12345"), isLightHex("rgb(1,2,3)")],
  [true, false, null, null]);

const cssDir = join(ROOT, "gtk-css");
mkdirSync(cssDir, { recursive: true });
writeFileSync(join(cssDir, "old.css"), "@define-color window_bg_color #111111;\n");
writeFileSync(join(cssDir, "new.css"), "@define-color window_bg_color #fdfdfd;\n");
// 显式钉 mtime：两份同毫秒写完的话「谁更新」就不确定了
utimesSync(join(cssDir, "old.css"), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
eq("同目录多份 css：以最后被写的那份为准（旧的深色不该压过新的浅色）", gtkCssThemeFromDirs([cssDir]), "light");
eq("目录不存在 → null（不抛）", gtkCssThemeFromDirs([join(ROOT, "nope-css")]), null);

section("优先级：gsettings → GTK 配色 css → settings.ini");
eq("gsettings 表态时压过 GTK 配色 css",
  readSystemTheme({ ...base, run: () => ({ stdout: "'prefer-light'" }), gtkCssDirs: [cssDir] }), "light");
eq("gsettings 说 default → 退到 GTK 配色 css（Hyprland/Noctalia 的常态）",
  readSystemTheme({ ...base, run: () => ({ stdout: "'default'" }), gtkCssDirs: [cssDir] }), "light");
eq("配色 css 也没有 → 才落到 settings.ini",
  readSystemTheme({ ...base, gtkInis: [write("p1", GTK_FORCE_DARK)] }), "dark");

// ——— 监听：真改文件 → 真回调 ———
section("变化监听");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
{
  const p = write("watch-kdeglobals", KDE_LIGHT);
  const seen = [];
  const stop = watchSystemTheme((t) => seen.push(t), { ...base, kdeGlobals: p, gtkInis: [join(ROOT, "none-gtk")], desktop: "KDE" });
  writeFileSync(p, KDE_DARK);
  await sleep(2200);
  writeFileSync(p, KDE_DARK); // 值没变：不该再回调
  await sleep(2200);
  stop();
  eq("配色切换被抓到（浅 → 深）", seen, ["dark"]);
  check("值没变不回调（免得白刷 nativeTheme）", seen.length === 1, JSON.stringify(seen));

  // 停止后不再回调
  writeFileSync(p, KDE_LIGHT);
  await sleep(2200);
  eq("stop() 之后不再回调", seen, ["dark"]);
}

// 主题生成器写的 css 变了要跟（Hyprland/Noctalia 的真路子：换主题时它重写自己的 css）
{
  const dir = join(ROOT, "watch-css");
  mkdirSync(dir, { recursive: true });
  const css = join(dir, "noctalia.css");
  writeFileSync(css, "@define-color window_bg_color #211d20;\n");
  const seen = [];
  const stop = watchSystemTheme((t) => seen.push(t), { ...base, gtkCssDirs: [dir] });
  writeFileSync(css, "@define-color window_bg_color #fafaf9;\n"); // 深 → 浅
  await sleep(2200);
  stop();
  eq("GTK 配色 css 被重写 → 抓到（深 → 浅）", seen, ["light"]);
}

// 只走 gsettings 的变化：文件 mtime 完全不动，只能靠兜底轮询抓
{
  let scheme = "'prefer-dark'";
  const seen = [];
  const stop = watchSystemTheme((t) => seen.push(t), {
    ...base, run: () => ({ stdout: scheme }), pollMs: 250,
  });
  scheme = "'prefer-light'"; // 没有任何文件被动过
  await sleep(900);
  stop();
  eq("只改 gsettings（文件 mtime 不动）也能跟：兜底轮询抓到 深 → 浅", seen, ["light"]);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-systheme: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
