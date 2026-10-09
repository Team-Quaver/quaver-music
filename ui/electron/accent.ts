// Quaver — 系统强调色探测（主进程 / dev 中间件共用，纯 Node，可脱离 Electron 单测）
//
// 要解决的事：设置→外观→高亮颜色的第四档「系统强调色」需要一个**源色**。Linux 世界没有统一的
// 强调色 API（GNOME 47 才有 gsettings 那个口子，KDE 在 kdeglobals 里，而 Wayland rice 圈子
// 的桌面外壳 —— Noctalia / 各种 matugen 流水线 —— 是**把算好的 M3 配色写进别的程序的配置文件**）。
// 所以这里按「离用户当前桌面最近的真相」逐层问，拿到一个 #rrggbb 就收工。
//
// 来源与优先级（**关键教训：Noctalia v5 的 wallpaper 配色只活在内存里，不落盘** ——
// `~/.config/noctalia/palettes/<x>.json` 是「custom palette 定义」，source=wallpaper 时它
// 不会被更新；**磁盘上真正跟着换壁纸走的，是 Noctalia 渲染出来的模板产物**）：
//   1. Quaver 专属交接文件  <配置目录>/system-theme.json  —— Noctalia / matugen 的模板写给它（见下）
//   2. 同上 .css 形态       <配置目录>/system-theme.css   —— 只写一行 @define-color accent_bg_color
//   3. Noctalia 用户模板的 JSON 产物（[theme.templates.user.*] 的 output_path，宽松 JSON 抽色）
//   4. Noctalia 的 kcolorscheme 模板产物 ~/.local/share/color-schemes/ 里最新那份 .colors
//      （[Colors:Selection] BackgroundNormal = M3 primary；换壁纸即重写 —— 实测 Hyprland 下也成立）
//   5. Noctalia v4 惯例     ~/.config/noctalia/colors.json（{"dark":{"mPrimary":…}}）
//   6. Noctalia v5 自定义   ~/.config/noctalia/palettes/<custom_palette>.json —— **只在 source=custom 时**
//      （source=wallpaper/builtin 时这份文件不是活的配色，读了就是上面那个「压根不变」的坑）；
//      source=community 时同理只认社区缓存
//   7. matugen              $MATUGEN_COLORS → $XDG_CACHE_HOME/matugen/colors.json（社区惯例路径）
//   8. KDE                  kdeglobals [General] AccentColor（只在 KDE 会话下认账，Plasma 自己写的）
//   9. GNOME                gsettings org.gnome.desktop.interface accent-color（GNOME 47+）
//  10. kdeglobals [Colors:Selection] BackgroundNormal —— 不看会话：Noctalia 的 kcolorscheme
//      在任何桌面下都会把它合并进 kdeglobals；纯 GNOME 没有 kdeglobals，不会被带偏
//  11. GTK 配色 css         @define-color accent_bg_color / accent_color（Noctalia 的 gtk3/gtk4
//      模板写的就是它；Noctalia / matugen / pywal 都会写）
//  12. macOS / Windows      系统设置里的强调色（AppleAccentColor / DWM AccentColor）
//
// JSON 那一层是**宽松**解析：不同工具的形状不一样（{"dark":{"mPrimary":…}}、
// {"primary":{"dark":{"color":…}}}、{"colors":{"primary":"#…"}}），所以不钉 schema，改成
// 「在整棵树里找键名归一化后等于 primary / mPrimary / accent / accent_bg_color 的十六进制值」，
// 并按「键的优先级 → 与当前深浅模式是否一致 → 出现顺序」挑一个。见 extractAccent。
//
// —— 怎么让 Noctalia 把颜色递给 Quaver（推荐，一劳永逸）——
// Noctalia: ~/.config/noctalia/templates.toml 追加
//   [theme.templates.user.quaver]
//   input_path  = "$XDG_CONFIG_HOME/noctalia/templates/quaver-music.json"
//   output_path = "$XDG_CONFIG_HOME/quaver-music/system-theme.json"
// 配一个模板文件 ~/.config/noctalia/templates/quaver-music.json：
//   {
//     "dark":  { "primary": "{{ colors.primary.dark.hex }}" },
//     "light": { "primary": "{{ colors.primary.light.hex }}" }
//   }
// matugen: ~/.config/matugen/config.toml 追加同名的 [templates.quaver]，output_path 指同一个文件
// （matugen 的模板语法相同：{{ colors.primary.dark.hex }}）。
// 两条路都落在同一个文件上，Quaver 每 10s 读一次，换壁纸/换配色即时跟随，不用重启。
//
// 安全口径：候选路径**全是写死的**（配置目录 + XDG 三处 + 各工具自己的约定），渲染层传什么都
// 不参与拼路径 —— 与 /api/bg 同一条规矩。渲染层只能问「有没有」，不能指定读哪。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { configDir, type Env } from "./config.ts";
import { gtkCssNewest, iniValue, readSystemTheme } from "./systheme.ts";

/** 一处命中：色值 + 来源（source 给程序判断，label 直接进设置页文案）。 */
export interface AccentHit {
  /** 规范小写 6 位 `#rrggbb` */
  color: string;
  /** 来源 id：quaver-template / noctalia / noctalia-palette / noctalia-community / matugen / kde / gnome / gtk / macos / windows */
  source: string;
  /** 来源的可读名（设置页提示用） */
  label: string;
  /** 从哪份文件/哪个命令读到的（排障用；渲染层只是显示，不参与任何路径拼接） */
  path: string;
}

/** 探测结果。opts 全为测试注入用（默认走真实路径、真实环境变量）。 */
export interface AccentOpts {
  /** 注入的环境表（XDG_* / MATUGEN_COLORS / NOCTALIA_* / XDG_CURRENT_DESKTOP） */
  env?: Env;
  /** 注入的平台（默认 process.platform） */
  platform?: NodeJS.Platform;
  /** 起子进程（gsettings / defaults / reg.exe）用；测试注入假实现 */
  run?: typeof spawnSync;
  timeoutMs?: number;
  /** 跳过缓存的强制重读（默认 false） */
  fresh?: boolean;
}

// —— 颜色字面量 ——

/** `#rgb` / `#rrggbb` / `#rrggbbaa` → 规范小写 6 位；认不出返回 null（8 位丢 alpha）。 */
export function normalizeHex(v: unknown): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(v ?? "").trim().replace(/^['"]|['"]$/g, ""));
  if (!m) return null;
  const t = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return "#" + t.toLowerCase();
}

/** KDE 的 `AccentColor=61,174,233`（以及 [Colors:Selection] 的 BackgroundNormal 同格式）→ `#rrggbb`。 */
export function parseRGBTriple(v: unknown): string | null {
  const m = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const [r, g, b] = m.slice(1).map(Number);
  if (r > 255 || g > 255 || b > 255) return null;
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}

// —— JSON（宽松解析） ——

/** 键名归一化：小写 + 去掉非字母（`mPrimary` / `m_primary` / `accent-bg-color` 都归到一起）。 */
const normKey = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");

/** 认得的「强调色」键，值 = 优先级（小的赢）。其余键一律不算数（免得捡到 surface 之类的底色）。 */
const ACCENT_KEY_RANK: Record<string, number> = {
  primary: 0,
  mprimary: 1,
  accent: 2,
  accentcolor: 3,
  accentbgcolor: 4,
};

interface Candidate {
  /** 归一化后的键名（一定是 ACCENT_KEY_RANK 里有的） */
  key: string;
  /** 路径上离得最近的 dark / light 段（没有 = ""） */
  mode: "dark" | "light" | "";
  color: string;
}

function walkJSON(node: unknown, key: string | null, mode: "dark" | "light" | "", out: Candidate[]) {
  if (typeof node === "string") {
    const color = normalizeHex(node);
    if (color && key) out.push({ key, mode, color });
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) walkJSON(v, key, mode, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [rawK, v] of Object.entries(node as Record<string, unknown>)) {
    const nk = normKey(rawK);
    const isAccent = nk in ACCENT_KEY_RANK;
    // 只有「认得的强调色键」才接管 key —— 否则 {"colors":{"primary":…}} 里的 colors 会把
    // 内层的 primary 名字顶掉。mode 段同理：只在恰好是 dark/light 时才改。
    walkJSON(v, isAccent ? nk : key, nk === "dark" ? "dark" : nk === "light" ? "light" : mode, out);
  }
}

/**
 * 从任意 JSON 文本里捞强调色。`mode` 是当前深浅（用来在 {"dark":…,"light":…} 里挑对那一支）。
 * 排序：键优先级 → 与 mode 一致（0）/ 没表态（1）/ 相反（2）→ 出现顺序。认不出返回 null。
 */
export function extractAccent(text: string, mode: "dark" | "light"): string | null {
  let data: unknown;
  try { data = JSON.parse(String(text ?? "")); } catch { return null; }
  const out: Candidate[] = [];
  walkJSON(data, null, "", out);
  if (!out.length) return null;
  const score = (c: Candidate) => (c.mode === mode ? 0 : c.mode === "" ? 1 : 2);
  const best = out
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      ACCENT_KEY_RANK[a.c.key] - ACCENT_KEY_RANK[b.c.key]
      || score(a.c) - score(b.c)
      || a.i - b.i)[0].c;
  return best.color;
}

// —— 各来源的纯解析 ——

/** GNOME 47+ 的 accent-color 命名色（org.gnome.libadwaita 的官方九色）→ 色值。 */
export const GNOME_ACCENTS: Record<string, string> = {
  blue: "#3584e4",
  teal: "#2190a4",
  green: "#3a944a",
  yellow: "#c88800",
  orange: "#ed5b00",
  red: "#e62d42",
  pink: "#d56199",
  purple: "#9141ac",
  slate: "#6f8396",
};

/** `gsettings get … accent-color` 的输出（`'blue'`）→ `#3584e4`；'default' / 认不出返回 null。 */
export function parseGnomeAccent(raw: unknown): string | null {
  const v = String(raw ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return GNOME_ACCENTS[v] ?? null;
}

/** GTK 配色 css 里的强调色：libadwaita 的 accent_bg_color 优先，accent_color 兜底。 */
export function gtkCssAccent(text: string): string | null {
  const src = String(text ?? "");
  for (const key of ["accent_bg_color", "accent_color"]) {
    const m = new RegExp(`@define-color\\s+${key}\\s+(#[0-9a-fA-F]{3,8})`).exec(src);
    const hex = m ? normalizeHex(m[1]) : null;
    if (hex) return hex;
  }
  return null;
}

/** macOS `AppleAccentColor`（-1..6，键不存在 = 蓝）→ 色值。取值是系统设置里那八个。 */
export function parseMacAccent(stdout: unknown): string | null {
  const v = String(stdout ?? "").trim();
  const table: Record<string, string> = {
    "-1": "#8e8e93", // 多彩（Graphite）
    "0": "#ff5257",  // 红
    "1": "#ff9f0a",  // 橙
    "2": "#ffd60a",  // 黄
    "3": "#28cd41",  // 绿
    "4": "#0a84ff",  // 蓝（出厂档）
    "5": "#a855f7",  // 紫
    "6": "#ff2d55",  // 粉
  };
  if (!/^-?\d+$/.test(v)) return null;
  return table[v] ?? null;
}

/** Windows DWM 的强调色（AccentColor 是 **ABGR** DWORD；ColorizationColor 是 AARRGGBB）→ 色值。 */
export function parseWindowsAccent(output: unknown): string | null {
  const src = String(output ?? "");
  const acc = /accentcolor\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i.exec(src);
  if (acc) {
    const n = parseInt(acc[1], 16) >>> 0;
    // 0x00BBGGRR
    return "#" + [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff].map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  const col = /colorizationcolor\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i.exec(src);
  if (col) {
    const n = parseInt(col[1], 16) >>> 0;
    // 0xAARRGGBB
    return "#" + [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  return null;
}

// —— IO ——

/** 读文本；读不到一律当「没这个来源」（同 systheme 的口径）。 */
function readText(p: string): string {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

const home = () => homedir();
const envPath = (env: Env, key: string, fallback: string) => String(env[key] ?? "").trim() || fallback;
const configHome = (env: Env) => envPath(env, "XDG_CONFIG_HOME", join(home(), ".config"));
const cacheHome = (env: Env) => envPath(env, "XDG_CACHE_HOME", join(home(), ".cache"));
const stateHome = (env: Env) => envPath(env, "XDG_STATE_HOME", join(home(), ".local", "state"));
/** Noctalia 的 NOCTALIA_*_HOME 是「home root」形状（要再拼一层 noctalia/），与 XDG 变量不同。 */
const noctaliaConfigDir = (env: Env) =>
  join(envPath(env, "NOCTALIA_CONFIG_HOME", configHome(env)), "noctalia");
const noctaliaStateDir = (env: Env) =>
  join(envPath(env, "NOCTALIA_STATE_HOME", stateHome(env)), "noctalia");

/** 目录里最新的一个 .json（同目录会有多份历史配色，取最后被写的）。取不到返回 null。 */
export function newestJSON(dir: string): string | null {
  return newestFile(dir, ".json");
}

/** 目录里最新的一个指定后缀文件（Noctalia 的 kcolorscheme 模板每次换配色都重写它）。取不到返回 null。 */
export function newestFile(dir: string, ext: string): string | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  let best: { mtime: number; path: string } | null = null;
  for (const name of names) {
    if (!name.endsWith(ext)) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { mtime: st.mtimeMs, path: p };
    } catch { /* 读不到就跳过这一个 */ }
  }
  return best ? best.path : null;
}

/** 目录下的 *.toml（不含子目录；Noctalia 的自动加载就是这一层）。 */
function tomlFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".toml")).map((n) => join(dir, n));
  } catch { return []; }
}

/** Noctalia 的 [theme] 段取值：config 层全部 *.toml + GUI 覆盖层 settings.toml，**后者赢**。 */
export function noctaliaThemeValue(env: Env, key: string): string {
  let v = "";
  for (const f of [...tomlFiles(noctaliaConfigDir(env)), join(noctaliaStateDir(env), "settings.toml")]) {
    const hit = iniValue(readText(f), "theme", key).replace(/^['"]|['"]$/g, "");
    if (hit) v = hit;
  }
  return v;
}

/**
 * Noctalia 的「当前配色文件」候选。
 * ⚠️ v5 的 wallpaper/builtin 配色**只活在内存里** —— palettes/<custom_palette>.json 是
 * 「custom palette 定义」，source≠custom 时它不是活的配色（读了就是「换壁纸压根不变」的坑）；
 * community 缓存同理，只在 source=community 时认。活的落盘物是**模板产物**（见 detect 3/4 步）。
 */
export function noctaliaPalettePaths(env: Env = process.env): string[] {
  const cfg = noctaliaConfigDir(env);
  const state = noctaliaStateDir(env);
  const out = [join(cfg, "colors.json")]; // v4 / 旧版约定：外壳把活配色写在这（v4 时代）
  const source = noctaliaThemeValue(env, "source");
  if (source === "custom") {
    const name = noctaliaThemeValue(env, "custom_palette");
    if (name && /^[\w.-]+$/.test(name)) out.push(join(cfg, "palettes", `${name}.json`));
  }
  if (source === "community") {
    const community = newestJSON(join(state, "community-palettes"));
    if (community) out.push(community);
  }
  return out;
}

/**
 * Noctalia 用户模板（[theme.templates.user.*]）的 JSON 产物。这些文件由外壳在每次换配色时
 * 重渲染 —— 是文档背书的「把颜色递给别的程序」通路，跟着当前配色走。
 */
export function noctaliaTemplateOutputs(env: Env = process.env): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of [...tomlFiles(noctaliaConfigDir(env)), join(noctaliaStateDir(env), "settings.toml")]) {
    // TOML 段名形如 [theme.templates.user.<id>]；iniValue 是精确匹配段名，这里手动扫
    let inUser = false;
    for (const raw of readText(f).split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) { inUser = /^\[theme\.templates\.user\./.test(line); continue; }
      if (!inUser) continue;
      const m = /^output_path\s*=\s*["']([^"']+)["']/.exec(line);
      if (!m) continue;
      const p = m[1].replace(/^~(?=\/|$)/, home()).replace(/\$(XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME)/g, (_, k) => envPath(env, k, ""));
      if (!p.endsWith(".json") || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** 当前深浅（用来在 JSON 的两支里挑）；判不出来按 dark —— 与主题默认档一致。 */
function currentMode(opts: AccentOpts): "dark" | "light" {
  const t = readSystemTheme({
    desktop: String((opts.env ?? process.env).XDG_CURRENT_DESKTOP ?? ""),
    run: opts.run,
    timeoutMs: opts.timeoutMs,
  });
  return t === "light" ? "light" : "dark";
}

/** gsettings 问一次（必须带 timeout：spawnSync 挂住 = 主进程假死，见 systheme 的同款注释）。 */
function gsettingsAccentName(opts: AccentOpts): string | null {
  const run = opts.run ?? spawnSync;
  const r = run("gsettings", ["get", "org.gnome.desktop.interface", "accent-color"],
    { encoding: "utf8", timeout: opts.timeoutMs ?? 2000 });
  if (r.error) return null;
  return parseGnomeAccent(r.stdout);
}

/** 缓存：设置页与高亮色模块可能同时来问，1s 内只真读一次盘（也不至于让手改的配色等太久）。 */
const CACHE_MS = 1000;
let cache: { at: number; hit: AccentHit | null } | null = null;

/** 探测系统强调色。拿不到返回 null（调用方回落到默认青色）。 */
export function systemAccent(opts: AccentOpts = {}): AccentHit | null {
  const now = Date.now();
  if (!opts.fresh && cache && now - cache.at < CACHE_MS) return cache.hit;
  const hit = detect(opts);
  cache = { at: now, hit };
  return hit;
}

function detect(opts: AccentOpts): AccentHit | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const mk = (color: string, source: string, label: string, path: string): AccentHit =>
    ({ color, source, label, path });

  // 1/2) Quaver 专属交接文件（Noctalia / matugen 模板的落点；JSON 与 CSS 两种形态都认）
  const dir = configDir(env);
  const handoff = join(dir, "system-theme.json");
  if (existsSync(handoff)) {
    const json = readText(handoff);
    const c = extractAccent(json, currentMode(opts));
    if (c) return mk(c, "quaver-template", "系统主题交接文件", handoff);
  }
  const handoffCss = join(dir, "system-theme.css");
  if (existsSync(handoffCss)) {
    const c = gtkCssAccent(readText(handoffCss));
    if (c) return mk(c, "quaver-template", "系统主题交接文件", handoffCss);
  }

  // 3) Noctalia 用户模板的 JSON 产物（[theme.templates.user.*] 的 output_path）
  for (const p of noctaliaTemplateOutputs(env)) {
    if (!existsSync(p)) continue;
    const c = extractAccent(readText(p), currentMode(opts));
    if (c) return mk(c, "noctalia-template", "Noctalia 模板产物", p);
  }

  // 4) Noctalia 的 kcolorscheme 模板产物（每次换配色重写；Selection 底 = M3 primary）。
  //    实测 Hyprland 下也成立 —— 模板产物不看会话。
  const kdeScheme = newestFile(join(envPath(env, "XDG_DATA_HOME", join(home(), ".local", "share")), "color-schemes"), ".colors");
  if (kdeScheme) {
    const c = parseRGBTriple(iniValue(readText(kdeScheme), "Colors:Selection", "BackgroundNormal"));
    if (c) return mk(c, "noctalia-colors", "Noctalia 模板（KDE 配色）", kdeScheme);
  }

  // 5) Noctalia 的配色文件（v4 colors.json；custom/community 只在 source 对得上时认 ——
  //    否则那份文件是「定义」不是「活配色」，读它就是「换壁纸压根不变」的坑）
  for (const p of noctaliaPalettePaths(env)) {
    if (!existsSync(p)) continue;
    const c = extractAccent(readText(p), currentMode(opts));
    if (c) {
      const community = /community-palettes/.test(p);
      return mk(c, community ? "noctalia-community" : p.endsWith("colors.json") ? "noctalia" : "noctalia-palette",
        "Noctalia", p);
    }
  }

  // 6) matugen（社区惯例：模板把生成结果写到 ~/.cache/matugen/colors.json）
  for (const p of [String(env.MATUGEN_COLORS ?? "").trim(), join(cacheHome(env), "matugen", "colors.json"), join(home(), ".cache", "matugen", "colors.json")]) {
    if (!p || !existsSync(p)) continue;
    const c = extractAccent(readText(p), currentMode(opts));
    if (c) return mk(c, "matugen", "matugen", p);
  }

  // 7) KDE：kdeglobals 的 [General] AccentColor（Plasma 自己写的才认 —— 只在 KDE 会话下）
  const desktop = String(env.XDG_CURRENT_DESKTOP ?? "");
  if (/(^|[^a-z])(kde|plasma)([^a-z]|$)/i.test(desktop)) {
    const p = join(configHome(env), "kdeglobals");
    const c = parseRGBTriple(iniValue(readText(p), "General", "AccentColor"));
    if (c) return mk(c, "kde", "KDE 系统强调色", p);
  }

  // 8) GNOME 47+：gsettings accent-color（三个桌面之外的标准口子）
  if (platform === "linux") {
    const c = gsettingsAccentName(opts);
    if (c) return mk(c, "gnome", "GNOME 系统强调色", "gsettings org.gnome.desktop.interface accent-color");
  }

  // 9) kdeglobals 的 [Colors:Selection] BackgroundNormal —— **不看会话**：Noctalia 的
  //    kcolorscheme 模板在任何桌面下都会把它合并进 kdeglobals（实测 Hyprland）；纯 GNOME
  //    没有 kdeglobals，不会被带偏。放在 gsettings 之后：GNOME 上 gsettings 更权威。
  const kdeGlobals = join(configHome(env), "kdeglobals");
  {
    const c = parseRGBTriple(iniValue(readText(kdeGlobals), "Colors:Selection", "BackgroundNormal"));
    if (c) return mk(c, "kde-selection", "KDE 选中色（Noctalia 合并）", kdeGlobals);
  }

  // 10) 主题生成器写的 GTK css（Noctalia 的 gtk3/gtk4 模板 / matugen / pywal…）
  //     注意用 configHome(env) 现算而不是 systheme.gtkCssDirs()：后者读真实 process.env，
  //     测不了（与本文件其余来源同一口径）。
  const css = gtkCssNewest([3, 4].map((v) => join(configHome(env), `gtk-${v}.0`)));
  if (css) {
    const c = gtkCssAccent(readText(css));
    if (c) return mk(c, "gtk", "GTK 配色", css);
  }

  // 11) macOS / Windows 的系统设置
  const run = opts.run ?? spawnSync;
  if (platform === "darwin") {
    const r = run("defaults", ["read", "-g", "AppleAccentColor"], { encoding: "utf8", timeout: opts.timeoutMs ?? 2000 });
    if (!r.error) {
      // 键不存在 = 出厂蓝（macOS 默认档），所以「读到空」也按蓝算，不往下走别的来源
      const c = parseMacAccent(r.stdout) ?? GNOME_ACCENTS.blue;
      return mk(c, "macos", "macOS 系统强调色", "defaults read -g AppleAccentColor");
    }
  }
  if (platform === "win32") {
    const r = run("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\DWM"], { encoding: "utf8", timeout: opts.timeoutMs ?? 2000 });
    if (!r.error) {
      const c = parseWindowsAccent(r.stdout);
      if (c) return mk(c, "windows", "Windows 系统强调色", "HKCU\\...\\DWM\\AccentColor");
    }
  }
  return null;
}

/** /api/accent 的应答体（两个服务端各写各的 res，内容只有这一份）。 */
export interface AccentPayload {
  ok: boolean;
  /** `#rrggbb`；读不到为 null */
  color: string | null;
  source: string;
  label: string;
  path: string;
  /** 当前深浅（用来挑 JSON 里那支） */
  mode: "dark" | "light";
}

export function accentPayload(opts: AccentOpts = {}): AccentPayload {
  const hit = systemAccent(opts);
  return {
    ok: true,
    color: hit?.color ?? null,
    source: hit?.source ?? "",
    label: hit?.label ?? "",
    path: hit?.path ?? "",
    mode: currentMode(opts),
  };
}

// —— CLI：把各层原始值摊开（排障用，只读，不动任何设置）——
//   cd ui && node electron/accent.ts
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const p = accentPayload({ fresh: true });
  console.log(`XDG_CONFIG_HOME        ${env.XDG_CONFIG_HOME || "(空)"}`);
  console.log(`XDG_CURRENT_DESKTOP    ${env.XDG_CURRENT_DESKTOP || "(空)"}`);
  console.log(`当前深浅               ${p.mode}`);
  console.log(`Noctalia [theme] source = ${noctaliaThemeValue(env, "source") || "(未设)"}`);
  for (const f of [join(configDir(env), "system-theme.json"), join(configDir(env), "system-theme.css"), ...noctaliaTemplateOutputs(env), join(envPath(env, "XDG_DATA_HOME", join(home(), ".local", "share")), "color-schemes"), ...noctaliaPalettePaths(env), join(cacheHome(env), "matugen", "colors.json")]) {
    console.log(`${existsSync(f) ? "有" : "无"}  ${f}`);
  }
  console.log(`→ 结论                 ${p.color ?? "null（回落默认青色）"}${p.color ? `  来源 ${p.label}（${p.source}）· ${p.path}` : ""}`);
}
