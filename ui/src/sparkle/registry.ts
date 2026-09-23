// Sparkle — 插件注册表（纯数据，**零 ui 模块依赖**，只 import SDK 类型）
//
// 为什么这一层必须干净：shell.ts / player.ts / SongMenu.ts 都要从这里读数据，
// 反向 import 任何 ui 模块都会成环。会碰 ui 模块的代码（toast / player 门面 /
// nav DOM）全部在 host.ts，只被 main.ts 与 views.ts 消费。
//
// 每个注册动作都会往对应插件 record 的 teardown 里 push 一个反注册闭包 ——
// 停用插件 = 倒序跑完 teardown，宿主的各个接入点就自动回到无插件形态。
import type {
  SparkleMenuItem,
  SparkleNavItem,
  SparkleNpWidget,
  SparkleSettingsSection,
  SparkleSongMenuCtx,
  SparkleSonglistGroup,
  SparkleStreamSource,
  SparkleTheme,
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
interface NpWidgetEntry { pluginId: string; widget: SparkleNpWidget; cleanup: (() => void) | null }
interface MenuItemEntry {
  pluginId: string;
  item: SparkleMenuItem | ((ctx: SparkleSongMenuCtx) => SparkleMenuItem);
}
interface StreamSourceEntry { pluginId: string; source: SparkleStreamSource }
interface ViewEntry { pluginId: string; path: string; view: SparkleView }

const navItems: NavEntry[] = [];
const songlistGroups: SonglistGroupEntry[] = [];
const settingsSections: SettingsSectionEntry[] = [];
const themes: ThemeEntry[] = [];
const npWidgets: NpWidgetEntry[] = [];
const menuItems: MenuItemEntry[] = [];
const streamSources: StreamSourceEntry[] = [];
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
export const sparkleNpWidgets = (): NpWidgetEntry[] => npWidgets;
export const sparkleStreamSources = (): SparkleStreamSource[] => streamSources.map((e) => e.source);

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
