// 歌单「拖拽重排」：纯逻辑跑真单测，接线/样式/后端路由跑静态断言
//
// 钉死的口径（上游 QQMusicApi PR 307 + 本仓的护栏套路）：
//  ① 提交必须是**整单**新顺序（SeqSonglist 对部分提交照样回成功但打乱未提交歌曲）；
//  ② song_type 发**读侧原值**（写侧枚举转换收口在 Go SDK，渲染层不做偏移）；
//  ③ 只在「自有歌单 + 默认序 + 无搜索」开放拖拽（筛排副本映射不回服务端顺序）；
//  ④ 写失败整表回滚 + toast；写成功记重排庇护（读侧滞后按已确认顺序校正）；
//  ⑤ 指针监听挂 window（insertBefore 丢捕获的坑，与 QueuePanel 同源）；
//  ⑥ .row.dragging 的 transition 不许带 transform（rect 残差复利 → 行飞出指针）。
//
// 用法：node scripts/verify-songlist-reorder.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let fails = 0;
let checks = 0;

const ok = (name, cond, note = "") => {
  checks++;

  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};

const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ===================== 真单测：可见子序列回映射 =====================
const { applyVisibleOrder } = await import("../src/lib/reorder.ts");
const { applyOrderMark, orderComplete } = await import("../src/lib/order-shelter.ts");

const A = { mid: "a" }, B = { mid: "b" }, C = { mid: "c" }, D = { mid: "d" };

eq("全量重排：可见=全体，按新序放回", applyVisibleOrder([A, B, C], [C, A, B]), [C, A, B]);

eq("子集重排：只动可见成员的位置，其余原地不动",
  applyVisibleOrder([A, B, C, D], [C, A]), [C, B, A, D]);

eq("子集重排：成员判定按引用不按 mid（重复曲目不串台）",
  (() => {
    const dup1 = { mid: "x" }, dup2 = { mid: "x" };

    return applyVisibleOrder([dup1, B, dup2], [dup2, dup1]);
  })(),
  [{ mid: "x" }, B, { mid: "x" }]);

eq("原数组不被就地改动", (() => {
  const src = [A, B, C];
  applyVisibleOrder(src, [C, B, A]);

  return src;
})(), [A, B, C]);

eq("空 moved = 原序原样", applyVisibleOrder([A, B], []), [A, B]);

// ===================== 真单测：重排庇护（读侧旧序校正） =====================
const s = (mid) => ({ mid });
const mark = (mids) => ({ mids, at: Date.now() });

eq("庇护：读侧旧序按已确认顺序归位",
  applyOrderMark(mark(["c", "a", "b"]), [s("a"), s("b"), s("c")]).map((x) => x.mid), ["c", "a", "b"]);

eq("庇护：名单外的歌（他端新加）保持读侧相对顺序缀后",
  applyOrderMark(mark(["b", "a"]), [s("a"), s("x"), s("b"), s("y")]).map((x) => x.mid), ["b", "a", "x", "y"]);

eq("庇护：重复 mid 保序配对（第 k 次领第 k 行，不串台）",
  (() => {
    const r1 = { mid: "x", v: 1 }, r2 = { mid: "x", v: 2 };
    const out = applyOrderMark(mark(["x", "x"]), [r1, r2]);

    return out[0] === r1 && out[1] === r2;
  })(), true);

eq("庇护：读侧多出的同名行缀后不丢",
  applyOrderMark(mark(["x"]), [s("x"), s("x"), s("y")]).length, 3);

eq("截断守卫：可见数 < 总数 → 禁拖（部分提交会打乱未提交歌曲）", orderComplete(1000, 1200), false);

eq("截断守卫：完整列表 → 开放", orderComplete(120, 120), true);

eq("截断守卫：空列表 → 禁拖", orderComplete(0, 0), false);

// ===================== 静态断言：接线不许被改坏 =====================
const mod = read("src/lib/songlist-reorder.ts");
const pl = read("src/lib/playlists.ts");
const detail = read("src/lib/songlist-detail.ts");
const view = read("src/views/playlist.ts");
const liked = read("src/views/liked.ts");
const player = read("src/player.ts");
const songs = read("src/lib/songs.ts");
const tools = read("src/components/ListTools.ts");
const css = read("src/style.css");
const go = readFileSync(join(root, "..", "vendor", "Typhoeus-go", "server", "handlers_content.go"), "utf8");
const goRoutes = readFileSync(join(root, "..", "vendor", "Typhoeus-go", "server", "app.go"), "utf8");
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// —— 数据层 ——
ok("playlists: reorderSonglist 走 POST /songlist/{dirid}/order + tid + 整单 songs",
  /postJson<\{ ok: boolean \}>\(`\/songlist\/\$\{target\.dirid\}\/order`, \{ tid: target\.tid \?\? 0, songs \}\)/.test(noComments(pl)));

ok("playlists: song_type 发读侧原值（不做写侧偏移）",
  /song_type: Number\(s\.type \?\? 1\)/.test(noComments(pl)));

ok("playlists: 空列表/缺 dirid/缺 song_id 都抛错（不静默上行）",
  /重排列表为空/.test(pl) && /缺少歌单 dirid，无法重排/.test(pl) && /缺少 song_id，无法重排/.test(pl));

ok("playlists: ok=false 抛错（assertAccepted 收口）", /assertAccepted\(r, "歌单重排"\)/.test(noComments(pl)));

// —— 庇护/回源 ——
ok("detail: noteSonglistOrder 记庇护 + 乐观改序 + 广播 + 排回源",
  /export function noteSonglistOrder/.test(detail)
  && /orderMarks\.set\(key, \{ mids: ordered\.map/.test(noComments(detail))
  && /emit\(key\)/.test(noComments(detail))
  && /syncSonglistSoon\(key\)/.test(noComments(detail)));

ok("detail: 整单回源与增量回源都过 applyOrderMark（读侧旧顺序被校正）",
  (noComments(detail).match(/applyOrderMark\(/g) ?? []).length >= 3);

ok("detail: 庇护按 PENDING_TTL 过期（他端改序最终收敛）",
  /Date\.now\(\) - mark\.at > PENDING_TTL/.test(noComments(detail)));

// —— 拖拽机制 ——
ok("reorder: pointermove/up/cancel 挂 window（insertBefore 丢捕获的坑）",
  /window\.addEventListener\("pointermove", onMove\)/.test(noComments(mod))
  && /window\.addEventListener\("pointerup", onUp\)/.test(noComments(mod))
  && /window\.addEventListener\("pointercancel", onCancel\)/.test(noComments(mod)));

ok("reorder: 整行按住即可起拖，不再有把手/拖拽提示",
  /const row = target\.closest<HTMLElement>\("\.row\[data-songkey\]"\)/.test(noComments(mod))
  && !/row-grip/.test(noComments(mod))
  && !/row-grip/.test(noComments(songs))
  && !/拖动调整歌单顺序/.test(mod));

ok("reorder: 行内链接/按钮不参与起拖（保留原生点击）",
  /target\.closest\("a, button, input, textarea, select"\)/.test(noComments(mod)));

ok("reorder: 量文档流位置前先清 transform",
  /row\.style\.transform = "";\s*const flowTop = row\.getBoundingClientRect\(\)\.top/.test(noComments(mod)));

ok("reorder: 几何/序列复用 lib/reorder.ts（dropSlot/edgeSpeed/applyVisibleOrder）",
  /import \{ dropSlot, edgeSpeed, applyVisibleOrder \} from "\.\/reorder"/.test(mod));

ok("reorder: 提交整单（applyVisibleOrder 回映射后全量发），失败回滚 + toast",
  /const ordered = applyVisibleOrder\(source, orderedVisible\)/.test(noComments(mod))
  && /opts\.submit\(ordered\)/.test(noComments(mod))
  && /toast\("歌单重排失败："/.test(noComments(mod))
  && /opts\.onRollback\(\)/.test(noComments(mod)));

ok("reorder: 成功走 onOrdered（视图改序）；取消/节点被摘走 onAbort（不拿旧副本盖数据层）",
  /opts\.onOrdered\(ordered\)/.test(noComments(mod))
  && /opts\.onAbort\(\)/.test(noComments(mod)));

ok("view(歌单): submit = reorderSonglist + noteSonglistOrder（庇护在数据层）",
  /await reorderSonglist\(\{ dirid: Number\(info\?\.dirid \?\? 0\), tid: Number\(info\?\.id \?\? 0\) \}, ordered\)/.test(noComments(view))
  && /noteSonglistOrder\(id, ordered\)/.test(noComments(view)));

// —— 「我喜欢」= dirid 201 的歌单，同一条 SeqSonglist ——
ok("player: reorderLoved 走 dirid=201 + 截断兜底 + 庇护 + 乐观改序 + 广播 + 回源",
  /reorderSonglist\(\{ dirid: 201, tid: 0 \}, ordered\)/.test(noComments(player))
  && /this\.likedCache\.length < this\.likedTotal/.test(noComments(player))
  && /this\.lovedOrderMark = \{ mids: ordered\.map/.test(noComments(player))
  && /this\.likedCache = applyOrderMark\(this\.lovedOrderMark, this\.likedCache\)/.test(noComments(player))
  && /this\.emitLovedListChange\(\)/.test(noComments(player)));

ok("player: 三条读路径（整单预载/增量回源/远端探针）都过重排庇护",
  (noComments(player).match(/applyOrderMark\(/g) ?? []).length >= 4);

ok("player: 庇护 localStorage 持久化（跨重载，过期同写入庇护）",
  /LS_LOVED_ORDER_KEY/.test(player) && /localStorage\.setItem\(LS_LOVED_ORDER_KEY/.test(noComments(player)));

ok("view(我喜欢): 仅默认序 + 无搜索 + 预载完整开放（orderComplete 守卫）",
  /const reorderOn = \(\) => tools\.plain\(\) && orderComplete\(items\.length, player\.likedTotal\)/.test(noComments(liked))
  && /submit: \(ordered\) => player\.reorderLoved\(ordered\)/.test(noComments(liked)));

ok("view(我喜欢): 拖拽中跟进重画被挡 + 退订登记（含失败/早退路径）",
  (noComments(liked).match(/songlistReorderActive\(box\)/g) ?? []).length >= 2
  && (noComments(liked).match(/offReorder\(\);/g) ?? []).length >= 2
  && !/offGrips|syncGrips|row-grip/.test(noComments(liked)));

ok("reorder: 写在途不接受第二次起拖（submitting 闸）",
  /dragRow \|\| submitting \|\| !opts\.enabled\(\)/.test(noComments(mod)));

ok("reorder: Esc 取消走 onRollback（按旧序整表重画）",
  /ev\.key !== "Escape"/.test(noComments(mod)) && /finish\(false\)/.test(noComments(mod)));

ok("reorder: 拖完吞掉补发的 click（suppressNextRowClick）",
  /suppressNextRowClick\(\)/.test(noComments(mod))
  && /export function suppressNextRowClick/.test(songs)
  && /if \(suppressRowClick\) return;/.test(noComments(songs)));

// —— 视图接线 ——
ok("view: 仅自有歌单 + 默认序 + 无搜索开放（own && tools.plain()）",
  /const reorderOn = \(\) => own && tools\.plain\(\)/.test(noComments(view))
  && /enabled: reorderOn/.test(noComments(view)));

ok("view: 只把 enabled 交给重排器，行渲染不再接收 reorder/把手",
  /enabled: reorderOn/.test(noComments(view))
  && !/reorder: reorderOn\(\)/.test(noComments(view))
  && !/row-grip/.test(noComments(view))
  && !/reorder\?: boolean/.test(songs));

ok("view: 拖拽中不整表重画（songlistReorderActive 守卫，松手后自然对上）",
  (noComments(view).match(/songlistReorderActive\(rows\)/g) ?? []).length >= 2);

ok("view: 退订登记进 cleanups（路由切换不留死监听）",
  /cleanups\.push\(offReorder\)/.test(noComments(view)));

ok("tools: plain() 对外暴露（每次起拖现问是否默认序 + 无搜索）",
  /plain\(\): boolean/.test(tools)
  && /const plain = \(\) => sortKey === "default" && !kw\.trim\(\)/.test(noComments(tools))
  && !/onState/.test(tools));

// —— 样式 ——
ok("css: .row.dragging 的 transition 不带 transform（残差复利的坑）",
  /\.row\.dragging \{[^}]*transition: background \.14s;[^}]*\}/.test(css)
  && !/\.row\.dragging \{[^}]*transition:[^;}]*transform/.test(css));

ok("css: 不再有把手样式；重排中整行 grabbing",
  !/\.row-grip/.test(css)
  && /\.rows\.reordering, \.rows\.reordering \.row \{ cursor: grabbing; \}/.test(css));

// —— 后端路由对得上 ——
ok("Go sidecar: POST /songlist/{dirid}/order -> ReorderSongs（全量守卫在 handler）",
  /"POST \/songlist\/\{dirid\}\/order"/.test(goRoutes)
  && /handleSonglistReorder[\s\S]{0,900}ReorderSongs\(dirid, body\.Tid, refs\)/.test(go)
  && /songs 不能为空/.test(go));

console.log(`\n${checks - fails}/${checks} passed`);

if (fails) process.exit(1);
