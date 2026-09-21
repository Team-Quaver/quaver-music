// Sparkle — 设置页 Sparkle tab 的面板（ui/src/views.ts 的 settingsView 填充）
//
// 三个分组：① 已装插件（官方 + 第三方，开关/卸载）② 各插件的设置区
// ③ Marketplace（索引源 + 浏览/安装）。DOM 销毁（切路由）时统一清理订阅与
// 插件 render 返回的清理函数。
import type { SparkleSettingsSection } from "@quaver/sparkle";
import { DEFAULT_MARKET_URL } from "@quaver/sparkle/market/default-index";
import { toast } from "../components/SongMenu";
import {
  disableSparklePlugin, enableSparklePlugin, sparkEnabledIds, sparkIsBroken,
} from "./host";
import { listInstalledThirdParty, loadOfficial, loadThirdParty, OFFICIAL_META, type InstalledPlugin } from "./loader";
import { onSparkleChange, sparkRecordOf, sparkleSettingsSections } from "./registry";

const MARKET_URL_KEY = "quaver.sparkle.market.url.v1";
const marketUrl = () => localStorage.getItem(MARKET_URL_KEY) ?? DEFAULT_MARKET_URL;

interface MarketEntry {
  id: string; name: string; version: string; author?: string; description?: string;
  download: string; homepage?: string; hash?: string;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function mountSparklePanel(section: HTMLElement): () => void {
  section.innerHTML = "";

  // —— ① 已装插件 ——
  const installedGroup = document.createElement("div");
  installedGroup.className = "set-group";
  installedGroup.innerHTML = `
    <div class="set-label">已装插件 <span class="set-note-inline">第三方插件将在本地运行任意代码，请只安装信任来源</span></div>
    <div class="sparkle-list"></div>`;
  const installedList = installedGroup.querySelector<HTMLElement>(".sparkle-list")!;

  // —— ② 插件设置区 ——
  const sectionsGroup = document.createElement("div");
  sectionsGroup.className = "set-group";
  sectionsGroup.innerHTML = `<div class="set-label">插件设置</div><div class="sparkle-sections"></div>`;
  const sectionsHost = sectionsGroup.querySelector<HTMLElement>(".sparkle-sections")!;
  let sectionCleanups: (() => void)[] = [];

  const renderSections = () => {
    for (const fn of sectionCleanups) { try { fn(); } catch { /* 尽力 */ } }
    sectionCleanups = [];
    sectionsHost.innerHTML = "";
    const entries = sparkleSettingsSections();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "sparkle-empty";
      empty.textContent = "启用的插件没有提供设置项";
      sectionsHost.append(empty);
      return;
    }
    for (const entry of entries) {
      const box = document.createElement("div");
      box.style.marginBottom = "12px";
      const title = document.createElement("div");
      title.className = "set-label";
      title.textContent = entry.section.title;
      const body = document.createElement("div");
      box.append(title, body);
      try {
        entry.cleanup = entry.section.render(body) ?? null;
        sectionCleanups.push(() => { entry.cleanup?.(); entry.cleanup = null; });
      } catch (e) {
        body.innerHTML = `<div class="sparkle-empty">设置区渲染失败（见控制台）</div>`;
        console.warn(`[sparkle:${entry.pluginId}] 设置区渲染失败`, e);
      }
      sectionsHost.append(box);
    }
  };

  // —— ③ Marketplace ——
  const marketGroup = document.createElement("div");
  marketGroup.className = "set-group";
  marketGroup.innerHTML = `
    <div class="set-label">Marketplace</div>
    <div class="sparkle-market-bar">
      <input type="text" spellcheck="false" autocomplete="off" aria-label="索引源 URL" placeholder="索引源 URL（JSON）"/>
      <button class="ghost-btn ghost-btn--quiet sparkle-market-refresh" type="button">刷新</button>
    </div>
    <p class="muted sparkle-warn">安装 ≠ 启用：装完默认关闭，请到「已装插件」里手动开启。插件可以访问页面数据，请只安装信任来源。</p>
    <div class="sparkle-market-list"></div>`;
  const marketInput = marketGroup.querySelector<HTMLInputElement>("input")!;
  const marketRefresh = marketGroup.querySelector<HTMLButtonElement>(".sparkle-market-refresh")!;
  const marketList = marketGroup.querySelector<HTMLElement>(".sparkle-market-list")!;
  marketInput.value = marketUrl();

  section.append(installedGroup, sectionsGroup, marketGroup);

  // —— 渲染逻辑 ——

  let installedThird: InstalledPlugin[] = [];

  const row = (o: {
    id: string; name: string; version: string; author?: string; description?: string;
    kind: "official" | "third-party"; enabled: boolean; broken: boolean;
    onToggle: (on: boolean) => void; onUninstall?: () => void;
  }) => {
    const el = document.createElement("div");
    el.className = "sparkle-row";
    const badge = o.broken ? "broken" : o.kind;
    const badgeText = o.broken ? "启动失败" : o.kind === "official" ? "官方" : "第三方";
    el.innerHTML = `
      <i class="sparkle-badge ${badge}">${badgeText}</i>
      <div class="sparkle-main">
        <div class="sparkle-name">${esc(o.name)}<span class="ver">v${esc(o.version)}${o.author ? " · " + esc(o.author) : ""}</span></div>
        ${o.description ? `<div class="sparkle-desc">${esc(o.description)}</div>` : ""}
      </div>
      <div class="sparkle-actions"></div>`;
    const actions = el.querySelector<HTMLElement>(".sparkle-actions")!;
    if (!o.broken) {
      const sw = document.createElement("label");
      sw.className = "sparkle-switch";
      sw.innerHTML = `<input type="checkbox"${o.enabled ? " checked" : ""}/> ${o.enabled ? "已启用" : "已停用"}`;
      const input = sw.querySelector<HTMLInputElement>("input")!;
      input.onchange = () => {
        sw.textContent = "";
        sw.append(input, document.createTextNode(input.checked ? "已启用" : "已停用"));
        o.onToggle(input.checked);
      };
      actions.append(sw);
    }
    if (o.onUninstall) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sparkle-uninstall";
      btn.textContent = "卸载";
      btn.onclick = () => o.onUninstall!();
      actions.append(btn);
    }
    return el;
  };

  const renderInstalled = () => {
    installedList.innerHTML = "";
    const enabled = new Set(sparkEnabledIds());
    for (const meta of OFFICIAL_META) {
      installedList.append(row({
        ...meta, kind: "official",
        enabled: enabled.has(meta.id),
        broken: sparkIsBroken(meta.id) && !sparkRecordOf(meta.id),
        onToggle: async (on) => {
          try {
            if (on) await enableSparklePlugin(await loadOfficial(meta.id));
            else disableSparklePlugin(meta.id);
          } catch (e) {
            toast(`插件 ${meta.name} 切换失败`, "err");
            console.warn(e);
          }
          renderInstalled();
        },
      }));
    }
    if (!installedThird.length) {
      const empty = document.createElement("div");
      empty.className = "sparkle-empty";
      empty.textContent = "没有已安装的第三方插件（可用 QUAVER_SPARKLE_DIR 指定开发目录，或从 Marketplace 安装）";
      installedList.append(empty);
    }
    for (const inst of installedThird) {
      installedList.append(row({
        id: inst.id,
        name: String(inst.manifest?.name ?? inst.id),
        version: String(inst.manifest?.version ?? "?"),
        author: inst.manifest?.author ? String(inst.manifest.author) : undefined,
        description: inst.manifest?.description ? String(inst.manifest.description) : undefined,
        kind: "third-party",
        enabled: enabled.has(inst.id),
        broken: sparkIsBroken(inst.id) && !sparkRecordOf(inst.id),
        onToggle: async (on) => {
          try {
            if (on) await enableSparklePlugin(await loadThirdParty(inst));
            else disableSparklePlugin(inst.id);
          } catch (e) {
            toast(`插件 ${inst.id} 切换失败`, "err");
            console.warn(e);
          }
          renderInstalled();
        },
        onUninstall: async () => {
          const bridge = window.quaverSparkle;
          if (!bridge) return;
          disableSparklePlugin(inst.id); // 未启用时是幂等 no-op
          const r = await bridge.uninstall({ id: inst.id });
          if (!r?.ok) toast(r?.error || "卸载失败", "err");
          installedThird = await listInstalledThirdParty();
          renderInstalled();
          renderMarket();
        },
      }));
    }
  };

  const renderMarket = () => {
    marketList.innerHTML = "";
    const bridge = window.quaverSparkle;
    if (!bridge) {
      marketList.innerHTML = `<div class="sparkle-empty">当前环境没有 Sparkle 桥（浏览器 dev / 未升级的 Electron 壳层），Marketplace 不可用</div>`;
      return;
    }
    if (!marketUrl().trim()) {
      marketList.innerHTML = `<div class="sparkle-empty">未配置索引源。填入 Marketplace 索引 JSON 的 URL 后点「刷新」</div>`;
      return;
    }
    marketList.innerHTML = `<div class="sparkle-empty">读取索引中…</div>`;
    void bridge.market({ url: marketUrl().trim() }).then((r) => {
      marketList.innerHTML = "";
      if (!r?.ok) {
        marketList.innerHTML = `<div class="sparkle-empty">索引读取失败：${esc(r?.error ?? "未知错误")}</div>`;
        return;
      }
      const entries = (r.index as { plugins?: MarketEntry[] } | undefined)?.plugins ?? [];
      const installedIds = new Set(installedThird.map((x) => x.id));
      if (!entries.length) {
        marketList.innerHTML = `<div class="sparkle-empty">索引里还没有插件</div>`;
        return;
      }
      for (const entry of entries) {
        const el = document.createElement("div");
        el.className = "sparkle-row";
        el.innerHTML = `
          <i class="sparkle-badge third-party">插件</i>
          <div class="sparkle-main">
            <div class="sparkle-name">${esc(entry.name || entry.id)}<span class="ver">v${esc(entry.version)}${entry.author ? " · " + esc(entry.author) : ""}</span></div>
            ${entry.description ? `<div class="sparkle-desc">${esc(entry.description)}</div>` : ""}
          </div>
          <div class="sparkle-actions"></div>`;
        const actions = el.querySelector<HTMLElement>(".sparkle-actions")!;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ghost-btn ghost-btn--quiet sparkle-install";
        const isInstalled = installedIds.has(entry.id);
        btn.textContent = isInstalled ? "重新安装" : "安装";
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = "下载中…";
          try {
            const res = await bridge.install({
              url: entry.download,
              sha256: entry.hash,
              meta: { id: entry.id, name: entry.name, version: entry.version, author: entry.author, description: entry.description },
            });
            if (!res?.ok) toast(res?.error || "安装失败", "err");
            else toast(`已安装 ${entry.name || entry.id}（默认关闭，请在上方启用）`);
          } catch (e) {
            toast("安装失败", "err");
            console.warn(e);
          }
          installedThird = await listInstalledThirdParty();
          renderInstalled();
          renderMarket();
        };
        actions.append(btn);
        marketList.append(el);
      }
    }).catch((e) => {
      marketList.innerHTML = `<div class="sparkle-empty">索引读取失败：${esc(String(e))}</div>`;
    });
  };

  marketRefresh.onclick = () => {
    localStorage.setItem(MARKET_URL_KEY, marketInput.value.trim());
    installedThird = [];
    void listInstalledThirdParty().then((list) => {
      installedThird = list;
      renderInstalled();
      renderMarket();
    });
  };

  // 初始化：先拉第三方安装列表，再画全部
  let alive = true;
  const unsubChange = onSparkleChange(() => { if (alive) renderSections(); });
  void listInstalledThirdParty().then((list) => {
    if (!alive) return;
    installedThird = list;
    renderInstalled();
    renderSections();
    renderMarket();
  });
  // 立即画一次（官方列表 / 已启用的插件设置区不等桥）
  renderInstalled();
  renderSections();
  renderMarket();

  return () => {
    alive = false;
    unsubChange();
    for (const fn of sectionCleanups) { try { fn(); } catch { /* 尽力 */ } }
    sectionCleanups = [];
  };
}
