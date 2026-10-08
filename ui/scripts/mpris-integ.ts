// 双向集成验证（真·Electron 应用内）：
//   方向 A：渲染层改 player 状态 → mpris 桥 → 主进程 → daemon → D-Bus 总线（playerctl/gdbus 读回）
//   方向 B：总线 Set LoopStatus/Volume → daemon cmd → 主进程 → 渲染层回调 → player 状态变化
import puppeteer from "puppeteer-core";
import { execFile } from "node:child_process";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (...args) =>
  new Promise((res) => execFile(args[0], args.slice(1), { timeout: 10000 }, (e, so, se) => res({ code: e ? 1 : 0, out: (so + se).trim() })));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  | " + detail.slice(0, 140) : "")); ok ? pass++ : fail++; };

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${process.env.CDP_PORT || 9333}`, defaultViewport: null });
const allPages = await browser.pages();
const page = allPages.find((p) => (p.url() || "").includes("index.html")) || allPages[0];
console.log("attached:", page.url());

check("A0 渲染层暴露 quaverMpris 桥", await page.evaluate(() => !!window.quaverMpris));
check("A0b dev 播放器钩子在位", await page.evaluate(() => !!window.__quaverPlayer));

// —— 方向 A：直接改渲染层 player（与真实 UI 操作等效），桥应自动把状态推上总线 ——
await page.evaluate(() => {
  const p = window.__quaverPlayer;
  p.queue = [
    { mid: "INTEG01", id: 1, name: "集成验证曲", singer: [{ name: "验证歌手甲" }, { name: "验证歌手乙" }], album: { pmid: "abc123_", name: "集成专辑" }, interval: 200, _key: "INTEG01" },
    { mid: "INTEG02", id: 2, name: "第二首验证", singer: [{ name: "歌手丙" }], album: {}, interval: 120, _key: "INTEG02" },
  ];
  p.index = 0;
  p.notifyPublic();
});
await sleep(800);

let r = await sh("playerctl", "-p", "quaver", "metadata", "xesam:title");
check("A1 总线标题=集成验证曲", r.out === "集成验证曲", r.out);
r = await sh("playerctl", "-p", "quaver", "metadata", "xesam:artist");
check("A2 总线歌手含两人", r.out.includes("验证歌手甲") && r.out.includes("验证歌手乙"), r.out);
r = await sh("gdbus", "call", "--session", "--dest", "org.mpris.MediaPlayer2.quaver", "--object-path", "/org/mpris/MediaPlayer2",
  "--method", "org.mpris.MediaPlayer2.Player.GetAll" );
r = await sh("gdbus", "call", "--session", "--dest", "org.mpris.MediaPlayer2.quaver", "--object-path", "/org/mpris/MediaPlayer2",
  "--method", "org.freedesktop.DBus.Properties.GetAll", "org.mpris.MediaPlayer2.Player");
check("A3 Metadata trackid 路径正确", r.out.includes("/org/quaver/track/INTEG01"), "");
check("A4 Volume 上报（0.8 默认）", /'Volume': <0\.8/.test(r.out), r.out.match(/'Volume': <[^>]*>/)?.[0] || "");

// 队列 → TrackList
r = await sh("gdbus", "call", "--session", "--dest", "org.mpris.MediaPlayer2.quaver", "--object-path", "/org/mpris/MediaPlayer2",
  "--method", "org.freedesktop.DBus.Properties.Get", "org.mpris.MediaPlayer2.TrackList", "Tracks");
check("A5 TrackList 含两曲", r.out.includes("INTEG01") && r.out.includes("INTEG02"), r.out);

// 播放态：模拟 play（无音频源时 toggle 会走取链失败 → 用直接设 playback 语义验证：把 audio.play 打桩）
await page.evaluate(() => {
  const p = window.__quaverPlayer;
  Object.defineProperty(p.audio, "paused", { get: () => false, configurable: true }); // 桩：视为正在播
  p.notifyPublic();
});
await sleep(600);
r = await sh("playerctl", "-p", "quaver", "status");
check("A6 状态 Playing 上总线", r.out === "Playing", r.out);

// —— 方向 B：总线写属性 → 渲染层状态变化 ——
r = await sh("gdbus", "call", "--session", "--dest", "org.mpris.MediaPlayer2.quaver", "--object-path", "/org/mpris/MediaPlayer2",
  "--method", "org.freedesktop.DBus.Properties.Set", "org.mpris.MediaPlayer2.Player", "LoopStatus", newVariant("s", "Track"));
check("B0 Set LoopStatus 总线成功", r.code === 0, r.out);
await sleep(800);
let mode = await page.evaluate(() => window.__quaverPlayer.mode);
check("B1 渲染层 mode→one（单曲循环）", mode === "one", String(mode));

r = await sh("gdbus", "call", "--session", "--dest", "org.mpris.MediaPlayer2.quaver", "--object-path", "/org/mpris/MediaPlayer2",
  "--method", "org.freedesktop.DBus.Properties.Set", "org.mpris.MediaPlayer2.Player", "Volume", newVariant("d", "0.42"));
await sleep(800);
const vol = await page.evaluate(() => window.__quaverPlayer.volume);
check("B2 渲染层 volume→0.42", Math.abs(vol - 0.42) < 0.02, String(vol));

// Next 命令 → index 前进
r = await sh("playerctl", "-p", "quaver", "next");
await sleep(600);
const idx = await page.evaluate(() => window.__quaverPlayer.index);
check("B3 Next() 渲染层 index→1", idx === 1, String(idx));

// —— 渲染层→总线的回环再确认（B1 的 loop 改动应回流上总线）——
r = await sh("gdbus", "call", "--session", "--dest", "org.mpris.MediaPlayer2.quaver", "--object-path", "/org/mpris/MediaPlayer2",
  "--method", "org.freedesktop.DBus.Properties.Get", "org.mpris.MediaPlayer2.Player", "LoopStatus");
check("B4 LoopStatus 稳定为 Track（双向同步闭环）", r.out.includes("Track"), r.out);

browser.disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

function newVariant(sig, val) {
  return `<${sig === "s" ? `'${val}'` : val}>`;
}
