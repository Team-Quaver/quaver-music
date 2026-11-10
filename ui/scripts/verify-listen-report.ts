// 听歌时长上报累加器：纯逻辑单测（假时钟 + 假发送端，不跑浏览器/网络）。
import { ListenTimeReporter, type ListenReportTarget } from "../src/lib/listen-report.ts";

let pass = 0;
let fail = 0;

const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const target = (n: number): ListenReportTarget => ({
  mid: `mid-${n}`,
  mediaMid: `media-${n}`,
  songId: n,
  audioTimeMs: 180_000,
  songType: 1,
  singerId: 9,
  coSinger: "歌手",
  streamToken: `token-${n}`,
});

let now = 0;
let enabled = true;
const sends: Record<string, any>[] = [];

const reporter = new ListenTimeReporter({
  now: () => now,
  tickMs: 0,
  enabled: () => enabled,
  send: async (body) => { sends.push(body); return { ok: true }; },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const advance = (to: number) => {
  while (now < to) {
    now = Math.min(to, now + 1_000);
    reporter.pulse();
  }
};

reporter.setTarget(target(1));

reporter.setPlaying(true);

advance(65_000);

await settle();

eq("播放中不按 60 秒分片上报", sends.length, 0);

advance(130_000);

await settle();

eq("持续播放也不中途上报", sends.length, 0);

reporter.setPlaying(false);

advance(160_000);

reporter.setPlaying(true);

advance(190_000);

reporter.setTarget(target(2));

await settle();

eq("切歌时只上报一次", sends.length, 1);

eq("一次性上报累计真实播放时长（暂停不累计）", sends[0]?.play_duration_seconds, 160);

eq("歌曲与流 token 原样传给后端", [sends[0]?.song_id, sends[0]?.stream_token], [1, "token-1"]);

reporter.setPlaying(true);

advance(230_000);

reporter.setPlaying(false);

advance(280_000);

reporter.setPlaying(true);

advance(310_000);

reporter.flush();

await settle();

eq("曲末 flush 上报本曲累计", [sends.length, sends[1]?.play_duration_seconds], [2, 70]);

eq("flush 归属当前曲", sends[1]?.song_id, 2);

reporter.setTarget(target(3));

await settle();

eq("flush 后切歌不重复上报", sends.length, 2);

reporter.setPlaying(true);

advance(340_000);

enabled = false;

reporter.pulse();

await settle();

eq("关闭时不发送", sends.length, 2);

advance(370_000);

enabled = true;

reporter.setPlaying(false);

reporter.flush();

await settle();

eq("关闭期间的时间不补发", sends.length, 2);

// 很短的手动切歌不单独发流水，避免上游被碎片请求淹没。
now = 375_000;

reporter.setTarget(target(4));

reporter.setPlaying(true);

advance(377_000);

reporter.setPlaying(false);

reporter.setTarget(target(5));

await settle();

eq("不足 5 秒的碎片不单独上报", sends.length, 2);

reporter.setPlaying(true);

advance(385_000);

reporter.stopTarget();

await settle();

eq("停止时一次性上报并清空目标", [sends.length, sends[2]?.play_duration_seconds, sends[2]?.song_id], [3, 8, 5]);

reporter.dispose();

console.log(`\n${pass} passed, ${fail} failed`);

process.exitCode = fail ? 1 : 0;
