// Quaver — 路由视图：toplist（排行榜）
// 首页只展示榜单卡片；进入这里后按歌单页同一套信息头/歌曲行渲染，并可在近三个月期次间切换。
import "./toplist.css";
import { api, upPic } from "../lib/api";
import { recentTopPeriods, periodCaption } from "../lib/toplist-periods";
import type { ChartPeriod } from "../lib/toplist-periods";
import { renderSongRows } from "../lib/songs";
import { player } from "../player";
import type { Song } from "../player";
import type { ToplistDetailResp, ToplistInfo } from "./_shared";
import { compactCount, errText, h, mountHead, mountStickyBar, playAllButton } from "./_shared";

const plainText = (s: unknown) => String(s ?? "")
  .replace(/<br\s*\/?>/gi, " ")
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/\s+/g, " ")
  .trim();

function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? `${m[1]} 年 ${Number(m[2])} 月` : "其他";
}

export default async function toplistView(root: HTMLElement, q: URLSearchParams) {
  const id = q.get("id") || "";
  const name = q.get("name") || "排行榜";
  const initialPeriod = q.get("period") || "";
  let historyEnabled = q.get("history") !== "0";
  if (!/^\d+$/.test(id)) {
    root.innerHTML = `<div class="muted">榜单 id 无效</div>`;
    return;
  }

  const fetchChart = async (period: string): Promise<ToplistDetailResp & { songs: Song[] }> => {
    const first = await api<ToplistDetailResp>(
      `/top/${encodeURIComponent(id)}/detail?page=1&num=100${period ? `&period=${encodeURIComponent(period)}` : ""}`,
    ) ?? {};
    const songs: Song[] = [...(first.songs ?? [])];
    const total = Number(first.total ?? first.info?.songnum ?? songs.length) || songs.length;
    for (let page = 2; songs.length < total && page <= 4; page++) {
      const next = await api<ToplistDetailResp>(
        `/top/${encodeURIComponent(id)}/detail?page=${page}&num=100${period ? `&period=${encodeURIComponent(period)}` : ""}`,
      ) ?? {};
      const batch = next.songs ?? [];
      if (!batch.length) break;
      songs.push(...batch);
    }
    return { ...first, songs };
  };

  root.innerHTML = `<div class="muted">加载中…</div>`;
  let first: ToplistDetailResp & { songs: Song[] };
  try {
    first = await fetchChart(initialPeriod);
  } catch (e) {
    root.innerHTML = `<div class="muted">榜单加载失败：${errText(e)}</div>`;
    return;
  }

  root.innerHTML = "";
  let info: ToplistInfo = first.info ?? { title: name };
  let songs = first.songs;
  let request = 0;
  let dead = false;

  const cover = upPic(info.picurl || "");
  const artHtml = cover ? `<img src="${cover}" alt=""/>` : "";
  const head = mountHead(root, {
    artHtml,
    name: info.title || name,
    meta: "",
    desc: plainText(info.desc || info.title_share || ""),
  });
  const sticky = mountStickyBar(root, { artHtml, name: info.title || name });
  const headMeta = head.querySelector<HTMLElement>(".pl-meta");

  const periodBox = h("label", "top-period");
  periodBox.innerHTML = `<span class="top-period__label">期次</span>`;
  const select = h("select", "top-period__select") as HTMLSelectElement;
  select.setAttribute("aria-label", "选择榜单期次");
  periodBox.append(select);
  const currentOnly = h("span", "top-period__current", "仅提供当前期");

  const playAll = playAllButton(() => songs);
  sticky.right.append(periodBox, currentOnly, playAll.el);
  const rows = h("div", "rows");
  root.append(rows);

  const paintHistoryControl = () => {
    periodBox.hidden = !historyEnabled;
    currentOnly.hidden = historyEnabled;
  };

  const paintMeta = () => {
    const listens = compactCount(info.listennum);
    const caption = periodCaption(info.period);
    if (headMeta) {
      headMeta.textContent = [
        info.update_tips || (Number(info.update_type) === 0 ? "每周更新" : "每日更新"),
        caption,
        `${Number(info.songnum ?? songs.length) || songs.length} 首`,
        listens ? `${listens}次播放` : "",
      ].filter(Boolean).join(" · ");
    }
  };

  const paintSongs = () => {
    playAll.sync();
    if (!songs.length) {
      rows.innerHTML = `<div class="muted">这一期暂时没有歌曲</div>`;
      return;
    }
    renderSongRows(rows, songs, {
      showAlbum: true,
      onPlay: (_song, index, all) => player.playList(all, index),
    });
    player.markActive();
  };

  const paintOptions = (preferred = "") => {
    if (!historyEnabled) return;
    const periods = recentTopPeriods(info, new Date());
    if (preferred && !periods.some((p) => p.value === preferred)) {
      periods.unshift({ value: preferred, label: periodCaption(preferred), month: preferred.slice(0, 7) });
    }
    select.innerHTML = "";
    const groups = new Map<string, ChartPeriod[]>();
    for (const p of periods) {
      const list = groups.get(p.month) ?? [];
      list.push(p);
      groups.set(p.month, list);
    }
    for (const [month, list] of groups) {
      const og = document.createElement("optgroup");
      og.label = monthLabel(month);
      for (const p of list) {
        const option = document.createElement("option");
        option.value = p.value;
        option.textContent = p.label;
        og.append(option);
      }
      select.append(og);
    }
    select.disabled = !periods.length;
    select.value = periods.some((p) => p.value === info.period)
      ? String(info.period)
      : (periods[0]?.value ?? "");
  };

  const replacePeriodInHash = (period: string) => {
    const params = new URLSearchParams({ id, name: info.title || name });
    if (period) params.set("period", period);
    history.replaceState(history.state, "", `#/toplist?${params.toString()}`);
  };

  select.addEventListener("change", async () => {
    const current = ++request;
    const period = select.value;
    select.disabled = true;
    rows.innerHTML = `<div class="muted">加载中…</div>`;
    try {
      const next = await fetchChart(period);
      if (dead || current !== request) return;
      const returnedPeriod = String(next.info?.period ?? "");
      if (period && returnedPeriod && period !== returnedPeriod) {
        historyEnabled = false;
        paintHistoryControl();
        select.value = String(info.period ?? "");
        paintMeta();
        paintSongs();
        return;
      }
      info = next.info ?? info;
      songs = next.songs;
      replacePeriodInHash(String(info.period || period));
      paintMeta();
      paintOptions(String(info.period || period));
      paintSongs();
    } catch (e) {
      if (dead || current !== request) return;
      rows.innerHTML = `<div class="muted">这一期加载失败：${errText(e)}</div>`;
      select.value = String(info.period ?? "");
    } finally {
      if (!dead && current === request) select.disabled = false;
    }
  });

  paintMeta();
  paintHistoryControl();
  paintOptions(initialPeriod || String(info.period || ""));
  paintSongs();
  return () => {
    dead = true;
    request++;
    sticky.off();
  };
}
