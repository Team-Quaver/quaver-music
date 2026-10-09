// Sparkle — 宿主侧：SparkleContext 工厂 + 插件生命周期（enable/disable）
//
// registry.ts 保持零 ui 依赖；所有会碰 ui 模块的接线都在这里：
// toast（SongMenu）、player 门面（player.ts）、nav DOM（shell.addNavItem）、
// 侧栏重画（shell.repaintSidebarPlaylists）、主题 CSS 注入（document.head）。
import type { SparkleContext, SparkleNpWidget, SparklePlugin, SparklePlayerFacade, SparkleTheme } from "@quaver/sparkle";
import { toast } from "../components/SongMenu";
import { OFFICIAL_META } from "./loader";
import { player } from "../player";
import { addNavItem, repaintSidebarPlaylists } from "../shell";
import {
  activateStyle, mountStyleLayer, onStyleChange, resetStyle, stylePacks, styleState,
} from "./style-layer";
import {
  sparkRecordDrop, sparkRecordInit, sparkRecordOf,
  sparkRegisterKaraokeProvider, sparkRegisterNav, sparkRegisterNpView, sparkRegisterNpWidget,
  sparkRegisterSettingsSection, sparkRegisterSongMenuItem, sparkRegisterSonglistGroup,
  sparkRegisterStreamSource, sparkRegisterTheme, sparkRegisterThemePack, sparkRegisterView,
  sparklePluginRoutes, sparkleThemes,
  type SparklePluginRecord,
} from "./registry";

// —— 持久化（localStorage；打包态固定端口 4174 → origin 稳定） ——

const ENABLED_KEY = "quaver.sparkle.enabled.v1";
const THEME_KEY = "quaver.sparkle.theme.v1";
/** 官方插件被用户显式停用的标记（string[]；新官方插件默认启用时跳过这些 id） */
const OFFICIAL_OFF_KEY = "quaver.sparkle.official-off.v1";

/** 被用户显式停用过的官方插件 id（init 播种「新官方插件默认启用」时跳过） */
export const sparkOfficialOffIds = (): string[] => readList(OFFICIAL_OFF_KEY);

const readList = (key: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const writeEnabled = (ids: string[]) => localStorage.setItem(ENABLED_KEY, JSON.stringify(ids));

export const sparkEnabledIds = () => readList(ENABLED_KEY);
export const sparkSetEnabledIds = (ids: string[]) => writeEnabled([...new Set(ids)]);

/** 激活中的 sparkle 主题 id（null = 未激活） */
export const sparkActiveThemeId = (): string | null => localStorage.getItem(THEME_KEY);
export const sparkActivateTheme = (id: string | null) => {
  if (id) localStorage.setItem(THEME_KEY, id);
  else localStorage.removeItem(THEME_KEY);
  applySparkleTheme();
};

/** 主题注入/切换：每个主题一个 <style>，选择器 html[data-sparkle-theme="<id>"] 特异性
 *  高于 html[data-theme]，未覆盖的变量自然回落底层明/暗两态。 */
function applySparkleTheme() {
  const active = sparkActiveThemeId();
  const root = document.documentElement;
  if (!active || !sparkleThemes().some((t) => t.id === active)) {
    delete root.dataset.sparkleTheme;
    return;
  }
  root.dataset.sparkleTheme = active;
}

function injectThemeStyle(t: SparkleTheme) {
  const style = document.createElement("style");
  style.dataset.sparkleThemeStyle = t.id;
  style.textContent = `html[data-sparkle-theme="${t.id}"]{${t.css}}`;
  document.head.append(style);
  return () => style.remove();
}

// —— player 只读门面 ——

const playerFacade: SparklePlayerFacade = {
  get current() {
    const s = player.current;
    return s ? { mid: s.mid, name: s.name, singer: s.singer, album: s.album, interval: s.interval } : null;
  },
  get time() { return player.time; },
  get paused() { return player.paused; },
  on(cb) { return player.on(cb); },
};

// —— SparkleContext 工厂 ——

/**
 * 每个插件一份 ctx。样式门面在此**按插件现构造**（不能做成模块级单例：
 * register 要用 pluginId 登记层，单例会串味）。门面只给三件事 ——
 * 追加自己的层、读已注册的主题包、请求切换（由宿主裁决：目标不存在则静默
 * 返回当前态，不抛 —— 插件常基于上一帧状态做后续判断，activate 失败不该
 * 把它的 setup 炸掉）。插件**不能**直接操作别人注入的 <style>。
 */
function makeContext(pluginId: string): SparkleContext {
  const log = {
    info: (...a: unknown[]) => console.info(`[sparkle:${pluginId}]`, ...a),
    warn: (...a: unknown[]) => console.warn(`[sparkle:${pluginId}]`, ...a),
    error: (...a: unknown[]) => console.error(`[sparkle:${pluginId}]`, ...a),
  };
  const pfx = `sparkle.${pluginId}.`;
  return {
    pluginId,
    registerView: (path, view) => sparkRegisterView(pluginId, path, view),
    registerNav: (item) => {
      sparkRegisterNav(pluginId, item);
      // nav DOM 立即补挂（teardown 由 host 的通用清理承担不了 DOM，addNavItem 的返回值
      // 存进 record 由 disable 时移除 —— 这里借 teardown 通道挂 DOM 清理）
      const el = addNavItem(item);
      sparkRecordOf(pluginId)?.teardown.push(() => el.remove());
    },
    registerSonglistGroup: (group) => {
      sparkRegisterSonglistGroup(pluginId, group);
      repaintSidebarPlaylists();
    },
    registerSettingsSection: (section) => sparkRegisterSettingsSection(pluginId, section),
    registerTheme: (theme) => {
      sparkRegisterTheme(pluginId, theme);
      const remove = injectThemeStyle(theme);
      applySparkleTheme(); // 若停用的正是激活主题，applySparkleTheme 已在 teardown 里回落
      sparkRecordOf(pluginId)?.teardown.push(() => {
        remove();
        if (sparkActiveThemeId() === theme.id) sparkActivateTheme(null);
        else applySparkleTheme();
      });
    },
    registerStyleLayer: (layer) => {
      // 登记 + 注入由 style-layer 统一管（层序/生命周期只有一处真相）
      sparkRecordOf(pluginId)?.teardown.push(mountStyleLayer(pluginId, layer));
    },
    registerThemePack: (pack) => sparkRegisterThemePack(pluginId, pack),
    registerNowPlayingWidget: (widget) => {
      const mount = (w: SparkleNpWidget) => {
        const slot = document.getElementById("np-plugin-widgets");
        if (!slot) return null; // 正在播放页还没挂（理论上 initSparkle 晚于 bootShell，不会发生）
        const box = document.createElement("div");
        box.className = "np-widget";
        box.dataset.plugin = pluginId;
        slot.append(box);
        const cleanup = w.render(box) ?? null;
        return () => {
          cleanup?.();
          box.remove();
        };
      };
      sparkRegisterNpWidget(pluginId, widget, mount);
    },
    // 整页接管：不立即挂载 —— 由 np-view.ts 在正在播放页的 notify 里按 enabled() 决定
    registerNowPlayingView: (view) => sparkRegisterNpView(pluginId, view),
    registerSongMenuItem: (item) => sparkRegisterSongMenuItem(pluginId, item),
    registerStreamSource: (source) => sparkRegisterStreamSource(pluginId, source),
    registerKaraokeProvider: (provider) => sparkRegisterKaraokeProvider(pluginId, provider),
    storage: {
      get: (k) => localStorage.getItem(pfx + k),
      set: (k, v) => localStorage.setItem(pfx + k, v),
      remove: (k) => localStorage.removeItem(pfx + k),
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(pfx)) out.push(key.slice(pfx.length));
        }
        return out;
      },
    },
    toast: (msg, kind) => toast(msg, kind),
    log,
    player: playerFacade,
    // 样式门面按插件现构造（register 要用 pluginId 去登记层；单例会串味）
    style: {
      register: (layer) => mountStyleLayer(pluginId, layer),
      packs: () => stylePacks().map((e) => e.pack),
      state: () => styleState(),
      activate: (packId, variantId) => activateStyle(packId, variantId),
      reset: () => resetStyle(),
      onChange: (cb) => onStyleChange(cb),
    },
  };
}

// —— 生命周期 ——

const broken = new Set<string>(); // setup 抛错的插件（本会话内不再尝试）

/** setup 失败的插件 id（设置页据此显示「启动失败」态） */
export const sparkIsBroken = (id: string) => broken.has(id);

export const isSparkleActive = (id: string) => !!sparkRecordOf(id);

/** 启用插件：加载 → 校验 → setup。返回是否成功；失败不打断调用方（init 逐个续跑） */
export async function enableSparklePlugin(plugin: SparklePlugin): Promise<boolean> {
  const { id } = plugin;
  if (sparkRecordOf(id) || broken.has(id)) return sparkRecordOf(id) !== undefined;
  const record: SparklePluginRecord = { pluginId: id, teardown: [] };
  sparkRecordInit(record); // 先入表：setup 内 register* 的 teardown 才有落点
  try {
    const dispose = plugin.setup(makeContext(id));
    if (typeof dispose === "function") record.dispose = dispose;
    sparkSetEnabledIds([...sparkEnabledIds(), id]);
    if (OFFICIAL_META.some((m) => m.id === id)) {
      localStorage.setItem(OFFICIAL_OFF_KEY, JSON.stringify(sparkOfficialOffIds().filter((x) => x !== id)));
    }
    return true;
  } catch (e) {
    // 回滚已注册的半截资源，标记 broken；宿主各接入点自动回到无插件形态
    for (const fn of [...record.teardown].reverse()) { try { fn(); } catch { /* 尽力清理 */ } }
    sparkRecordDrop(id);
    broken.add(id);
    console.error(`[sparkle:${id}] setup 失败`, e);
    toast(`插件 ${plugin.name ?? id} 启动失败`, "err");
    return false;
  }
}

/** 停用插件：倒序反注册 + dispose，启用集合移除 */
export function disableSparklePlugin(id: string) {
  const record = sparkRecordOf(id);
  if (!record) return;
  // 当前路由若属于该插件 → 先跳走（views 表随后查不到，shell 的回落只对未知路径兜底，
  // 但留在插件页上时页面内容不会被自动清掉，主动跳走更干净）
  const cur = "/" + location.hash.replace(/^#\//, "").split("?")[0];
  const routes = sparklePluginRoutes(id);
  for (const fn of [...record.teardown].reverse()) { try { fn(); } catch (e) { console.warn(`[sparkle:${id}] teardown`, e); } }
  try { record.dispose?.(); } catch (e) { console.warn(`[sparkle:${id}] dispose`, e); }
  sparkRecordDrop(id);
  sparkSetEnabledIds(sparkEnabledIds().filter((x) => x !== id));
  if (OFFICIAL_META.some((m) => m.id === id)) {
    localStorage.setItem(OFFICIAL_OFF_KEY, JSON.stringify([...new Set([...sparkOfficialOffIds(), id])]));
  }
  if (routes.includes(cur)) location.hash = "#/";
  applySparkleTheme(); // 激活主题若属于该插件，teardown 已清掉 style；这里兜底回落默认
}

export { applySparkleTheme };
