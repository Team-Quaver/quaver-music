// Quaver — 配置文件（INI / .conf），纯 Node ESM，零依赖，可脱离 Electron 单测。
//
// 为什么不用 localStorage：打包态（AppImage）此前每次启动都在随机端口上起 HTTP 服务，
// 页面 origin 每次不同 → localStorage 按 origin 隔离 → 设置每次归零。文件配置不受 origin 影响。
//
// 目录规则（Node 与 Go sidecar 必须严格一致，由 QUAVER_CONFIG_DIR 显式约定）：
//   Linux    $XDG_CONFIG_HOME/quaver-music   默认 ~/.config/quaver-music
//   Windows  %AppData%/Quaver Music          即 %USERPROFILE%\AppData\Roaming\Quaver Music
//   macOS    ~/Library/Application Support/Quaver Music
//   QUAVER_CONFIG_DIR 环境变量可整体顶掉（测试 / 由主进程显式传给 sidecar）。
//
// 写入策略：读文件时保留原始行（注释、顺序、用户自加的键都不动），set 只改对应键那一行；
// 键不存在时追加。落盘走「同目录临时文件 + rename」原子替换，权限 0600、目录 0700。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const APP_DIR_NAME = "Quaver Music"; // Windows / macOS 用
export const APP_DIR_NAME_POSIX = "quaver-music"; // Linux（XDG 风格小写）
export const CONFIG_NAME = "quaver.conf";
export const CREDENTIAL_NAME = "credential.json"; // 明文——只作为升级遗留的导入来源，导入后即删
export const CREDENTIAL_STORE_NAME = "credential.enc"; // 密钥环模式：磁盘上只留密文，钥匙在系统密钥管理器里
export const DEVICE_NAME = "device.json";

// —— 路径 ——

/** 注入式环境表（默认 process.env）：测试与主进程显式下发给 sidecar 时传自定义对象。 */
export type Env = NodeJS.ProcessEnv;

/** 配置目录（跨平台）。env 可注入，便于测试与主进程显式下发给 sidecar。 */
export function configDir(env: Env = process.env): string {
  const override = String(env.QUAVER_CONFIG_DIR ?? "").trim();
  if (override) return resolve(override);
  if (process.platform === "win32") {
    const appData = String(env.APPDATA ?? "").trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, APP_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  const xdg = String(env.XDG_CONFIG_HOME ?? "").trim();
  return join(xdg || join(homedir(), ".config"), APP_DIR_NAME_POSIX);
}

export const configFile = (env: Env = process.env): string => join(configDir(env), CONFIG_NAME);
export const credentialFile = (env: Env = process.env): string => join(configDir(env), CREDENTIAL_NAME);
export const credentialStoreFile = (env: Env = process.env): string => join(configDir(env), CREDENTIAL_STORE_NAME);
export const deviceFile = (env: Env = process.env): string => join(configDir(env), DEVICE_NAME);
export const logFile = (env: Env = process.env): string => join(configDir(env), "electron-dev.log");

/** 确保目录存在（0700）。返回目录路径。 */
export function ensureConfigDir(env: Env = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// —— INI ——

const SECTION_RE = /^\s*\[([^\]]+)]\s*$/;
// key 允许到 "=" 之前；# / ; 开头的整行是注释，不参与匹配
const KV_RE = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/;
// 行内注释（INI 惯例）：值后面跟「空白 + #/;」开始的部分。本项目的取值域里不含这两个字符，
// 所以按惯例切分不会有歧义；改值时原注释会跟着那一行一起保留。
const INLINE_RE = /\s[#;]/;

function splitInline(raw: string): { value: string; comment: string } {
  const i = raw.search(INLINE_RE);
  return i < 0 ? { value: raw, comment: "" } : { value: raw.slice(0, i).trim(), comment: raw.slice(i) };
}

/**
 * 保结构 INI 文档：只维护原始行数组，取值/改值都在行上做，注释与顺序天然保留。
 */
export class IniDoc {
  lines: string[];

  constructor(lines: string[] = []) {
    this.lines = lines;
  }

  static parse(text: unknown): IniDoc {
    const t = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!t) return new IniDoc([]);
    const lines = t.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop(); // 结尾换行不算一行
    return new IniDoc(lines);
  }

  toString(): string {
    return this.lines.join("\n") + (this.lines.length ? "\n" : "");
  }

  /** 段的行区间 [start, end)：start 是段头行号，end 是下一个段头（或文件尾）。未找到返回 [-1,-1]。 */
  sectionRange(name: string): [number, number] {
    const want = String(name).toLowerCase();
    let start = -1;
    for (let i = 0; i < this.lines.length; i++) {
      const m = SECTION_RE.exec(this.lines[i]);
      if (!m) continue;
      if (start >= 0) return [start, i];
      if (m[1].trim().toLowerCase() === want) start = i;
    }
    return start >= 0 ? [start, this.lines.length] : [-1, -1];
  }

  /** 段名是否存在于文档中（空段也算）。 */
  hasSection(name: string): boolean {
    return this.sectionRange(name)[0] >= 0;
  }

  get(section: string, key: string): string | undefined {
    const [s, e] = this.sectionRange(section);
    if (s < 0) return undefined;
    const want = String(key).toLowerCase();
    for (let i = s + 1; i < e; i++) {
      const m = KV_RE.exec(this.lines[i]);
      if (m && m[1].toLowerCase() === want) return splitInline(m[2]).value;
    }
    return undefined;
  }

  /** 只在键已存在时改写取值，返回是否命中（用于「不主动把默认值写进用户文件」）。 */
  setExisting(section: string, key: string, value: unknown): boolean {
    const [s, e] = this.sectionRange(section);
    if (s < 0) return false;
    const want = String(key).toLowerCase();
    for (let i = s + 1; i < e; i++) {
      const m = KV_RE.exec(this.lines[i]);
      if (m && m[1].toLowerCase() === want) {
        const { comment } = splitInline(m[2]); // 手写在行尾的注释跟着走，别被改值抹掉
        this.lines[i] = `${m[1].trim()}=${String(value ?? "")}${comment}`;
        return true;
      }
    }
    return false;
  }

  /** 写值：命中就改那一行；段内没有就追加到段尾（跳过段尾空行）；段不存在就补段头。 */
  set(section: string, key: string, value: unknown): this {
    const text = String(value ?? "");
    if (this.setExisting(section, key, text)) return this;
    const [s, e] = this.sectionRange(section);
    if (s >= 0) {
      let at = e;
      while (at - 1 > s && this.lines[at - 1].trim() === "") at--;
      this.lines.splice(at, 0, `${key}=${text}`);
      return this;
    }
    if (this.lines.length && this.lines[this.lines.length - 1].trim() !== "") this.lines.push("");
    this.lines.push(`[${section}]`, `${key}=${text}`);
    return this;
  }

  /** 收集全部键值 → { "Section.Key": value }（段名与键名保持文件里的原样）。 */
  values(): Record<string, string> {
    const out: Record<string, string> = {};
    let cur: string | null = null;
    for (const line of this.lines) {
      const sm = SECTION_RE.exec(line);
      if (sm) {
        cur = sm[1].trim();
        continue;
      }
      const m = KV_RE.exec(line);
      if (m && cur) out[`${cur}.${m[1].trim()}`] = splitInline(m[2]).value;
    }
    return out;
  }
}

// —— schema（段 / 键 / 默认值 / 可选值域 / 文件内注释）——
// 段名与键名对齐 docs 里给的模板；新增段沿用同一命名风格。

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 主题：三档内置 + 未来自定义主题（kebab-case 名）。 */
const isTheme = (v: string): boolean => ["dark", "light", "follow-system"].includes(v) || KEBAB.test(v);

// 热键值 = Electron accelerator 的规范化子集（设置页录制器只产出这种形态）：
// 修饰键按 Ctrl+Alt+Shift+Super 固定序出现且不重复，末段是键名；空串 = 停用该热键（合法）。
const HK_KEY = new RegExp(
  "^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Left|Right|Up|Down|Space|Tab|Enter|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Minus|Equal|Comma|Period)$",
);
const HK_MOD = /^(Ctrl|Alt|Shift|Super)$/;
// 导出给 global-hotkeys.ts：Electron 的 globalShortcut 没有注册前的格式探测 API，
// shortcut 模式的「格式不合法」判定与 schema 值域用同一个函数，保证两侧不漂移。
export const isHotkey = (v: unknown): boolean => {
  const s = String(v ?? "").trim();
  if (!s) return true; // 空 = 停用
  const parts = s.split("+");
  if (parts.some((p) => p === "")) return false;
  const key = parts.pop() ?? ""; // 上面已排掉空段，此处必有键名
  return HK_KEY.test(key) && parts.every((m) => HK_MOD.test(m)) && new Set(parts).size === parts.length;
};

// 字体值是直接塞进 CSS 变量的 font-family 列表：空值合法（= 不覆盖，走内置默认栈），
// 但不接受能改 CSS 结构的字符（; { } 换行）或 url() —— 手改配置文件也注入不进别的东西。
const isFontList = (v: string): boolean => !/[;{}\r\n]|url\s*\(/i.test(v);

/** 自定义背景图支持的扩展名（同时也是原生「选择图片」对话框的过滤器，与 /api/bg 的白名单同源）。
 *  这里收窄是有意义的：/api/bg 只肯吐图片后缀的文件，手改配置文件也读不到别的文件。 */
export const BG_IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"] as const;

/** 背景图路径校验：空值合法（= 未选择）；否则只要求「单行、非控制字符、长度合理」——
 *  路径里的 `"` `=` `#` 等字符不在这里拦（那是用户自己机器上的文件名，读盘侧不吃字符串拼接）。
 *  唯一要防的是换行/回车：INI 是逐行解析的，写进去会把配置文件的段结构撕开。 */
const isBackgroundImagePath = (v: string): boolean =>
  v.trim() === "" || (!/[\r\n\u0000]/.test(v) && v.length <= 1024);

/** 高亮色（tint）自定义色的值域：只收规范形态 `#rgb` / `#rrggbb`（带 `#`，大小写皆可）。
 *  这个值最终会被渲染层塞进 CSS 变量，所以只认十六进制字面量 —— `red`、`rgb(0,0,0)`、
 *  `var(--x)` 一律不合法，它被关进「颜色常量」这一种可能里。渲染层读回来统一归一成小写 6 位。 */
export const isHexColor = (v: string): boolean => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v ?? "").trim());

/** schema 里一个键的完整描述：默认值、文件内注释、值域校验器。 */
export interface KeySpec {
  key: string;
  def: string;
  doc?: string[];
  valid: (v: string) => boolean;
}

/** 一个段（节）中的所有键。 */
export interface SectionSpec {
  section: string;
  keys: KeySpec[];
}

export const SCHEMA: SectionSpec[] = [
  {
    section: "Style",
    keys: [
      {
        key: "Style",
        def: "dark",
        doc: [
          "修改项名：用",
          "可选 dark,light,follow-system 自定义主题系统上了后按照自定义主题名字实现（使用烤肉串命名法，即 kebab case）",
        ],
        valid: isTheme,
      },
      {
        key: "DefaultUIFonts",
        def: "Source Han Sans,Microsoft Yahei UI",
        doc: ["界面字体：CSS font-family 列表（逗号分隔）；留空则用内置默认栈；也可填预设名 system/sans/serif/mono"],
        valid: isFontList,
      },
      {
        key: "DefaultLyricsFonts",
        def: "Source Han Serif",
        doc: ["歌词字体：同上"],
        valid: isFontList,
      },
      {
        key: "ShowTranslation",
        def: "True",
        doc: ["歌词是否显示翻译行：True（默认）｜False"],
        valid: (v: string) => ["True", "False", "true", "false", "1", "0", "yes", "no"].includes(v),
      },
      {
        key: "LyricScale",
        def: "1",
        doc: ["正在播放页行级（LRC）歌词缩放：0.7..1.5，1=默认；字号与行距随同一系数缩放。逐字（QRC/AMLL）模式不生效"],
        valid: (v: string) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0.7 && Number(v) <= 1.5,
      },
      {
        key: "Background",
        def: "off",
        doc: [
          "默认主题的背景（环境色层）：off=关闭（只有主题底色，**默认**）｜cover=当前曲封面模糊铺底｜custom=自定义图片",
          "（路径见 BackgroundImage）。插件主题自带背景时不受此项约束",
        ],
        valid: (v: string) => ["off", "cover", "custom"].includes(v),
      },
      {
        key: "BackgroundImage",
        def: "",
        doc: [
          "自定义背景图片的**绝对路径**（设置页「选择图片」写入）；留空=尚未选择。",
          "图片由客户端本地服务（/api/bg）按此路径读出并交给界面，扩展名限 jpg/jpeg/png/webp/gif/bmp/avif",
        ],
        valid: isBackgroundImagePath,
      },
      {
        key: "BackgroundBlur",
        def: "70",
        doc: [
          "背景模糊强度（px，高斯半径）：0..120，0=原图不模糊。",
          "自定义图片建议小值（看得清图），封面环境色建议大值（只取色彩倾向）",
        ],
        valid: (v: string) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 120,
      },
      {
        key: "Tint",
        def: "default",
        doc: [
          "界面高亮色（tint）的来源：default=固定青色 #19c2d8（**默认**，不随封面变化）｜cover=跟随当前曲封面主色（换曲平滑过渡）｜custom=自定义颜色",
          "（自定义色的取值见 TintColor）。影响进度条/选中态/激活描边等一切 --cvg-accent/--cvg-glow 的消费点",
        ],
        valid: (v: string) => ["default", "cover", "custom"].includes(v),
      },
      {
        key: "TintColor",
        def: "#19c2d8",
        doc: [
          "自定义高亮色（仅 [Style] Tint=custom 时生效）：#rgb / #rrggbb 十六进制字面量。",
          "设置页的颜色选择器按 HSL / CMYK / RGB 编辑，落盘的永远是这一种规范形态",
        ],
        valid: isHexColor,
      },
    ],
  },
  {
    section: "Window",
    keys: [
      {
        key: "Decor",
        def: "csd",
        doc: ["窗口装饰：csd=自绘标题栏（默认）｜ssd=系统标题栏。切换后自动重建窗口"],
        valid: (v: string) => ["csd", "ssd"].includes(v),
      },
      {
        key: "CloseAction",
        def: "tray",
        doc: ["窗口右上角 ✕ 的行为：tray=缩放到托盘（默认）｜quit=退出程序"],
        valid: (v: string) => ["tray", "quit"].includes(v),
      },
      {
        key: "SidebarCollapsed",
        def: "False",
        doc: ["侧栏是否缩回：False=展开（默认，显示昵称/导航文字/歌单名）｜True=缩回（只留头像、导航图标、歌单封面与底部两颗按钮）"],
        valid: (v: string) => ["True", "False", "true", "false", "1", "0", "yes", "no"].includes(v),
      },
      {
        key: "SidebarWidth",
        def: "",
        doc: ["侧栏宽度（px）：拖拽侧栏右缘分隔条写入；留空=用内置默认（216）"],
        valid: (v: string) => v.trim() === "" || (Number.isFinite(Number(v)) && Number(v) >= 64 && Number(v) <= 2000),
      },
      {
        key: "QueueWidth",
        def: "",
        doc: ["播放列表停靠宽度（px）：拖拽面板左缘分隔条写入；留空=用内置默认（300）"],
        valid: (v: string) => v.trim() === "" || (Number.isFinite(Number(v)) && Number(v) >= 64 && Number(v) <= 2000),
      },
    ],
  },
  {
    section: "Playing",
    keys: [
      {
        key: "Backend",
        def: "MPV",
        doc: ["默认 MPV，可选 Chromium"],
        valid: (v: string) => ["MPV", "Chromium", "Blink"].includes(v), // Blink 是旧值，读入时归一为 Chromium
      },
      {
        key: "AudioDevice",
        def: "auto",
        doc: ["音频输出设备（仅 MPV）：auto=系统默认；其余填 mpv audio-device 名（pipewire/pulse/alsa/…）"],
        valid: (v: string) => v.length > 0,
      },
      {
        key: "Fade",
        def: "normal",
        doc: ["淡入淡出（仅 MPV）：off｜short｜normal｜long"],
        valid: (v: string) => ["off", "short", "normal", "long"].includes(v),
      },
      {
        key: "Volume",
        def: "0.8",
        doc: ["音量 0..1（静音时保留原值，恢复即回）"],
        // 注意空串：Number("") === 0 会蒙混过关，得先排掉
        valid: (v: string) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1,
      },
      {
        key: "Muted",
        def: "False",
        doc: ["启动时是否静音：True｜False"],
        valid: (v: string) => ["True", "False", "true", "false", "1", "0", "yes", "no"].includes(v),
      },
      {
        key: "PrevReplay",
        def: "True",
        doc: ["「上一首」按钮逻辑：True=单击重放当前曲、双击/快速连按跳到队列里的上一首（默认）｜False=单击直接跳到队列里的上一首"],
        valid: (v: string) => ["True", "False", "true", "false", "1", "0", "yes", "no"].includes(v),
      },
      {
        key: "InhibitSleep",
        def: "True",
        doc: [
          "播放音频时禁止系统睡眠（sidecar 执行端：Linux=xdg 门户 Suspend 位、门户假成功走 Logind 直连；",
          "Windows=PowerRequestSystemRequired；macOS=IOKit PreventUserIdleSystemSleep）。True（默认）｜False。",
          "只阻止睡眠，屏幕熄灭/锁屏策略不受影响；仅音频播放期间持有",
        ],
        valid: (v: string) => ["True", "False", "true", "false", "1", "0", "yes", "no"].includes(v),
      },
    ],
  },
  {
    section: "Quality",
    keys: [
      {
        key: "DefaultQuality",
        def: "Auto",
        doc: ["默认音质：Auto｜128｜320｜flac｜640ogg｜atmos2｜atmos51｜master"],
        valid: (v: string) => ["Auto", "128", "320", "flac", "640ogg", "atmos2", "atmos51", "master"].includes(v),
      },
      {
        key: "FallbackToQMAtmos",
        def: "False",
        doc: ["高档不可用时是否优先回退到臻品全景声：False=不优先（臻品母带优先，默认）｜True=按标准 rank 排序"],
        valid: (v: string) => ["True", "False", "true", "false", "1", "0", "yes", "no"].includes(v),
      },
    ],
  },
  {
    section: "Hotkeys.Global",
    keys: [
      {
        key: "Toggle",
        def: "Ctrl+Alt+P",
        doc: [
          "全局热键（系统级，窗口失焦也生效）：暂停/播放。空值=停用。",
          "取值形态：修饰键 Ctrl/Alt/Shift/Super 按此顺序组合 + 键名（字母/数字/F1-F24/",
          "Left Right Up Down/Space Tab Enter Escape Backspace Delete Insert Home End/",
          "PageUp PageDown Minus Equal Comma Period），如 Ctrl+Alt+P、Ctrl+Q",
        ],
        valid: isHotkey,
      },
      {
        key: "Prev",
        def: "Ctrl+Alt+Left",
        doc: ["全局热键：上一曲（遵循 [Playing] PrevReplay 逻辑）。空值=停用"],
        valid: isHotkey,
      },
      {
        key: "Next",
        def: "Ctrl+Alt+Right",
        doc: ["全局热键：下一曲。空值=停用"],
        valid: isHotkey,
      },
      {
        key: "VolUp",
        def: "Ctrl+Alt+Up",
        doc: ["全局热键：音量 +5%（到顶自动取消静音）。空值=停用"],
        valid: isHotkey,
      },
      {
        key: "VolDown",
        def: "Ctrl+Alt+Down",
        doc: ["全局热键：音量 -5%。空值=停用"],
        valid: isHotkey,
      },
    ],
  },
  {
    section: "Hotkeys.Focus",
    keys: [
      {
        key: "Toggle",
        def: "Ctrl+P",
        doc: ["焦点内热键（仅窗口聚焦时生效）：暂停/播放。空值=停用"],
        valid: isHotkey,
      },
      {
        key: "Quit",
        def: "Ctrl+Q",
        doc: ["焦点内热键：退出程序（不走「缩回托盘」）。空值=停用"],
        valid: isHotkey,
      },
      {
        key: "Prev",
        def: "Ctrl+Left",
        doc: ["焦点内热键：上一曲（遵循 [Playing] PrevReplay 逻辑）；输入框内不触发（Ctrl+方向是文本编辑键）。空值=停用"],
        valid: isHotkey,
      },
      {
        key: "Next",
        def: "Ctrl+Right",
        doc: ["焦点内热键：下一曲；输入框内不触发。空值=停用"],
        valid: isHotkey,
      },
      {
        key: "VolUp",
        def: "Ctrl+Up",
        doc: ["焦点内热键：音量 +5%；输入框内不触发。空值=停用"],
        valid: isHotkey,
      },
      {
        key: "VolDown",
        def: "Ctrl+Down",
        doc: ["焦点内热键：音量 -5%；输入框内不触发。空值=停用"],
        valid: isHotkey,
      },
    ],
  },
  {
    section: "Security",
    keys: [
      {
        key: "CredentialStore",
        def: "auto",
        doc: [
          "登录凭证存哪：auto=能用系统密钥管理器就用，拿不到就只驻内存｜keyring=只允许密钥管理器",
          "（同上）｜memory=干脆不落盘。**没有明文这一档** —— 凭证任何时候都不会以明文落盘。",
          "代价：退回内存模式时，关掉应用需重新扫码登录。改后需重启应用生效",
        ],
        valid: (v: string) => ["auto", "keyring", "memory"].includes(v),
      },
      {
        key: "KeyringBackend",
        def: "auto",
        doc: [
          "仅 Linux 有效：auto=按桌面/进程探测（Hyprland 等自建会话认不出时会显式钉一个真后端，",
          "避免 Chromium 静默退成 basic_text 的假加密）｜亦可手填 gnome-libsecret｜kwallet6｜kwallet5｜kwallet｜basic",
        ],
        valid: (v: string) => ["auto", "gnome-libsecret", "kwallet6", "kwallet5", "kwallet", "basic"].includes(v),
      },
    ],
  },
  {
    section: "Update",
    keys: [
      {
        key: "AutoCheck",
        def: "True",
        doc: [
          "启动后自动检查更新（设置-通用）：True（默认）｜False。",
          "发现新版本会先弹窗展示更新日志（GitHub Releases 提取），经你确认后才开始下载安装；",
          "关闭后仍可在设置页手动「检查更新」",
        ],
        valid: (v: string) => ["True", "False", "true", "false", "1", "0", "yes", "no"].includes(v),
      },
      {
        key: "Channel",
        def: "stable",
        doc: [
          "更新渠道：stable=正式发布版（默认）｜nightly=每夜构建",
          "（main 分支滚动 Release「nightly」，功能更新但可能不稳定）",
        ],
        valid: (v: string) => ["stable", "nightly"].includes(v),
      },
      {
        key: "LastNotified",
        def: "",
        doc: [
          "内部状态：已提醒过/被「跳过此版本」的版本标识（渠道:版本），避免每次启动重复弹窗。",
          "留空即可，勿手改；删除该键或清空值会恢复对新版本的提醒",
        ],
        valid: (v: string) => v.length <= 128,
      },
    ],
  },
];

/** 拍平为 { "Section.Key": { def, valid, doc } }。 */
export function schemaIndex(): Record<string, KeySpec> {
  const idx: Record<string, KeySpec> = {};
  for (const sec of SCHEMA) for (const k of sec.keys) idx[`${sec.section}.${k.key}`] = k;
  return idx;
}

/** 默认值表 { "Section.Key": default }。 */
export function defaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sec of SCHEMA) for (const k of sec.keys) out[`${sec.section}.${k.key}`] = k.def;
  return out;
}

/** 文件模板（首次运行写入；注释即使用说明）。 */
export function template(): string {
  const head = [
    "# Quaver Music 配置文件（INI）",
    "#",
    "# 本文件由客户端维护：只改写对应键的取值，注释、顺序与你自加的键都会原样保留。",
    "# 位置：",
    "#   Linux    ~/.config/quaver-music/quaver.conf",
    "#   Windows  %AppData%\\Quaver Music\\quaver.conf",
    "#   macOS    ~/Library/Application Support/Quaver Music/quaver.conf",
    "# 登录凭证（credential.enc 密文 / device.json）与日志也在同一目录，不写在本文档里。",
    "# 凭证一律交给系统密钥管理器（KWallet / GNOME Keyring / 钥匙串 / 凭据管理器）加密存放，",
    "# 磁盘上不留明文；拿不到密钥管理器时只驻内存，见 [Security] 段。",
    "#",
  ];
  const body: string[] = [];
  for (const sec of SCHEMA) {
    if (body.length) body.push("");
    body.push(`[${sec.section}]`);
    for (const k of sec.keys) {
      if (k.doc) for (const line of k.doc) body.push(`# ${line}`);
      body.push(`${k.key}=${k.def}`);
    }
  }
  return head.concat(body).join("\n") + "\n";
}

// —— 读写 ——

function writeAtomic(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

/** 读配置；文件不存在时写入模板。返回 IniDoc。 */
export function readDoc(env: Env = process.env): IniDoc {
  const file = configFile(env);
  if (!existsSync(file)) {
    let doc: IniDoc;
    try {
      writeAtomic(file, template());
      doc = IniDoc.parse(template());
    } catch {
      doc = IniDoc.parse(template()); // 只读文件系统（只读挂载/权限不足）：内存里照样能用
    }
    return doc;
  }
  try {
    return IniDoc.parse(readFileSync(file, "utf8"));
  } catch {
    return IniDoc.parse(""); // 解析不了就当空文档，后续按默认值走，不阻断启动
  }
}

/**
 * 读成平面表并补齐默认值 + 值域校验。返回 { values, warnings }。
 * 值域不合法的键回落到默认值并记一条 warning（不静默吞掉用户的手误）。
 */
export function readValues(env: Env = process.env): { values: Record<string, string>; warnings: string[] } {
  const idx = schemaIndex();
  const values = defaults();
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(readDoc(env).values())) {
    const spec = idx[k];
    if (!spec) continue; // 用户自加的键：留在文件里，但不进运行时配置
    if (!spec.valid(v)) {
      warnings.push(`${k}=${v} 不合法，已回落默认值 ${spec.def}`);
      continue;
    }
    values[k] = v;
  }
  return { values, warnings };
}

/** 批量写值；未知键忽略。返回实际写入的键。 */
export function writeValues(patch: Record<string, unknown>, env: Env = process.env): string[] {
  const idx = schemaIndex();
  const doc = readDoc(env);
  const written: string[] = [];
  for (const [k, v] of Object.entries(patch ?? {})) {
    const spec = idx[k];
    if (!spec) continue;
    const text = String(v ?? "");
    if (!spec.valid(text)) continue;
    doc.set(k.slice(0, k.indexOf(".")), k.slice(k.indexOf(".") + 1), text);
    written.push(k);
  }
  if (written.length) writeAtomic(configFile(env), doc.toString());
  return written;
}

/** 用模板重建配置文件（旧的会被整体替换）。 */
export function resetConfig(env: Env = process.env): Record<string, string> {
  writeAtomic(configFile(env), template());
  return readValues(env).values;
}
