// Sparkle — 主题与「高亮颜色（tint）」的交接策略。
//
// 为什么需要这一层：宿主的高亮色是 lib/tint.ts 以**内联样式**写在 :root 上的
// （--cvg-accent / --cvg-glow / --cvg-bar-*）。内联样式压过任何选择器 —— 包括主题的
// `html[data-sparkle-theme="<id>"]{--cvg-accent:…}`。所以「主题想自带高亮色」抢不过，
// 必须由宿主**主动让位**：不写那几个变量，让 --cvg-accent 回落 `:root { --cvg-accent: var(--acc) }`
// —— 主题通常已经覆盖了 --acc/--cyan，让位后高亮色就自动是主题的色。
//
// 契约（SDK 的 SparkleTheme.tint）：
//   · 不声明          → off     ：主题自带强调色，宿主让位，设置页禁用「高亮颜色」整组
//   · { mode:"host" } → host    ：宿主那四档继续生效（固定青色 / 跟随封面 / 系统强调色 / 自定义色）
//   · { mode:"presets"} → presets：用户在主题给的方案里挑，宿主按自定义色应用选中的那套。
//                                  方案的 color 还可以写哨兵值 "system"（TINT_PRESET_SYSTEM）=
//                                  跟随系统强调色（Noctalia / matugen / KDE / GNOME…，探测在
//                                  electron/accent.ts）；读不到时宿主回落第一套非哨兵方案。
//
// 本文件是**纯策略 + 一点持久化**：策略解析全是纯函数（可在 node 里直接单测）；只有
// 方案选择的读写碰 localStorage，且只在函数体内（导入本模块无副作用）。
// 注意：这里的**值导入**必须写全 `.ts` —— 本模块是纯策略，护栏脚本要在 node 里直接 import
// 它做单测，而 Node 的类型剥离不做路径改写（`import type` 会被整条擦除，所以 SDK 那个可以不带）。
import type { SparkleTheme, SparkleTintPreset } from "@quaver/sparkle";
import { parseHex, toHex } from "../lib/color.ts";

export type SparkTintMode = "off" | "host" | "presets";

/**
 * 方案 color 的哨兵值：不是颜色字面量，而是「宿主读到的系统强调色」。
 * 主题拿它做一档方案（如「跟随系统强调色」），宿主解析时替换成探测结果。
 * 取不到系统强调色时回落第一套非哨兵方案 —— 主题的方案永远有得选。
 */
export const TINT_PRESET_SYSTEM = "system";

export interface SparkTintPolicy {
  mode: SparkTintMode;
  /** 校验过的方案列表（仅 mode="presets" 时非空） */
  presets: SparkleTintPreset[];
  /** 声明这套策略的主题 id（无主题时为 null） */
  themeId: string | null;
}

/**
 * 过滤主题给的方案：id 非空且不重复、label 非空、color 能解析成颜色字面量**或**是哨兵值
 * "system"（= 跟随系统强调色）。主题是第三方代码，这些值会进 DOM（style 属性）与 CSS 变量
 * —— 一律先校验再信。
 */
export function validPresets(list: unknown): SparkleTintPreset[] {
  if (!Array.isArray(list)) return [];
  const out: SparkleTintPreset[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const p = raw as Partial<SparkleTintPreset> | null | undefined;
    if (!p || typeof p.id !== "string" || !p.id || seen.has(p.id)) continue;
    if (typeof p.label !== "string" || !p.label) continue;
    if (typeof p.color !== "string" || (p.color !== TINT_PRESET_SYSTEM && !parseHex(p.color))) continue;
    seen.add(p.id);
    out.push({ id: p.id, label: p.label, color: p.color });
  }
  return out;
}

/**
 * 方案的 color → 实际色值（规范 6 位）。普通字面量照解析；哨兵值 "system" 换成
 * 宿主读到的系统强调色（没有 = null，调用方回落第一套非哨兵方案）。
 * 纯函数：sysHex 由渲染层从 lib/accent.ts 的缓存里同步取来传进来。
 */
export function resolvePresetColor(color: string, sysHex: string | null): string | null {
  if (color === TINT_PRESET_SYSTEM) {
    const c = sysHex ? parseHex(sysHex) : null;
    return c ? toHex(c) : null;
  }
  const c = parseHex(color);
  return c ? toHex(c) : null;
}

/**
 * 激活主题 → tint 策略。
 * `theme` 为 null（没启用主题 / 主题已从注册表消失）= 宿主的正常三档。
 * 声明得不成形（mode 不认识）按「不声明」处理 —— 让位是安全侧：宁可少写变量，也别让宿主
 * 的内联色压着一个自带完整配色的主题。
 */
export function tintPolicyOf(theme: SparkleTheme | null | undefined): SparkTintPolicy {
  if (!theme) return { mode: "host", presets: [], themeId: null };
  const t = theme.tint;
  if (!t || (t.mode !== "host" && t.mode !== "presets")) {
    return { mode: "off", presets: [], themeId: theme.id };
  }
  if (t.mode === "presets") {
    const presets = validPresets(t.presets);
    // 声明了 presets 却一套合法方案都没有：用户没得挑，降级成 host
    if (!presets.length) return { mode: "host", presets: [], themeId: theme.id };
    return { mode: "presets", presets, themeId: theme.id };
  }
  return { mode: "host", presets: [], themeId: theme.id };
}

/** 从（已校验的）方案里挑生效的那一套：用户选过的，否则第一个（与主题包的 variants 同口径）。 */
export function pickPreset(presets: SparkleTintPreset[], chosenId: string | null): SparkleTintPreset | null {
  if (!presets.length) return null;
  return presets.find((p) => p.id === chosenId) ?? presets[0];
}

// —— 方案选择的持久化（localStorage，与 enabled / theme 同一套；打包态固定端口 → origin 稳定） ——

const PRESET_KEY = "quaver.sparkle.tint.v1";

/** themeId → presetId 的选择表（一份文件装所有主题的选择，切来切去不丢） */
function readChoices(): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(PRESET_KEY) ?? "{}";
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 用户在某个主题下选过的方案 id（没选过 = null，调用方回落到第一个）。 */
export function sparkTintChoice(themeId: string | null): string | null {
  if (!themeId) return null;
  const v = readChoices()[themeId];
  return typeof v === "string" ? v : null;
}

export function sparkSetTintChoice(themeId: string, presetId: string | null): void {
  if (!themeId) return;
  const all = readChoices();
  if (presetId) all[themeId] = presetId;
  else delete all[themeId];
  try {
    globalThis.localStorage?.setItem(PRESET_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式 / 配额满：本次会话内仍然生效 */
  }
}
