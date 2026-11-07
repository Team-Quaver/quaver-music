// MPRIS：进程内服务模型 + 接线 + 旧子进程/submodule 残留守卫。
//
// 这个脚本不要求真实 D-Bus 会话：用假 factory 把状态投影、外推、控制回推跑到真代码上。
// 真总线联调另跑 `dbus-run-session -- playerctl ...`，但那依赖桌面工具，不能塞进 static 闸门。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMprisBridge,
  extrapolatePositionUs,
  trackPath,
  type MprisCommand,
  type MprisPlayerInstance,
  type MprisState,
} from "../electron/mpris.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..");
const read = (path: string) => readFileSync(path, "utf8");
const readRepo = (path: string) => readFileSync(join(repo, path), "utf8");

let checks = 0;
let fails = 0;

function ok(name: string, condition: boolean, note = "") {
  checks++;

  if (condition) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
}

class FakePlayer implements MprisPlayerInstance {
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  metadata: Record<string, unknown> = {};
  playbackStatus = "Stopped";
  loopStatus = "None";
  shuffle = false;
  volume = 0;
  canGoNext = false;
  canGoPrevious = false;
  canPlay = false;
  canPause = false;
  canSeek = false;
  canControl = false;
  hasTrackList = false;
  tracks?: Record<string, unknown>[];
  options: Record<string, unknown>;
  seekedAt: number | null = null;
  disconnected = false;
  _bus = { disconnect: () => { this.disconnected = true; } };

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  getPosition(): number { return -1; }
  seeked(posUs: number): void { this.seekedAt = posUs; }
  objectPath(sub: string): string { return `/fake/${sub}`; }
}

let clockMs = 10_000;
let fake: FakePlayer | null = null;

/** fake 由 factory 同步赋值，但赋值在闭包里 —— CFA 只看得见初值 null，读它会被压成 never。
 *  断言统一走这个读取口：函数体里取的是声明类型（FakePlayer | null）。 */
const player = () => fake;
const commands: MprisCommand[] = [];

const bridge = createMprisBridge({
  platform: "linux",
  nowMs: () => clockMs,
  factory: (options) => {
    fake = new FakePlayer(options);

    return fake;
  },
  onCommand: (msg) => commands.push(msg),
});

ok("Linux 上创建 MPRIS 服务", !!bridge && !!fake);

ok("非 Linux 直接返回 null", createMprisBridge({ platform: "win32", onCommand: () => {} }) === null);

ok("总线名与桌面项身份正确", player()?.options.name === "quaver"
  && player()?.options.desktopEntry === (process.env.FLATPAK_ID || "red.0w0.quaver"));

ok("root.HasTrackList 的库疏漏已补", player()?.hasTrackList === true);

ok("CanControl=true", player()?.canControl === true);

const track = {
  mid: "MID001",
  key: "KEY/001",
  name: "测试曲目",
  artists: ["歌手A", "歌手B"],
  album: "专辑",
  artUrl: "https://example.test/cover.jpg",
  durationSec: 180,
};

const state: MprisState = {
  v: 1,
  t: "state",
  status: "Playing",
  posUs: 30_000_000,
  volume: 0.65,
  loop: "Playlist",
  shuffle: true,
  track: { ...track, asText: "第一句\n第二句" },
  queue: [track, { ...track, mid: "MID002", key: "KEY002", name: "第二首" }],
  can: { next: true, prev: true, play: true, pause: true, seek: true, control: true },
};

clockMs = 20_000;

bridge?.applyState(state);

ok("PlaybackStatus 投影", player()?.playbackStatus === "Playing");

ok("LoopStatus 投影", player()?.loopStatus === "Playlist");

ok("Shuffle/Volume 投影", player()?.shuffle === true && Math.abs((player()?.volume ?? 0) - 0.65) < 1e-9);

ok("能力位整体投影", !!(player()?.canGoNext && player()!.canGoPrevious && player()!.canPlay && player()!.canPause && player()!.canSeek));

ok("当前曲目 Metadata 投影", player()?.metadata["xesam:title"] === "测试曲目"
  && player()!.metadata["mpris:trackid"] === "/org/quaver/track/KEY_001"
  && player()!.metadata["mpris:length"] === 180_000_000
  && player()!.metadata["xesam:artist"] instanceof Array);

ok("xesam:asText 扩展元数据投影", player()?.metadata["xesam:asText"] === "第一句\n第二句");

ok("TrackList 整表投影", player()?.tracks?.length === 2
  && player()!.tracks![1]["mpris:trackid"] === "/org/quaver/track/KEY002");

ok("TrackList 项不带歌词", !("xesam:asText" in player()!.tracks![0]) && !("xesam:asText" in player()!.tracks![1]));

// 歌词异步到达：trackid 不变、asText 变了，Metadata 必须跟着更新（不能被 trackKey 去重吞掉）
bridge?.applyState({ ...state, track: { ...track, asText: "改过的第一句" } });

ok("asText 异步更新（曲目不变）", player()?.metadata["xesam:asText"] === "改过的第一句");

bridge?.applyState({ ...state, track: { ...track, asText: "" } });

ok("asText 清空后从 Metadata 移除", !("xesam:asText" in player()!.metadata));

bridge?.applyState({ ...state, track: { ...track, asText: "第一句\n第二句" } }); // 还原，供后续断言

clockMs = 22_500;

ok("Position 从快照单调外推 +2.5s", player()?.getPosition() === 32_500_000);

bridge?.applyState({ ...state, status: "Paused", posUs: 30_000_000 });

clockMs = 30_000;

ok("暂停后 Position 冻结", player()?.getPosition() === 30_000_000);

ok("外推封顶到曲目时长", extrapolatePositionUs(179_000_000, 5_000, true, 180_000_000) === 180_000_000);

ok("负数/NaN 位置归零", extrapolatePositionUs(-1, Number.NaN, true, 0) === 0);

bridge?.applyState({ ...state, seeked: true });

ok("seeked 信号跟随快照", player()?.seekedAt === 30_000_000);

player()?.emit("next");

player()?.emit("volume", 0.42);

player()?.emit("position", { trackId: "/org/quaver/track/KEY_001", position: 12_500_000 });

player()?.emit("goTo", "/org/quaver/track/KEY002");

player()?.emit("raise");

ok("总线命令回推 next", commands.some((msg) => msg.cmd === "next"));

ok("总线命令回推 volume", commands.some((msg) => msg.cmd === "volume" && msg.value === 0.42));

ok("SetPosition → seekTo", commands.some((msg) => msg.cmd === "seekTo" && msg.posSec === 12.5));

ok("TrackList.GoTo → jump", commands.some((msg) => msg.cmd === "jump" && msg.trackId === "/org/quaver/track/KEY002"));

ok("Raise 原样交给主进程消费", commands.some((msg) => msg.cmd === "raise"));

ok("trackPath 安全化 + 稳定", trackPath({ key: "a/b c" }) === "/org/quaver/track/a_b_c");

bridge?.destroy();

ok("destroy 释放 D-Bus 连接", player()?.disconnected === true);

// —— 接线与依赖残留 ——
const main = read(join(root, "electron", "main.ts"));
const pkg = JSON.parse(read(join(root, "package.json"))) as { dependencies?: Record<string, string> };
const builder = readRepo("packages/electron-builder-base.yml");
const gitmodules = readRepo(".gitmodules");
const workflows = readRepo(".github/workflows/build.yml");
const renderer = read(join(root, "src", "mpris.ts"));
const playerSrc = read(join(root, "src", "player.ts"));

ok("主进程使用进程内 createMprisBridge", main.includes("createMprisBridge") && main.includes("mpris?.applyState(state)"));

ok("主进程不再 spawn MPRIS daemon", !main.includes("mpris-daemon") && !/spawn\([^)]*mpris/.test(main));

ok("mpris-service 是生产依赖（打包会带）", pkg.dependencies?.["mpris-service"] === "2.1.2");

ok("electron-builder 不再复制 mpris-daemon.cjs", !builder.includes("mpris-daemon.cjs") && !builder.includes("vendor/Typhoeus/mpris"));

ok("CI 不再构建/搬运 MPRIS daemon", !workflows.includes("vendor/Typhoeus/mpris") && !workflows.includes("mpris-daemon.cjs"));

ok("loong64 手工 asar 会装生产依赖", workflows.includes("npm install --prefix \"$APP\" --omit=dev")
  && workflows.includes("node_modules/mpris-service/dist/index.js"));

ok("Typhoeus 子模块已退役", !gitmodules.includes("path = vendor/Typhoeus\n") && !gitmodules.includes("quaver-typhoeus"));

ok("渲染层仍与主进程同一 trackPath 规则", renderer.includes('replace(/[^A-Za-z0-9_]/g, "_")'));

ok("渲染层快照携带 asText", renderer.includes("asText: player.lyricAsText"));

ok("歌词到达会触发新快照（指纹含 asText）", renderer.includes("player.lyricAsText, // 歌词异步到达"));

ok("asText 从任意来源的解析行产出（含 QRC/TTML）",
  (playerSrc.match(/mprisLyricText\(this\.lyrics\)/g) ?? []).length >= 2
  && !playerSrc.includes("isLrcText"));

ok("asText 格式受设置开关控制", playerSrc.includes("getMprisLrc() ? lyricLinesToLrc(lines) : lyricLinesToText(lines)"));

ok("设置页有 asText 格式开关", read(join(root, "src", "views", "settings.ts")).includes('id="mpris-lrc-cards"'));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);

process.exit(fails ? 1 : 0);
