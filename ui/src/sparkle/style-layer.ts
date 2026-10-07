// Sparkle — 全站样式层管理器（样式层注入 + 主题包切换）
//
// 职责：把 registry 里登记的「常驻样式层」与「当前选中的主题风格」翻译成真实的
// <style> 节点，并管好它们的生命周期。三条硬约束：
//
//  ① 层序 = order 升序、同 order 按登记序。样式节点在 head 里的**先后**就是优先级
//     （同特异性下后者胜），所以每次重排都要重挂，不能只改一次。
//     主题风格的 order 缺省比常驻层高（+1000）：主题是对全站的最终表态，理应压过
//     插件自带的常驻微调 —— 否则一个插件的样式层能悄悄压住所有主题。
//
//  ② 只在「选中」的包/风格上挂 style。切走 = 整张摘掉，不留任何残留声明
//     （这是与 registerTheme 的关键差别：那个靠 html[data-sparkle-theme] 选择器
//     天然失活，这个必须显式摘）。
//
//  ③ 孤儿自动回落：选中的包所属插件被停用时，localStorage 里还指着它 → 立即
//     reset() 回落宿主默认外观。否则用户会卡在一张永远没人再提供的样式上，
//     且没有任何 UI 能把它清掉（设置页列表里已经没有那个包了）。
//
// 另有一条**安全阀**：总闸 suspended。第三方样式层能改宿主全部 UI（这是设计意图，
// 主题就该全站生效），万一某个包把界面搞得没法用，用户需要一个不依赖任何插件的
// 退出通道 —— localStorage 一个键即可，不经过插件。
import type { SparkleStyleLayer, SparkleStyleState, SparkleThemePack } from "@quaver/sparkle";
import {
  onSparkleChange, sparkRegisterStyleLayer, sparkUnregisterStyleLayer,
  sparkleStyleLayers, sparkleThemePacks,
  type StyleLayerEntry,
} from "./registry";

// —— 持久化 ——

const PACK_KEY = "quaver.sparkle.style.pack.v1";
const VARIANT_KEY = "quaver.sparkle.style.variant.v1";
const SUSPEND_KEY = "quaver.sparkle.style.suspended.v1";

const readStr = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};

const state = (): SparkleStyleState => ({
  packId: readStr(PACK_KEY),
  variantId: readStr(VARIANT_KEY),
  suspended: readStr(SUSPEND_KEY) === "1",
});

/** 主题风格相对常驻层的默认抬升（同 order 时主题压过常驻层） */
const VARIANT_ORDER_BASE = 1000;

// —— 已注入节点 bookkeeping ——

/** key（registry 给的唯一键或 `variant:<pack>/<variant>`）→ <style> */
const injected = new Map<string, HTMLStyleElement>();

const cssOf = (css: string) => {
  // 插件给的是任意 CSS 片段。**空 CSS 直接跳过**：凭空插一张空 style 不会显示任何东西，
  // 却会实打实占掉一层顺序，把后面同 order 的层压下去。
  return (css ?? "").trim();
};

const dropStyle = (key: string) => {
  injected.get(key)?.remove();
  injected.delete(key);
};

/** 排好序的待注入列表：(order, seq, key, css) */
function plan(): { key: string; css: string; order: number; seq: number }[] {
  const out: { key: string; css: string; order: number; seq: number }[] = [];
  let seq = 0;
  // 常驻层：全部注入（除非总闸拉下）
  for (const e of sparkleStyleLayers() as StyleLayerEntry[]) {
    const css = cssOf(e.layer.css);
    if (!css) continue;
    out.push({ key: e.key, css, order: e.layer.order ?? 0, seq: seq++ });
  }
  // 主题风格：仅当前选中的那一张
  const st = state();
  if (st.packId && !st.suspended) {
    const entry = (sparkleThemePacks() as { pluginId: string; pack: SparkleThemePack }[])
      .find((e) => e.pack.id === st.packId);
    if (entry) {
      const v = entry.pack.variants.find((x) => x.id === st.variantId) ?? entry.pack.variants[0];
      if (v) {
        const css = cssOf(v.css);
        if (css) out.push({ key: `variant:${entry.pack.id}/${v.id}`, css, order: v.order ?? VARIANT_ORDER_BASE, seq: seq++ });
      }
    }
  }
  return out.sort((a, b) => a.order - b.order || a.seq - b.seq);
}

/**
 * 应用当前样式态：按 plan() 重排 head 里的 <style>。
 * 幂等且可反复调 —— 注册表变化、切换、停用都走这里。
 *
 * 实现上用「先全摘再按序重挂」而不是插入排序：样式层数量是几十量级，全摘重挂
 * 代价可忽略，换来的是层序**不可能**错乱（插入排序要处理「移动已存在的节点」，
 * 那是典型的顺序 bug 温床）。
 */
function apply() {
  const want = plan();
  const wantKeys = new Set(want.map((w) => w.key));

  // 摘掉不再需要的（含切走的风格、被停用插件的层、孤儿回落）
  for (const key of [...injected.keys()]) {
    if (!wantKeys.has(key)) dropStyle(key);
  }
  // 全摘重挂（保序）
  for (const key of [...injected.keys()]) injected.get(key)!.remove();
  injected.clear();

  for (const w of want) {
    const el = document.createElement("style");
    el.dataset.sparkleStyle = w.key;
    el.textContent = w.css;
    document.head.append(el);
    injected.set(w.key, el);
  }

  syncScheme();
  emit();
}

/**
 * color-scheme 协调：风格的 scheme 决定原生控件/滚动条/表单的明暗。
 * 宿主 html[data-theme] 是「跟随系统」驱动的，主题风格若只改 CSS 不改它，
 * 就会出现「暗底页面 + 亮色滚动条」这类割裂。这里把风格声明的 scheme 写到
 * <html> 上（与 data-theme 同级，具体性够高且不冲突 —— data-theme 仍管背景变量）。
 * 未声明 scheme 的风格不动它（尊重用户的跟随系统设置）。
 */
function syncScheme() {
  const root = document.documentElement;
  const st = state();
  if (st.suspended || !st.packId) {
    delete root.dataset.sparkleScheme;
    return;
  }
  const entry = (sparkleThemePacks() as { pluginId: string; pack: SparkleThemePack }[])
    .find((e) => e.pack.id === st.packId);
  const v = entry?.pack.variants.find((x) => x.id === st.variantId) ?? entry?.pack.variants[0];
  if (v?.scheme) root.dataset.sparkleScheme = v.scheme;
  else delete root.dataset.sparkleScheme;
}

// —— 变化订阅 ——

const listeners = new Set<(s: SparkleStyleState) => void>();
const emit = () => {
  const st = state();
  for (const cb of [...listeners]) { try { cb(st); } catch (e) { console.warn("[sparkle] 样式订阅回调抛错", e); } }
};

export const styleState = (): SparkleStyleState => state();
export const stylePacks = (): { pluginId: string; pack: SparkleThemePack }[] =>
  (sparkleThemePacks() as { pluginId: string; pack: SparkleThemePack }[]).map((e) => ({ ...e }));

export function activateStyle(packId: string, variantId?: string): SparkleStyleState {
  const entry = (sparkleThemePacks() as { pluginId: string; pack: SparkleThemePack }[])
    .find((e) => e.pack.id === packId);
  // 目标不存在：静默回落当前态（插件可能正基于旧状态做判断，不该被 activate 抛崩）
  if (!entry) return state();
  const v = variantId ? entry.pack.variants.find((x) => x.id === variantId) : entry.pack.variants[0];
  const resolved = v ?? entry.pack.variants[0];
  if (!resolved) return state();
  localStorage.setItem(PACK_KEY, entry.pack.id);
  localStorage.setItem(VARIANT_KEY, resolved.id);
  apply();
  return state();
}

export function resetStyle(): SparkleStyleState {
  localStorage.removeItem(PACK_KEY);
  localStorage.removeItem(VARIANT_KEY);
  apply();
  return state();
}

export function setStyleSuspended(v: boolean): SparkleStyleState {
  if (v) localStorage.setItem(SUSPEND_KEY, "1");
  else localStorage.removeItem(SUSPEND_KEY);
  apply();
  return state();
}

/** 订阅样式状态变化 */
export function onStyleChange(cb: (s: SparkleStyleState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// —— 与插件生命周期的接线 ——

/**
 * 启动时调一次：订阅注册表变化 + 做一次孤儿回落。
 *
 * 孤儿回落必须在**每次注册表变化**时做，不只是启动时：插件停用是运行时发生的，
 * 那时 localStorage 仍指着它的包，不回落就等于用户被卡死（设置页里已无从选中
 * 别的包来覆盖这个指向）。
 */
export function initStyleLayer() {
  onSparkleChange(() => {
    const st = state();
    if (st.packId && !sparkleThemePacks().some((e) => e.pack.id === st.packId)) {
      // 选中的包已经没人提供了（插件停用/卸载）→ 静默回落，不弹 toast 打扰
      localStorage.removeItem(PACK_KEY);
      localStorage.removeItem(VARIANT_KEY);
    }
    apply();
  });
  apply();
}

/** 单张常驻样式层的注入口（ctx.style.register 走这里）。
 *  返回反注册函数 = 从登记表摘掉自己的条目 + 摘掉 <style>。
 *  key 由 registry 生成（带序号，插件侧拼不出来），必须用它反查，别自己拼 id。 */
export function mountStyleLayer(pluginId: string, layer: SparkleStyleLayer): () => void {
  const key = sparkRegisterStyleLayer(pluginId, layer);
  // 登记即触发 onSparkleChange → apply()，把 style 挂上；这里只记下反注册所需的 key。
  return () => {
    dropStyle(key);
    // 登记表里的条目由 registry 的 teardown 摘除（插件停用时）；若插件是「运行中主动
    // 反注册」而非停用，teardown 不会跑，这里手动摘登记 + 重排。
    sparkUnregisterStyleLayer(key);
    apply();
  };
}
