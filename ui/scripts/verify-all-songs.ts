// Quaver — 「所有歌曲」护栏（合流 · 分类 · 三视图 · 繁简歌手归并）。
//
// 跑：node scripts/verify-all-songs.ts
//
// 三层：
//   ① 数据层纯单测：本地 + 喜欢合流去重、歌手分组、专辑分组；
//   ② 真 OpenCC 词典：把 artist-key 经 vite 打包后实测「周杰倫 / 周杰伦」归并；
//   ③ 源码接线：侧栏 CD 图标、懒加载路由、列表工具条、三个分类标签、实时订阅。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import { groupSongsByAlbum, groupSongsByArtist, mergeAllSongs } from "../src/lib/all-songs.ts";
import { viewsSource } from "./views-source.ts";

const UI = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(UI, path), "utf8");
const ROOT = mkdtempSync(join(tmpdir(), "quaver-all-songs-"));

let pass = 0;
let fail = 0;

const section = (title: string) => console.log(`\n=== ${title} ===`);

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const eq = <T,>(name: string, got: T, want: T) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const song = (opts: {
  mid: string;
  name?: string;
  artist?: string;
  album?: string;
  albumMid?: string;
  localId?: string;
  qqMid?: string;
  artistMid?: string;
}) => ({
  mid: opts.mid,
  name: opts.name ?? opts.mid,
  singer: (opts.artist ?? "").split(/\s*\/\s*/).filter(Boolean).map((name) => ({ name, mid: opts.artistMid ?? "" })),
  album: { name: opts.album ?? "", mid: opts.albumMid ?? "", pmid: "" },
  local: opts.localId
    ? {
        id: opts.localId,
        kind: "folder" as const,
        hasCover: false,
        path: `${opts.localId}.flac`,
        sourceName: "Music",
        qqMid: opts.qqMid ?? "",
        lyricImport: false,
      }
    : undefined,
});

try {
  section("合流：本地音乐 + 我喜欢");

  {
    const localOnly = song({ mid: "local:l1", localId: "l1", artist: "A", album: "Local" });
    const duplicatedLocal = song({ mid: "local:l2", localId: "l2", artist: "A", album: "Local", qqMid: "q1" });
    const anotherLocalSameMatch = song({ mid: "local:l3", localId: "l3", artist: "A", album: "Local", qqMid: "q1" });
    const likedDuplicate = song({ mid: "q1", artist: "A", album: "Local", albumMid: "am1" });
    const likedOnly = song({ mid: "q2", artist: "B", album: "Online" });
    const merged = mergeAllSongs([localOnly, duplicatedLocal, anotherLocalSameMatch], [likedDuplicate, likedOnly]);

    eq("本地文件各自保留，仅去掉同 QQ mid 的在线收藏 = 4 首",
      merged.map((x) => x.mid), ["local:l1", "local:l2", "local:l3", "q2"]);
    check("刮削命中的本地曲优先保留（播放走本地文件）", merged[1]?.local?.id === "l2");
    check("未命中 QQ 的本地曲不会与在线曲误合并", merged[0]?.mid === "local:l1");
  }

  {
    const one = song({ mid: "q1", artist: "周杰倫", album: "十一月的蕭邦", albumMid: "alb-1" });
    const two = song({ mid: "q2", artist: "周杰伦", album: "十一月的萧邦", albumMid: "alb-1" });
    const three = song({ mid: "q3", artist: "周杰倫 / 五月天", album: "十一月的蕭邦", albumMid: "alb-1" });
    const albums = groupSongsByAlbum([one, two, three]);

    eq("专辑 mid 相同 → 一张专辑", albums.length, 1);
    eq("专辑内三首都在", albums[0]?.songs.map((x) => x.mid), ["q1", "q2", "q3"]);
    check("专辑副行汇总所有歌手署名", albums[0]?.artist === "周杰倫 / 周杰伦 / 五月天");
  }

  {
    const noMidA = song({ mid: "q1", artist: "A", album: "Same Name" });
    const noMidB = song({ mid: "q2", artist: "B", album: "Same Name" });
    const noMidC = song({ mid: "q3", artist: "C", album: "Same Name" });
    const sameArtist = song({ mid: "q4", artist: "A", album: "Same Name" });
    const albums = groupSongsByAlbum([noMidA, noMidB, noMidC, sameArtist]);

    check("无专辑 mid 时按「名称 + 首位歌手」兜底：同歌手合流、不同歌手不误并",
      albums.length === 3
      && albums.find((x) => x.songs.some((s) => s.mid === "q1"))?.songs.length === 2);
  }

  {
    const unknownA = song({ mid: "q1", artist: "", album: "" });
    const unknownB = song({ mid: "q2", artist: "", album: "" });
    const albums = groupSongsByAlbum([unknownA, unknownB]);

    check("缺专辑名 → 只落一个「未知专辑」组", albums.length === 1 && albums[0]?.name === "未知专辑");
  }

  section("歌手分类：合唱多归属 + 未知兜底");

  {
    const solo = song({ mid: "q1", artist: "A", artistMid: "singer-a" });
    const duet = song({ mid: "q2", artist: "A / B", artistMid: "singer-b" });
    const unknown = song({ mid: "q3" });
    const groups = await groupSongsByArtist([solo, duet, unknown]);
    const byName = new Map(groups.map((group) => [group.name, group.songs.map((x) => x.mid)]));

    eq("A 收两首（独唱 + 合唱）", byName.get("A"), ["q1", "q2"]);
    eq("B 收合唱那一首", byName.get("B"), ["q2"]);
    eq("未知歌手排最后", groups.at(-1)?.name, "未知歌手");
    check("每首歌在同一歌手组内只出现一次", new Set(byName.get("A")).size === 2);
    eq("歌手组带头像用 mid", groups.find((group) => group.name === "A")?.mid, "singer-a");
  }

  section("繁简歌手名：真 OpenCC 词典");

  writeFileSync(join(ROOT, "entry.ts"), `
export * from ${JSON.stringify(join(UI, "src/lib/artist-key.ts"))};
`);

  const res = await viteBuild({
    configFile: false,
    logLevel: "error",
    root: UI,
    define: { "import.meta.env.DEV": "false" },
    build: {
      write: false,
      minify: false,
      target: "esnext",
      rollupOptions: { output: { codeSplitting: false } },
      lib: { entry: join(ROOT, "entry.ts"), formats: ["es"], fileName: () => "artist-key.mjs" },
    },
  });

  const chunk = res[0]?.output.find((item) => item.type === "chunk");

  if (!chunk || chunk.type !== "chunk") {
    check("artist-key 打包成功", false);
  } else {
    const file = join(ROOT, "artist-key.mjs");
    writeFileSync(file, chunk.code);
    const mod = await import(file);
    const traditional = await mod.artistIdentity("周杰倫");
    const simplified = await mod.artistIdentity("周杰伦");
    const gemTraditional = await mod.artistIdentity("G.E.M. 鄧紫棋");
    const gemSimplified = await mod.artistIdentity("G.E.M. 邓紫棋");

    eq("繁体 → 简体展示名", traditional.name, "周杰伦");
    eq("繁简归并键一致", traditional.key, simplified.key);
    eq("中英混排歌手也归一", gemTraditional.key, gemSimplified.key);
    eq("拉丁字母大小写不影响归并键", (await mod.artistIdentity("G.E.M.")).key, (await mod.artistIdentity("g.e.m.")).key);
  }

  section("源码接线：菜单 · 路由 · 三视图 · 数据刷新");

  const shell = read("src/shell.ts");
  const view = read("src/views/all.ts");
  const css = read("src/views/all.css");
  const views = viewsSource();

  check("侧栏有「所有歌曲」且使用 CD 图标", /\{ path: "#\/all", label: "所有歌曲", icon: "disc" \}/.test(shell));
  check("所有歌曲排在歌单与本地音乐之间",
    shell.indexOf('label: "所有歌曲"') > shell.indexOf('label: "歌单"')
    && shell.indexOf('label: "所有歌曲"') < shell.indexOf('label: "本地音乐"'));
  check("CD 图标是碟面 + 轴孔（不是文件夹）",
    /disc:\s*\n?\s*'<svg[^']*circle cx="12" cy="12" r="8\.4"[^']*circle cx="12" cy="12" r="1\.55"/.test(shell));

  check("/all 走懒加载注册表", /"\/all": \(\) => import\("\.\/all"\)/.test(views));
  check("页面标题/信息头为「所有歌曲」", view.includes('name: "所有歌曲"') && view.includes('"所有歌曲"'));
  check("列表复用 ListTools（搜索 + 歌名/歌手排序）", view.includes("songListTools({") && view.includes("hint: \"在所有歌曲内搜索\""));
  check("三视图标签 = 列表 / 歌手分类 / 专辑分类",
    ["list", "artist", "album"].every((key) => view.includes(`key: "${key}"`))
    && ["列表", "歌手分类", "专辑分类"].every((label) => view.includes(`label: "${label}"`)));
  check("歌手分类走繁简归并函数", view.includes("groupSongsByArtist("));
  check("歌手卡优先显示头像，缺 mid 时精确搜索，失败回退首字母",
    view.includes("resolveArtistAvatar(") && view.includes("all-artist-avatar")
    && view.includes("img.onerror = fallback") && view.includes("img.onerror"));
  check("歌手/专辑分类是左列表 + 右 Track 的主从布局",
    view.includes("makeBrowser(artistPanel") && view.includes("all-browser__rail")
    && view.includes("all-browser__tracks") && css.includes(".all-browser__list"));
  check("主从布局直接落在现有 tag-panel 上（不再套一层容器）",
    !view.includes("const shell = h(\"div\"") && css.includes("grid-template-areas: \"intro intro\" \"rail tracks\""));
  check("吸顶后顶部固定，左右两栏各自独立滚动",
    css.includes("height: var(--all-body-h")
    && /\.all-browser__list \{[^}]*overflow-y: auto;/.test(css)
    && /\.all-browser__rows \{[^}]*overflow-y: auto;/.test(css)
    && /\.all-browser__head \{[^}]*flex: 0 0 auto;/.test(css));
  check("播放全部住在吸顶栏（与「我喜欢」同款紧凑按钮）",
    /sticky\.right\.append\(playAll\.el\)/.test(view)
    && !/head\.append\(art, heading, play\.el\)/.test(view));
  check("异步歌手分组完成后重新同步播放全部可用态",
    /renderSongRows\(rows, group\.songs[\s\S]{0,220}?playAll\.sync\(\)/.test(view));
  check("隐藏的列表面板不占位（显式类，不用 :has 覆盖 hidden）",
    view.includes('"tag-panel all-list-panel"')
    && css.includes(".all-page:is([data-view=\"artist\"], [data-view=\"album\"]) .all-list-panel:not([hidden])")
    && !css.includes(".all-page .tag-panel:has("));
  check("合唱曲不把首位歌手 mid 复制给所有人",
    read("src/lib/local.ts").includes("const matchedSingerMid = artists.length === 1"));
  check("专辑分类走专辑分组函数", view.includes("groupSongsByAlbum("));
  check("本地库与我喜欢都有实时订阅",
    view.includes("onLocalLibraryChange(") && view.includes("player.onLovedListChange("));
  check("本地音乐沿用虚拟歌单的吸顶结构（标题/源管理先滚，吸顶条固定）",
    read("src/views/local.ts").includes("mountStickyBar(root, { name: \"本地音乐\" })")
    && read("src/views/local.ts").includes("sticky.off()")
    && read("src/views/local.ts").includes('classList.add("local-page")'));
  check("分类刷新时释放旧归并任务槽位", view.includes("artistFlight = null;"));
  check("三视图面板用 hidden 切换（不重拉数据）", view.includes("panels[view.key].hidden") && view.includes('body.classList.add("tab-anim")'));
  check("所有歌曲有独立 CD 封面样式", css.includes(".all-cover") && css.includes(".all-cover::after"));

  check("反向：路由缺失即测不到", !/"\/all": \(\) => import\("\.\/all"\)/.test(views.replace('"/all": () => import("./all")', "")));
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n=== 合计 ${pass} 通过 / ${fail} 失败 ===`);

process.exit(fail ? 1 : 0);
