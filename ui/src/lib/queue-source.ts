// Quaver — 播放队列来源的展示名（播放条封面右键「跳转至歌单」）
//
// player 只记**来源页路由**（一个 hash 字符串，随会话存档），不存展示名 —— 路由本身就是
// 跳转所需的全部信息。菜单在懒加载的 SongMenu 里打开时才调本文件把 hash 翻成人话，
// 因此这份解析代码不参与首屏闭包。
//
// 真实歌单（playlist?id=…）与虚拟歌单（每日 30 首 / 我喜欢 / 搜索结果 / 所有音乐 /
// 本地音乐 / 音乐网盘 / 排行榜 / 猜你喜欢 / 首页）都走同一套：能认出来的给中文名，
// 认不出的（插件自定义路由）退回「来源页」，但不阻断跳转。

/** 无参数的虚拟歌单/页面：路由 → 展示名。带 id/name 的页面在下面单独解析。 */
const FIXED_LABELS = new Map<string, string>([
  ["/", "首页"],
  ["/daily", "每日 30 首"],
  ["/liked", "我喜欢"],
  ["/local", "本地音乐"],
  ["/cloud", "音乐网盘"],
  ["/all", "所有音乐"],
  ["/guess", "猜你喜欢"],
]);

/** 来源页路由 → 菜单里的一行展示名（`#/playlist?id=…&name=…` → 歌单名）。 */
export function queueSourceLabel(hash: string): string {
  const raw = String(hash ?? "").trim();

  if (!raw) return "来源页";
  const h = raw.startsWith("#") ? raw : `#${raw}`;
  const [pathPart, queryPart = ""] = h.slice(1).split("?");
  const path = pathPart === "" ? "/" : pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const fixed = FIXED_LABELS.get(path);

  if (fixed) return fixed;
  const q = new URLSearchParams(queryPart);
  const name = (q.get("name") || "").trim();

  switch (path) {
    case "/playlist":
      return name || "歌单";
    case "/album":
      return name || "专辑";
    case "/singer":
      return name || "歌手";
    case "/toplist":
      return name || "排行榜";
    case "/search": {
      const keyword = (q.get("keyword") || "").trim();

      return keyword ? `搜索「${keyword}」` : "搜索";
    }

    default:
      return name || "来源页";
  }
}
