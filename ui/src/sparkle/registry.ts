// Sparkle — 插件注册表（纯数据，**零 ui 模块依赖**，只 import SDK 类型）
//
// 为什么这一层必须干净：shell.ts / player.ts / SongMenu.ts 都要从这里读数据，
// 反向 import 任何 ui 模块都会成环。会碰 ui 模块的代码（toast / player 门面 /
// nav DOM）全部在 host.ts，只被 main.ts 与 views.ts 消费。
//
// 每个注册动作都会往对应插件 record 的 teardown 里 push 一个反注册闭包 ——
// 停用插件 = 倒序跑完 teardown，宿主的各个接入点就自动回到无插件形态。
import type {
  SparkleKaraokeProvider,
  SparkleMenuItem,
  SparkleNavItem,
  SparkleNpView,
  SparkleNpWidget,
  SparkleSettingsSection,
  SparkleSongMenuCtx,
  SparkleSonglistGroup,
  SparkleStreamSource,
  SparkleStyleLayer,
  SparkleTheme,
  SparkleThemePack,
  SparkleView,
} from "@quaver/sparkle";

export interface SparklePluginRecord {
  pluginId: string;
  /** 反注册闭包（倒序执行） */
  teardown: (() => void)[];
  /** setup() 返回的 dispose */
  dispose?: () => void;
}

interface NavEntry extends SparkleNavItem { pluginId: string }
interface SonglistGroupEntry { pluginId: string; group: SparkleSonglistGroup }
interface SettingsSectionEntry {
  pluginId: string;
  section: SparkleSettingsSection;
  /** 设置页面板 render 后回填的清理函数（面板销毁 / 插件停用时调用） */
  cleanup?: (() => void) | null;
}
interface ThemeEntry extends SparkleTheme { pluginId: string }
/** 常驻样式层：插件启用即生效，与主题包选择无关（层序由 order 定） */
export interface StyleLayerEntry { pluginId: string; layer: SparkleStyleLayer; key: string }
interface ThemePackEntry { pluginId: string; pack: SparkleThemePack }
interface NpWidgetEntry { pluginId: string; widget: SparkleNpWidget; cleanup: (() => void) | null }
interface NpViewEntry { pluginId: string; view: SparkleNpView }
interface MenuItemEntry {
  pluginId: string;
  item: SparkleMenuItem | ((ctx: SparkleSongMenuCtx) => SparkleMenuItem);
}
interface StreamSourceEntry { pluginId: string; source: SparkleStreamSource }
interface KaraokeProviderEntry { pluginId: string; provider: SparkleKaraokeProvider }
interface ViewEntry { pluginId: string; path: string; view: SparkleView }

const navItems: NavEntry[] = [];
const songlistGroups: SonglistGroupEntry[] = [];
const settingsSections: SettingsSectionEntry[] = [];
const themes: ThemeEntry[] = [];
const styleLayers: StyleLayerEntry[] = [];
const themePacks: ThemePackEntry[] = [];
const npWidgets: NpWidgetEntry[] = [];
const npViews: NpViewEntry[] = [];
const menuItems: MenuItemEntry[] = [];
const streamSources: StreamSourceEntry[] = [];
const karaokeProviders: KaraokeProviderEntry[] = [];
const pluginViews = new Map<string, ViewEntry>(); // key: path

/** 活动插件表（pluginId → record）；host.ts 维护，registry 只读它写 teardown */
const records = new Map<string, SparklePluginRecord>();
export const sparkRecordOf = (id: string) => records.get(id);
export const sparkActiveIds = () => [...records.keys()];

/** 注册表变化订阅（设置页面板据此重画插件设置区） */
const changeListeners = new Set<() => void>();
export const onSparkleChange = (cb: () => void) => {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
};
const emitChange = () => { for (const cb of [...changeListeners]) { try { cb(); } catch { /* 面板已死 */ } } };

const teardownOf = (pluginId: string) => records.get(pluginId)?.teardown
  ?? (records.set(pluginId, { pluginId, teardown: [] }), records.get(pluginId)!.teardown);

// —— register*（host.ts 经 SparkleContext 暴露给插件；pluginId 由 ctx 闭包提供） ——

export function sparkRegisterView(pluginId: string, path: string, view: SparkleView) {
  const p = path.startsWith("/") ? path : "/" + path;
  if (pluginViews.has(p)) throw new Error(`路由 ${p} 已被注册`);
  pluginViews.set(p, { pluginId, path: p, view });
  teardownOf(pluginId).push(() => pluginViews.delete(p));
  emitChange();
}

export function sparkRegisterNav(pluginId: string, item: SparkleNavItem) {
  const entry: NavEntry = { ...item, pluginId };
  navItems.push(entry);
  teardownOf(pluginId).push(() => {
    const at = navItems.indexOf(entry);
    if (at >= 0) navItems.splice(at, 1);
  });
  emitChange();
}

export function sparkRegisterSonglistGroup(pluginId: string, group: SparkleSonglistGroup) {
  const entry: SonglistGroupEntry = { pluginId, group };
  songlistGroups.push(entry);
  teardownOf(pluginId).push(() => {
    const at = songlistGroups.indexOf(entry);
    if (at >= 0) songlistGroups.splice(at, 1);
  });
  emitChange();
}

export function sparkRegisterSettingsSection(pluginId: string, section: SparkleSettingsSection) {
  const entry: SettingsSectionEntry = { pluginId, section };
  settingsSections.push(entry);
  teardownOf(pluginId).push(() => {
    const at = settingsSections.indexOf(entry);
    if (at >= 0) settingsSections.splice(at, 1);
    entry.cleanup?.();
  });
  emitChange();
}

export function sparkRegisterTheme(pluginId: string, theme: SparkleTheme) {
  const entry: ThemeEntry = { ...theme, pluginId };
  themes.push(entry);
  teardownOf(pluginId).push(() => {
    const at = themes.indexOf(entry);
    if (at >= 0) themes.splice(at, 1);
  });
  emitChange();
}

// —— 样式层 / 主题包 ——
//
// 这里只做**登记**：真正的 <style> 注入与层序排布在 sparkle/style-layer.ts（要碰
// document.head）。teardown 里只摘登记，具体清理由 style-layer 订阅注册表变化后
// 自己完成（它已经知道自己注入了什么，无需宿主再传一遍回调）。
//
// key 用「pluginId + 层 id + 递增序号」：同一插件可以注册多张同 id 的层（比如按变体
// 各一张），序号兜住重复注册，不让后一张顶掉前一张的登记。**key 必须由本函数生成并
// 回填给调用方**（registerStyleLayer 返回它）—— 反注册时 style-layer 靠它精确摘
// 那一张，自己按 `${pluginId}:${id}` 拼是拼不出来的（少了序号）。

let layerSeq = 0;

export function sparkRegisterStyleLayer(pluginId: string, layer: SparkleStyleLayer): string {
  const key = `${pluginId}:${layer.id}#${++layerSeq}`;
  const entry: StyleLayerEntry = { pluginId, layer, key };
  styleLayers.push(entry);
  teardownOf(pluginId).push(() => {
    const at = styleLayers.indexOf(entry);
    if (at >= 0) styleLayers.splice(at, 1);
  });
  emitChange();
  return key;
}

export function sparkRegisterThemePack(pluginId: string, pack: SparkleThemePack) {
  const entry: ThemePackEntry = { pluginId, pack };
  themePacks.push(entry);
  teardownOf(pluginId).push(() => {
    const at = themePacks.indexOf(entry);
    if (at >= 0) themePacks.splice(at, 1);
  });
  emitChange();
}

/** 按 key 摘掉一张样式层的登记（插件运行中主动反注册用；停用路径走 teardown） */
export function sparkUnregisterStyleLayer(key: string): boolean {
  const at = styleLayers.findIndex((e) => e.key === key);
  if (at < 0) return false;
  styleLayers.splice(at, 1);
  emitChange();
  return true;
}

export function sparkRegisterNpWidget(pluginId: string, widget: SparkleNpWidget, mount: (w: SparkleNpWidget) => (() => void) | null) {
  const entry: NpWidgetEntry = { pluginId, widget, cleanup: mount(widget) };
  npWidgets.push(entry);
  teardownOf(pluginId).push(() => {
    const at = npWidgets.indexOf(entry);
    if (at >= 0) npWidgets.splice(at, 1);
    entry.cleanup?.();
    entry.cleanup = null;
  });
  emitChange();
}

/** 正在播放页整页接管视图：先注册先得（与逐字提供器同一口径，先到先接管） */
export function sparkRegisterNpView(pluginId: string, view: SparkleNpView) {
  const entry: NpViewEntry = { pluginId, view };
  npViews.push(entry);
  teardownOf(pluginId).push(() => {
    const at = npViews.indexOf(entry);
    if (at >= 0) npViews.splice(at, 1);
  });
  emitChange();
}

export function sparkRegisterSongMenuItem(pluginId: string, item: MenuItemEntry["item"]) {
  const entry: MenuItemEntry = { pluginId, item };
  menuItems.push(entry);
  teardownOf(pluginId).push(() => {
    const at = menuItems.indexOf(entry);
    if (at >= 0) menuItems.splice(at, 1);
  });
  emitChange();
}

export function sparkRegisterStreamSource(pluginId: string, source: SparkleStreamSource) {
  const entry: StreamSourceEntry = { pluginId, source };
  streamSources.push(entry);
  teardownOf(pluginId).push(() => {
    const at = streamSources.indexOf(entry);
    if (at >= 0) streamSources.splice(at, 1);
  });
  emitChange();
}

export function sparkRegisterKaraokeProvider(pluginId: string, provider: SparkleKaraokeProvider) {
  const entry: KaraokeProviderEntry = { pluginId, provider };
  karaokeProviders.push(entry); // 先注册先得：宿主只消费 sparkleKaraokeProvider() 的第一个
  teardownOf(pluginId).push(() => {
    const at = karaokeProviders.indexOf(entry);
    if (at >= 0) karaokeProviders.splice(at, 1);
  });
  emitChange();
}

export function sparkRecordInit(record: SparklePluginRecord) { records.set(record.pluginId, record); }
export function sparkRecordDrop(pluginId: string) { records.delete(pluginId); }

// —— 宿主接入点读取（shell / player / SongMenu / views 消费） ——

export const sparkleViewAt = (path: string): SparkleView | null => pluginViews.get(path)?.view ?? null;
/** 某插件注册过的全部路由（disable 时判断当前页是否要跳走） */
export const sparklePluginRoutes = (pluginId: string): string[] =>
  [...pluginViews.entries()].filter(([, e]) => e.pluginId === pluginId).map(([p]) => p);
export const sparkleNavItems = (): SparkleNavItem[] => navItems;
export const sparkleSonglistGroups = (): SparkleSonglistGroup[] => songlistGroups.map((e) => e.group);
export const sparkleSettingsSections = (): SettingsSectionEntry[] => settingsSections;
export const sparkleThemes = (): ThemeEntry[] => themes;

/** 当前**激活**的那个主题（含它的 tint / background 声明）；没启用主题 / 主题已消失 = null。
 *
 *  真相在 <html data-sparkle-theme>（host.applySparkleTheme 维护），这里只是把它读回注册表。
 *  为什么不从 host.ts 导：host 反向依赖 shell，而本模块被 shell/player/tint/ambient 读 ——
 *  让消费方 import host 会成环。三个消费方（lib/tint、lib/ambient、设置页）共用这一份，
 *  免得「激活主题怎么找」出现第三、第四份实现。
 *  `typeof document` 兜底：本模块会被 scripts/verify-sparkle.ts 在 node 里直接 import。 */
export function sparkleActiveTheme(): SparkleTheme | null {
  const id = typeof document === "undefined" ? "" : (document.documentElement.dataset.sparkleTheme ?? "");
  if (!id) return null;
  return themes.find((t) => t.id === id) ?? null;
}
/** 已登记的常驻样式层（style-layer.ts 订阅本表并注入 <style>） */
export const sparkleStyleLayers = (): StyleLayerEntry[] => styleLayers;
/** 已登记的主题包（按注册序） */
export const sparkleThemePacks = (): ThemePackEntry[] => themePacks;
export const sparkleNpWidgets = (): NpWidgetEntry[] => npWidgets;
/** 正在播放页接管视图（首个注册者；无 = 宿主走默认 np 布局）。
 *  enabled() 由消费方（np-view.ts）每次 notify 重读，不在这里判。 */
export const sparkleNpView = (): SparkleNpView | null => npViews[0]?.view ?? null;
export const sparkleStreamSources = (): SparkleStreamSource[] => streamSources.map((e) => e.source);
/** 逐字歌词提供器（首个注册者；无 = 宿主走纯 LRC 行级歌词） */
export const sparkleKaraokeProvider = (): SparkleKaraokeProvider | null => karaokeProviders[0]?.provider ?? null;

/** 歌曲右键菜单的插件追加项（ctx 逐次求值：函数型条目按当时上下文生成） */
export function sparkleMenuItems(ctx: SparkleSongMenuCtx): SparkleMenuItem[] {
  const out: SparkleMenuItem[] = [];
  for (const e of menuItems) {
    try {
      out.push(typeof e.item === "function" ? e.item(ctx) : e.item);
    } catch (err) {
      console.warn(`[sparkle:${e.pluginId}] 菜单项生成失败`, err);
    }
  }
  return out;
}
