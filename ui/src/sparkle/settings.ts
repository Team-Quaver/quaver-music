// Sparkle — 设置页 Sparkle tab 的面板（ui/src/views/settings.ts 的 settingsView 填充）
//
// 三个相互隔离的标签：① 主题（已装主题，开关=启停提供它的插件；切换去 设置→外观）
// ② 插件（已装插件）③ Marketplace（浏览/安装 + 红色渐变的「添加本地插件」）。
// 行内齿轮按钮就地弹窗渲染该插件的设置区
// （components/PluginSettingsDialog.ts），设置不再常驻页面。
// 索引条目 category: "theme" | "plugin"，缺省按 plugin；安装时把 category 写进
// plugin.json，已装列表据此归入 主题/插件 两个标签。旧的 extension 归入插件。
import { DEFAULT_MARKET_URL } from "@quaver/sparkle/market/default-index";
import { compareSparkleVersions, getSparkleHostVersionError } from "../../electron/sparkle-version.ts";
import { showPluginSettingsDialog } from "../components/PluginSettingsDialog";
import { showLocalPluginDialog } from "../components/LocalPluginDialog";
import { toast } from "../components/SongMenu";
import {
  applySparkleTheme, disableSparklePlugin, enableSparklePlugin, sparkActiveThemeId, sparkEnabledIds, sparkIsBroken,
} from "./host";
import {
  listInstalledThirdParty, loadOfficial, loadThirdParty, OFFICIAL_META, validatePlugin,
  type InstalledPlugin,
} from "./loader";
import { sparkIdBlacklisted, sparkRedflag } from "./policy";
import { onSparkleChange, sparkleIsThemeOnly, sparkRecordOf, sparkleSettingsSections } from "./registry";
import {
  activateStyle, onStyleChange, resetStyle, setStyleSuspended, stylePacks, styleState,
} from "./style-layer";

type MarketEntry = SparkleMarketPluginEntry;

/** 索引条目分类；未知/缺省/旧 extension 一律按 plugin（主题是显式声明才有的分类） */
type MarketCategory = "theme" | "plugin";

const catOf = (c: string | undefined): MarketCategory => (c === "theme" ? "theme" : "plugin");
const CAT_LABEL: Record<MarketCategory, string> = { theme: "主题", plugin: "插件" };

// —— 徽标口径 ——
// ① 宿主内置（OFFICIAL_META）恒为「预装」；
// ② Marketplace 装进来的按 author 分：Team Quaver → 「官方」，其余 → 「第三方」。
// 徽标只回答「谁发布的」：来源决定配色（官方蓝 / 第三方紫），分类交给所在标签页
// （待在「插件」标签里的当然是插件），不在文字里重复。Marketplace 目录那几行反过来 ——
// 它回答的是「这是什么」，所以仍只打分类徽标。
const OFFICIAL_AUTHOR = "team quaver";
const isTeamQuaver = (author: unknown) => String(author ?? "").trim().toLowerCase() === OFFICIAL_AUTHOR;

const sourceBadge = (author: unknown): { cls: string; text: string } =>
  isTeamQuaver(author) ? { cls: "official", text: "官方" } : { cls: "third-party", text: "第三方" };

// —— Marketplace 更新偏好 ——
// 默认关闭：更新会执行第三方新代码，必须用户显式授权；坏值一律视为关闭。
const AUTO_UPDATE_KEY = "quaver.sparkle.market.auto-update.v1";

const autoUpdateEnabled = () => {
  try { return localStorage.getItem(AUTO_UPDATE_KEY) === "1"; } catch { return false; }
};

const setAutoUpdateEnabled = (on: boolean) => {
  try {
    if (on) localStorage.setItem(AUTO_UPDATE_KEY, "1");
    else localStorage.removeItem(AUTO_UPDATE_KEY);
  } catch { /* localStorage 不可用时保持默认关闭 */ }
};

const isNewerVersion = (a: unknown, b: unknown) => (compareSparkleVersions(a, b) ?? -1) > 0;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const base64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.2.61.77 1.03 1.51 1H21a2 2 0 1 1 0 4h-.09c-.74-.03-1.31.39-1.51 1z"/></svg>`;

// 卸载 = 垃圾桶（与齿轮同一套图标按钮尺寸）。破坏性动作靠 hover 转红提示，
// 文字信息交给 title/aria-label —— 行内动作区三个控件等宽，列才对得齐。
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;

export function mountSparklePanel(section: HTMLElement): () => void {
  section.innerHTML = "";

  // —— 三个分类标签（与设置页大 tab 同一套 .set-tab 形态，只管面板内显隐） ——
  const cats = document.createElement("div");
  cats.className = "set-tabs sparkle-cats";
  cats.innerHTML = `
    <button class="set-tab is-active" data-cat="theme" type="button">主题</button>
    <button class="set-tab" data-cat="plugin" type="button">插件</button>
    <button class="set-tab" data-cat="market" type="button">Marketplace</button>`;

  const mkPanel = (cat: string) => {
    const d = document.createElement("div");
    d.className = "sparkle-catpanel";
    d.dataset.cat = cat;
    d.hidden = cat !== "theme";

    return d;
  };

  const themePanel = mkPanel("theme");
  const pluginPanel = mkPanel("plugin");
  const marketPanel = mkPanel("market");
  cats.querySelectorAll<HTMLButtonElement>(".set-tab").forEach((t) => {
    t.onclick = () => {
      if (t.classList.contains("is-active")) return;
      cats.querySelectorAll(".set-tab").forEach((x) => x.classList.toggle("is-active", x === t));
      [themePanel, pluginPanel, marketPanel].forEach((p) => { p.hidden = p.dataset.cat !== t.dataset.cat; });
    };
  });

  // —— ① 主题：已装主题（开关启停提供它的插件；切换在 设置→外观） ——
  const themeGroup = document.createElement("div");
  themeGroup.className = "set-group";
  themeGroup.innerHTML = `
    <div class="set-label">已装主题 <span class="set-note-inline">切换主题直接去 设置 → 外观</span></div>
    <div class="sparkle-list sparkle-theme-rows"></div>
    <div class="sparkle-packs"></div>`;
  const themeRows = themeGroup.querySelector<HTMLElement>(".sparkle-theme-rows")!;
  const packsBox = themeGroup.querySelector<HTMLElement>(".sparkle-packs")!;

  // —— ② 插件：已装插件 ——
  const pluginGroup = document.createElement("div");
  pluginGroup.className = "set-group";
  pluginGroup.innerHTML = `
    <div class="set-label">已装插件 <span class="set-note-inline">第三方插件将在本地运行任意代码，请只安装信任来源</span></div>
    <div class="sparkle-list sparkle-plugin-rows"></div>`;
  const pluginRows = pluginGroup.querySelector<HTMLElement>(".sparkle-plugin-rows")!;

  // —— ③ Marketplace：本地安装 + 全量列表（与上面两个标签隔离） ——
  const marketGroup = document.createElement("div");
  marketGroup.className = "set-group";
  marketGroup.innerHTML = `
    <div class="set-label">Marketplace</div>
    <div class="sparkle-market-bar">
      <button class="ghost-btn ghost-btn--quiet sparkle-market-refresh" type="button">刷新</button>
      <label class="sparkle-switch sparkle-auto-update"><input type="checkbox"/> 自动更新</label>
      <button class="ghost-btn sparkle-local sparkle-local--danger" type="button">添加本地插件</button>
    </div>
    <p class="muted sparkle-warn">插件可以访问页面数据，请只安装信任来源。主题安装后自动启用；普通插件默认关闭，可在「插件」标签开启。</p>
    <div class="sparkle-mkt-cats">
      <button class="sparkle-mkt-chip is-active" data-mcat="all" type="button">全部</button>
      <button class="sparkle-mkt-chip" data-mcat="theme" type="button">主题</button>
      <button class="sparkle-mkt-chip" data-mcat="plugin" type="button">插件</button>
    </div>
    <div class="sparkle-market-list"></div>`;
  const marketRefresh = marketGroup.querySelector<HTMLButtonElement>(".sparkle-market-refresh")!;
  const autoUpdateInput = marketGroup.querySelector<HTMLInputElement>(".sparkle-auto-update input")!;
  const localBtn = marketGroup.querySelector<HTMLButtonElement>(".sparkle-local")!;
  const marketList = marketGroup.querySelector<HTMLElement>(".sparkle-market-list")!;

  themePanel.append(themeGroup);
  pluginPanel.append(pluginGroup);
  marketPanel.append(marketGroup);
  section.append(cats, themePanel, pluginPanel, marketPanel);

  // 安全模式（QUAVER_REDFLAG=1）：所有第三方插件都被拒之门外（含运行期手动开启），
  // 面板顶上明说一句 —— 否则用户只会看到开关点不动，以为坏了。
  const safeMode = sparkRedflag();
  const SAFE_MODE_LOCK = "安全模式（QUAVER_REDFLAG=1）已开启：仅预装插件可用，第三方插件全部禁用";

  if (safeMode) {
    const note = document.createElement("p");
    note.className = "muted sparkle-warn sparkle-lock-note";
    note.textContent = `${SAFE_MODE_LOCK}，安装入口同时上锁。`;
    cats.after(note);
  }

  // —— 渲染逻辑 ——

  let installedThird: InstalledPlugin[] = [];
  /** 一次索引拉取一处消费：loading（拉取中）/ error（拉取失败原因）/ entries */
  let market: { loading: boolean; error: string | null; entries: MarketEntry[] } = { loading: true, error: null, entries: [] };
  /** Marketplace 标签内部的分类筛选（all = 全量；条目本身始终带分类徽标） */
  let mcat: "all" | MarketCategory = "all";

  const installedCategory = (inst: InstalledPlugin): MarketCategory => catOf(
    typeof inst.manifest?.category === "string" ? inst.manifest.category : undefined,
  );

  /** 打开某插件的设置弹窗：把该插件注册的设置区渲染进弹窗（关闭时统一清理） */
  const openSettings = (pluginId: string, name: string) => {
    showPluginSettingsDialog({
      name,
      render: (box) => {
        const entries = sparkleSettingsSections().filter((e) => e.pluginId === pluginId);

        if (!entries.length) {
          const empty = document.createElement("div");
          empty.className = "sparkle-empty";
          empty.textContent = sparkRecordOf(pluginId) ? "该插件没有提供设置项" : "插件未启用，启用后可在这里配置";
          box.append(empty);

          return;
        }

        const cleanups: (() => void)[] = [];

        for (const entry of entries) {
          const wrap = document.createElement("div");
          wrap.style.marginBottom = "12px";
          const title = document.createElement("div");
          title.className = "set-label";
          title.textContent = entry.section.title;
          const body = document.createElement("div");
          wrap.append(title, body);

          try {
            entry.cleanup = entry.section.render(body) ?? null;
            cleanups.push(() => { entry.cleanup?.(); entry.cleanup = null; });
          } catch (e) {
            body.innerHTML = `<div class="sparkle-empty">设置区渲染失败（见控制台）</div>`;
            console.warn(`[sparkle:${entry.pluginId}] 设置区渲染失败`, e);
          }

          box.append(wrap);
        }

        return () => { for (const fn of [...cleanups].reverse()) { try { fn(); } catch { /* 尽力 */ } } };
      },
    });
  };

  const gearBtn = (pluginId: string, name: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sparkle-gear";
    b.title = "插件设置";
    b.setAttribute("aria-label", `${name} 设置`);
    b.innerHTML = GEAR_SVG;
    b.onclick = () => openSettings(pluginId, name);

    return b;
  };

  /** 已装内容行（主题/插件两个标签共用）：[齿轮] [垃圾桶=卸载] [启用开关] */
  const manageRow = (o: {
    id: string; name: string; version: string; author?: string; description?: string;
    badge: { cls: string; text: string };
    enabled: boolean; broken: boolean;
    /** 纯主题运行中：不画启停开关（启停交给外观页的主题选择） */
    hideSwitch?: boolean;
    /** 主题行只在插件真的提供设置区（高级选项）时显示齿轮；插件行恒显 */
    showGear: boolean;
    pluginId: string;
    /** 非空 = 这一行锁住（安全模式 / [Sparkle] Blacklist）：开关画出来但不可点，
     *  文字位显示原因 —— 只「点了没反应」会让人以为是坏了。 */
    lock?: string;
    onToggle: (on: boolean) => void; onUninstall?: () => void;
  }) => {
    const el = document.createElement("div");
    el.className = "sparkle-row";
    el.innerHTML = `
      <i class="sparkle-badge ${o.badge.cls}">${o.badge.text}</i>
      <div class="sparkle-main">
        <div class="sparkle-name">${esc(o.name)}<span class="ver">v${esc(o.version)}${o.author ? " · " + esc(o.author) : ""}</span></div>
        ${o.description ? `<div class="sparkle-desc">${esc(o.description)}</div>` : ""}
      </div>
      <div class="sparkle-actions"></div>`;
    const actions = el.querySelector<HTMLElement>(".sparkle-actions")!;

    // 追加顺序 = 视觉顺序 = Tab 顺序：齿轮 → 卸载 → 开关。
    // 卸载插在中间而不是末尾：开关是行的视觉锚点（恒在最右），而卸载只有部分行有
    // （预装没有），放末尾会把开关这一列整排推走（.sparkle-actions 的三列定宽兜住这点）。
    if (o.showGear) actions.append(gearBtn(o.pluginId, o.name));

    if (o.onUninstall) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sparkle-uninstall";
      btn.title = "卸载";
      btn.setAttribute("aria-label", `卸载 ${o.name}`);
      btn.innerHTML = TRASH_SVG;
      btn.onclick = () => o.onUninstall!();
      actions.append(btn);
    }

    if (!o.broken && !o.hideSwitch) {
      const sw = document.createElement("label");
      sw.className = "sparkle-switch";

      if (o.lock) sw.classList.add("is-locked");
      sw.innerHTML = `<input type="checkbox"${o.enabled ? " checked" : ""}${o.lock ? " disabled" : ""}/> ${o.lock ? esc(o.lock) : o.enabled ? "已启用" : "已停用"}`;
      const input = sw.querySelector<HTMLInputElement>("input")!;

      if (o.lock) {
        sw.title = o.lock;
        input.title = o.lock;
      } else {
        input.onchange = () => {
          sw.textContent = "";
          sw.append(input, document.createTextNode(input.checked ? "已启用" : "已停用"));
          o.onToggle(input.checked);
        };
      }

      actions.append(sw);
    }

    return el;
  };

  /** 第三方行为什么锁着（安全模式优先）；null = 不锁。事实源在 policy.ts，这里只是回显。 */
  const rowLock = (id: string): string | null => {
    if (safeMode) return "安全模式：第三方插件已禁用";

    if (sparkIdBlacklisted(id)) return "已在 [Sparkle] Blacklist 黑名单里";

    return null;
  };

  /** 预装行的锁：只有黑名单（安全模式不拦预装）。歌词渲染器不在这里 —— 它是宿主内置功能
   *  （src/lyrics/amll.ts），不是可停用的插件，设置页没有它那一行。 */
  const officialLock = (id: string): string | null =>
    sparkIdBlacklisted(id) ? "已在 [Sparkle] Blacklist 黑名单里" : null;

  /** 启停一个已装第三方插件（主题/插件两处标签共用同一套语义） */
  const toggleThird = async (inst: InstalledPlugin, on: boolean) => {
    // 兜底：UI 上开关已锁，但键盘/脚本仍可能触发；真正的事实源在 host.enableSparklePlugin
    const why = rowLock(inst.id);

    if (on && why) { toast(why, "err"); return; }

    try {
      if (on) await enableSparklePlugin(await loadThirdParty(inst));
      else disableSparklePlugin(inst.id);
    } catch (e) {
      toast(`插件 ${inst.id} 切换失败`, "err");
      console.warn(e);
    }

    renderRows();
  };

  const uninstallThird = async (inst: InstalledPlugin) => {
    const bridge = window.quaverSparkle;

    if (!bridge) return;
    disableSparklePlugin(inst.id); // 未启用时是幂等 no-op
    const r = await bridge.uninstall({ id: inst.id });

    if (!r?.ok) toast(r?.error || "卸载失败", "err");
    installedThird = await listInstalledThirdParty();
    renderRows();
    renderMarket();
  };

  /** Marketplace 安装：落盘后按分类决定初始状态 —— 主题直接启用（外观设置立刻可选），
   *  普通插件维持默认关闭（安装第三方代码前要一道显式确认）。 */
  const installMarketEntry = async (entry: MarketEntry, cat: MarketCategory): Promise<boolean> => {
    const bridge = window.quaverSparkle;

    if (!bridge) { toast("当前环境不支持花火插件功能", "err"); return false; }

    const res = await bridge.install({
      url: entry.download,
      sha256: entry.hash,
      meta: {
        id: entry.id, name: entry.name, version: entry.version, minHostVersion: entry.minHostVersion,
        allowBeta: entry.allowBeta, author: entry.author, description: entry.description, category: cat,
        source: "market", download: entry.download, hash: entry.hash,
      },
    });

    if (!res?.ok) { toast(res?.error || "安装失败", "err"); return false; }

    installedThird = await listInstalledThirdParty();
    const inst = installedThird.find((x) => x.id === entry.id);

    if (inst && cat === "theme" && !sparkEnabledIds().includes(entry.id)) {
      try { await enableSparklePlugin(await loadThirdParty(inst)); }
      catch (e) { toast(`主题已安装，但自动启用失败（请在「主题」标签手动开启）`, "err"); console.warn(e); }
    }

    return true;
  };

  /** 更新一个 Marketplace 插件：下载校验落盘 → 若正在运行则热重载。
   *  热重载保留用户当时的外观选择：活动主题仍指向同一 id 时，disable→enable 后由
   *  applySparkleTheme 重新套上；主题风格（主题包）按 id 重新激活即可。 */
  const updateMarketEntry = async (entry: MarketEntry, button?: HTMLButtonElement | null) => {
    const wasActive = sparkEnabledIds().includes(entry.id);
    const activeThemeId = sparkActiveThemeId();
    const style = styleState();
    const keepStyle = style.packId;
    const bridge = window.quaverSparkle;

    if (!bridge) { toast("当前环境不支持花火插件功能", "err"); return; }

    if (wasActive) disableSparklePlugin(entry.id);
    if (button) { button.disabled = true; button.textContent = "更新中…"; }

    try {
      const res = await bridge.install({
        url: entry.download,
        sha256: entry.hash,
        meta: {
          id: entry.id, name: entry.name, version: entry.version, minHostVersion: entry.minHostVersion,
          allowBeta: entry.allowBeta, author: entry.author, description: entry.description,
          category: catOf(entry.category), source: "market", download: entry.download, hash: entry.hash,
        },
      });

      if (!res?.ok) {
        toast(res?.error || "更新失败", "err");
        // 更新失败时旧文件仍在盘上：把刚停下的插件按旧版本拉起来，别让一次网络错误
        // 悄悄改变启用状态
        if (wasActive && !sparkRecordOf(entry.id)) {
          const old = installedThird.find((x) => x.id === entry.id);

          if (old) await enableSparklePlugin(await loadThirdParty(old)).catch((e) => console.warn(e));
        }
      }
      else {
        installedThird = await listInstalledThirdParty();
        const inst = installedThird.find((x) => x.id === entry.id);

        if (wasActive && inst) {
          try {
            await enableSparklePlugin(await loadThirdParty(inst)); // loadSeq cache-bust：拿新文件并重跑顶层
            if (keepStyle) activateStyle(keepStyle, style.variantId ?? undefined);
            if (activeThemeId) applySparkleTheme();
            toast(`${entry.name || entry.id} 已更新到 v${entry.version} 并重载`);
          } catch (e) {
            toast(`${entry.name || entry.id} 已更新，但重载失败（请手动重新启用）`, "err");
            console.warn(e);
          }
        } else {
          toast(`${entry.name || entry.id} 已更新到 v${entry.version}`);
        }
      }
    } finally {
      if (button) { button.disabled = false; button.textContent = "更新"; }
      renderRows();
      renderMarket();
    }
  };

  const thirdRow = (inst: InstalledPlugin, badge: { cls: string; text: string }, opts?: { gearOnlyWithSections?: boolean; hideThemeSwitch?: boolean }) => {
    const enabled = sparkEnabledIds().includes(inst.id);
    const broken = sparkIsBroken(inst.id) && !sparkRecordOf(inst.id);
    const pluginLive = !!sparkRecordOf(inst.id);
    const hasSections = sparkleSettingsSections().some((e) => e.pluginId === inst.id);
    const lock = rowLock(inst.id) ?? undefined;
    // 纯主题（运行中且只提供主题/主题包/设置区）藏掉开关：它装完即用，
    // 启停交给「外观」里的主题选择；带常驻能力的主题插件仍需要启停逃生口。
    const themeOnly = !!opts?.hideThemeSwitch && pluginLive && sparkleIsThemeOnly(inst.id);

    return manageRow({
      id: inst.id,
      name: String(inst.manifest?.name ?? inst.id),
      version: String(inst.manifest?.version ?? "?"),
      author: inst.manifest?.author ? String(inst.manifest.author) : undefined,
      description: inst.manifest?.description ? String(inst.manifest.description) : undefined,
      badge,
      enabled, broken, lock,
      hideSwitch: themeOnly,
      showGear: !broken && (opts?.gearOnlyWithSections ? pluginLive && hasSections : true),
      pluginId: inst.id,
      onToggle: (on) => { void toggleThird(inst, on); },
      onUninstall: () => { void uninstallThird(inst); },
    });
  };

  // —— 主题包（registerThemePack）：每个包一行，内联各风格的色板按钮 + 一个「恢复默认」。
  //    放在「已装主题」下面而不是混进行内：包的启用状态归上面的开关管，这里只管
  //    「当前生效哪一套」，两件事分开摆，用户不会以为切了色板就等于启用了插件。
  const packChip = (label: string, on: boolean, swatches: string[], onClick: () => void, title?: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sparkle-pack" + (on ? " is-on" : "");
    b.title = title ?? label;

    const dots = swatches.length
      ? `<span class="sparkle-pack-dots">${swatches.slice(0, 5).map((c) => `<i style="background:${esc(c)}"></i>`).join("")}</span>`
      : "";

    b.innerHTML = `${dots}<span>${esc(label)}</span>`;
    b.onclick = onClick;

    return b;
  };

  const renderPacks = () => {
    packsBox.innerHTML = "";
    const packs = stylePacks();

    if (!packs.length) return; // 没有主题包：整块不出现，不占视觉空间
    const st = styleState();

    const head = document.createElement("div");
    head.className = "set-label";
    head.innerHTML = `主题风格 <span class="set-note-inline">整页生效（可重画圆角、阴影、组件形态），由启用中的插件提供</span>`;
    packsBox.append(head);

    const row = document.createElement("div");
    row.className = "sparkle-pack-row";
    row.append(packChip("默认外观", !st.packId, [], () => { resetStyle(); renderPacks(); }, "宿主内置外观（不加载任何插件样式）"));

    for (const { pack } of packs) {
      for (const v of pack.variants) {
        const on = st.packId === pack.id && (st.variantId ?? pack.variants[0]?.id) === v.id;
        row.append(packChip(
          on && !st.suspended ? v.name : `${pack.name} · ${v.name}`,
          on && !st.suspended,
          v.preview ?? pack.preview ?? [],
          () => { activateStyle(pack.id, v.id); renderPacks(); },
          `${pack.name} · ${v.name}${v.scheme ? `（${v.scheme === "dark" ? "暗底" : "亮底"}）` : ""}`,
        ));
      }
    }

    packsBox.append(row);

    // 总闸：样式把界面搞得没法用时的救命出口。必须显眼 —— 它是唯一不依赖任何
    // 插件就能回到可用界面的路径（插件自己出事时，它给的 reset() 未必还灵）。
    if (packs.some((p) => p.pack.variants.length)) {
      const sw = document.createElement("label");
      sw.className = "sparkle-switch";
      sw.innerHTML = `<input type="checkbox"${st.suspended ? " checked" : ""}/> ${st.suspended ? "已暂停全部插件样式" : "暂停全部插件样式"}`;
      const input = sw.querySelector<HTMLInputElement>("input")!;
      input.onchange = () => {
        setStyleSuspended(input.checked);
        renderPacks();
      };

      const danger = document.createElement("div");
      danger.className = "sparkle-pack-danger";
      danger.append(sw);
      const hint = document.createElement("p");
      hint.className = "muted set-hint";
      hint.textContent = "第三方样式可以改写整个界面。若某个主题让应用难以使用，打开这个总闸即可全部停用（无需先停用插件）。";
      danger.append(hint);
      packsBox.append(danger);
    }
  };

  const renderRows = () => {
    // ① 主题：category=theme 的已装插件（齿轮仅在该插件提供设置区时出现）
    themeRows.innerHTML = "";
    const themeInst = installedThird.filter((i) => installedCategory(i) === "theme");

    if (!themeInst.length) {
      themeRows.innerHTML = `<div class="sparkle-empty">没有已安装的主题 —— 从 Marketplace 安装；提供主题的插件启用后，到 设置 → 外观 切换</div>`;
    }

    for (const inst of themeInst) themeRows.append(thirdRow(inst, sourceBadge(inst.manifest?.author), { gearOnlyWithSections: true, hideThemeSwitch: true }));
    renderPacks();

    // ② 插件：官方 + 非主题的第三方（旧 extension 也归在这里）
    pluginRows.innerHTML = "";
    const enabled = new Set(sparkEnabledIds());

    for (const meta of OFFICIAL_META) {
      const broken = sparkIsBroken(meta.id) && !sparkRecordOf(meta.id);
      const offLock = officialLock(meta.id) ?? undefined;
      pluginRows.append(manageRow({
        ...meta, badge: { cls: "official", text: "预装" },
        enabled: enabled.has(meta.id), broken, lock: offLock,
        // 齿轮只在插件真的注册了设置区时出现（与第三方行同口径）
        showGear: !broken && sparkleSettingsSections().some((e) => e.pluginId === meta.id),
        pluginId: meta.id,
        onToggle: async (on) => {
          // UI 已锁，这里再兜一层（与 host 的中央闸口同口径）
          if (on && offLock) { toast(offLock, "err"); return; }

          try {
            if (on) await enableSparklePlugin(await loadOfficial(meta.id));
            else disableSparklePlugin(meta.id);
          } catch (e) {
            toast(`插件 ${meta.name} 切换失败`, "err");
            console.warn(e);
          }

          renderRows();
        },
      }));
    }

    const plainThird = installedThird.filter((i) => installedCategory(i) !== "theme");

    if (!plainThird.length && !installedThird.length) {
      const empty = document.createElement("div");
      empty.className = "sparkle-empty";
      empty.textContent = "没有已安装的第三方插件（可用 QUAVER_SPARKLE_DIR 指定开发目录，从 Marketplace 安装，或点「添加本地插件」）";
      pluginRows.append(empty);
    }

    for (const inst of plainThird) pluginRows.append(thirdRow(inst, sourceBadge(inst.manifest?.author)));
  };

  // —— Marketplace：一份索引一个列表，条目按 category 打徽标 ——

  const marketRow = (entry: MarketEntry, installed?: InstalledPlugin) => {
    const cat = catOf(entry.category);
    const hostVersionError = getSparkleHostVersionError(__APP_VERSION__, entry.minHostVersion, entry.allowBeta);
    const newer = isNewerVersion(entry.version, installed?.manifest?.version);
    const canUpdate = !!installed && newer && !hostVersionError && !safeMode;
    const el = document.createElement("div");
    el.className = "sparkle-row";
    el.innerHTML = `
      <i class="sparkle-badge cat-${cat}">${CAT_LABEL[cat]}</i>
      <div class="sparkle-main">
        <div class="sparkle-name">${esc(entry.name || entry.id)}<span class="ver">v${esc(entry.version)}${entry.author ? " · " + esc(entry.author) : ""}</span></div>
        ${entry.description ? `<div class="sparkle-desc">${esc(entry.description)}</div>` : ""}
        ${hostVersionError ? `<div class="sparkle-desc">${esc(hostVersionError)}</div>` : ""}
      </div>
      <div class="sparkle-actions"></div>`;
    const actions = el.querySelector<HTMLElement>(".sparkle-actions")!;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost-btn ghost-btn--quiet sparkle-install";
    btn.textContent = hostVersionError ? "版本不满足" : safeMode ? "安全模式" : installed ? "重新安装" : "安装";

    if (hostVersionError || safeMode) {
      btn.disabled = true;
      btn.title = hostVersionError || SAFE_MODE_LOCK;
    }

    btn.onclick = async () => {
      const bridge = window.quaverSparkle;

      if (!bridge || hostVersionError || safeMode) {
        if (hostVersionError) toast(hostVersionError, "err");
        else if (safeMode) toast(SAFE_MODE_LOCK, "err");

        return;
      }

      btn.disabled = true;
      btn.textContent = canUpdate ? "更新中…" : "下载中…";

      try {
        if (await installMarketEntry(entry, cat)) {
          toast(`已安装 ${entry.name || entry.id}${cat === "theme" ? "，已在外观设置中启用" : `（默认关闭，可在「${CAT_LABEL[cat]}」标签开启）`}`);
        }
        renderRows();
        renderMarket();
      } catch (e) {
        toast("安装失败", "err");
        console.warn(e);
      } finally {
        btn.disabled = false;
        btn.textContent = installed ? "重新安装" : "安装";
      }
    };

    actions.append(btn);

    if (canUpdate) {
      const upd = document.createElement("button");
      upd.type = "button";
      upd.className = "ghost-btn ghost-btn--quiet sparkle-update";
      upd.textContent = `更新（v${entry.version}）`;
      upd.title = `当前 v${installed?.manifest?.version ?? "?"} → v${entry.version}`;
      upd.onclick = () => { void updateMarketEntry(entry, upd); };
      actions.append(upd);
    }

    return el;
  };

  const renderMarket = () => {
    const bridge = window.quaverSparkle;
    marketList.innerHTML = "";

    if (!bridge) {
      marketList.innerHTML = `<div class="sparkle-empty">当前环境不支持花火插件功能（浏览器 dev / 未升级的 Electron 壳层），Marketplace 不可用</div>`;

      return;
    }

    if (market.loading) {
      marketList.innerHTML = `<div class="sparkle-empty">读取索引中…</div>`;

      return;
    }

    if (market.error) {
      marketList.innerHTML = `<div class="sparkle-empty">索引读取失败：${esc(market.error)}</div>`;

      return;
    }

    const entries = market.entries.filter((e) => mcat === "all" || catOf(e.category) === mcat);

    if (!entries.length) {
      marketList.innerHTML = `<div class="sparkle-empty">${mcat === "all" ? "索引里还没有内容" : `「${CAT_LABEL[mcat]}」分类暂无内容`}</div>`;

      return;
    }

    for (const entry of entries) {
      marketList.append(marketRow(entry, installedThird.find((x) => x.id === entry.id)));
    }
  };

  const refreshMarket = async () => {
    const bridge = window.quaverSparkle;

    if (!bridge) {
      market = { loading: false, error: null, entries: [] };
      renderMarket();

      return;
    }

    market = { loading: true, error: null, entries: [] };
    renderMarket();

    try {
      const r = await bridge.market({ url: DEFAULT_MARKET_URL });
      const entries = r?.index?.plugins ?? [];
      market = r?.ok
        ? { loading: false, error: null, entries }
        : { loading: false, error: r?.error ?? "未知错误", entries: [] };
    } catch (e) {
      market = { loading: false, error: String(e), entries: [] };
    }

    renderMarket();

    if (autoUpdateEnabled() && market.entries.length && !safeMode) {
      const updates = market.entries.filter((entry) => {
        const inst = installedThird.find((x) => x.id === entry.id);

        return inst?.manifest?.source === "market"
          && isNewerVersion(entry.version, inst.manifest?.version)
          && !getSparkleHostVersionError(__APP_VERSION__, entry.minHostVersion, entry.allowBeta);
      });

      // 逐个串行：并发下载会同时禁用多个运行中的插件，热重载时界面抖得更明显
      for (const entry of updates) await updateMarketEntry(entry);
    }
  };

  const refreshAll = async () => {
    installedThird = await listInstalledThirdParty();
    renderRows();
    await refreshMarket();
  };

  // —— 添加本地插件：红色 5 秒警告弹窗守门 → 选文件 → 校验形状 → 落盘 ——

  const installLocalFlow = async () => {
    const bridge = window.quaverSparkle;

    if (!bridge) return;

    // 安全模式：主进程的安装闸口会拒，但别让用户先走完 5 秒警告再吃一个错误 —— UI 直接上锁
    if (safeMode) { toast(SAFE_MODE_LOCK, "err"); return; }

    showLocalPluginDialog(async () => {
      const picked = await bridge.pickLocal().catch((e) => {
        console.warn("[sparkle] 本地插件读取失败", e);

        return null;
      });

      if (!picked?.ok) { toast(picked?.error || "读取插件文件失败", "err"); return; }

      if (picked.canceled || !picked.dataBase64) return;
      // 元数据取自插件本体（default export）：经 blob URL 动态 import 读出并做形状校验，
      // 不合法就原地拒绝（不落任何盘）。注意 import 会执行插件顶层代码 —— 这正是警告弹窗存在的意义。
      const url = URL.createObjectURL(new Blob([base64ToBytes(picked.dataBase64)], { type: "text/javascript" }));
      let meta: SparklePluginManifest;

      try {
        const mod = await import(/* @vite-ignore */ url);
        const plugin = validatePlugin(mod?.default ?? mod?.plugin);

        if (!plugin) {
          toast("插件格式不合法", "err");

          return;
        }

        const hostVersionError = getSparkleHostVersionError(__APP_VERSION__, plugin.minHostVersion, plugin.allowBeta);

        if (hostVersionError) {
          toast(hostVersionError, "err");

          return;
        }

        meta = { id: plugin.id, name: plugin.name, version: plugin.version, minHostVersion: plugin.minHostVersion, allowBeta: plugin.allowBeta, author: plugin.author, description: plugin.description };
      } catch (e) {
        toast("插件加载失败（不是合法的 ESM 单文件插件？）", "err");
        console.warn(e);

        return;
      } finally {
        URL.revokeObjectURL(url);
      }

      try {
        const res = await bridge.installLocal({ dataBase64: picked.dataBase64, meta });

        if (!res?.ok) toast(res?.error || "安装失败", "err");
        else toast(`已安装 ${String(meta.name)}（默认关闭，请在「插件」标签启用）`);
      } catch (e) {
        toast("安装失败", "err");
        console.warn(e);
      }

      await refreshAll();
    });
  };

  localBtn.onclick = () => { void installLocalFlow(); };

  if (!window.quaverSparkle) {
    localBtn.disabled = true;
    localBtn.title = "浏览器 dev 环境不支持花火插件功能";
  } else if (safeMode) {
    localBtn.disabled = true;
    localBtn.title = SAFE_MODE_LOCK;
  }

  autoUpdateInput.checked = autoUpdateEnabled();
  autoUpdateInput.onchange = () => {
    setAutoUpdateEnabled(autoUpdateInput.checked);

    if (!autoUpdateInput.checked) return;

    // 打开开关即兑现一次：不等下次启动，当前索引已在内存里
    const updates = (market.loading || market.error ? [] : market.entries).filter((entry) => {
      const inst = installedThird.find((x) => x.id === entry.id);

      return inst?.manifest?.source === "market"
        && isNewerVersion(entry.version, inst.manifest?.version)
        && !getSparkleHostVersionError(__APP_VERSION__, entry.minHostVersion, entry.allowBeta);
    });

    void (async () => {
      // 串行，与刷新时的自动更新同一口径：避免同时热重载多个插件
      for (const entry of updates) await updateMarketEntry(entry);
    })();
  };

  marketRefresh.onclick = () => { void refreshAll(); };

  // Marketplace 内部分类筛选：chips 只过滤列表，不改变「一份索引一处拉取」的结构
  marketGroup.querySelectorAll<HTMLButtonElement>(".sparkle-mkt-chip").forEach((chip) => {
    chip.onclick = () => {
      if (chip.classList.contains("is-active")) return;
      mcat = chip.dataset.mcat as "all" | MarketCategory;
      marketGroup.querySelectorAll(".sparkle-mkt-chip").forEach((x) => x.classList.toggle("is-active", x === chip));
      renderMarket();
    };
  });

  // 初始化：立即画一次（官方列表不等桥），索引与第三方列表随后补
  let alive = true;
  const unsubChange = onSparkleChange(() => { if (alive) renderRows(); });
  // 样式态变化（含插件侧 ctx.style.activate）也要重画：色板选中态与总闸是本地状态，
  // 只靠 onSparkleChange（插件注册变化）会漏掉纯切换。
  const unsubStyle = onStyleChange(() => { if (alive) renderPacks(); });
  renderRows();
  renderMarket();
  void refreshAll();

  return () => {
    alive = false;
    unsubChange();
    unsubStyle();
  };
}
