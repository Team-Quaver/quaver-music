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
eq("满 60 秒先切一整段", sends.length, 1);
eq("分片时长固定 60 秒", sends[0]?.play_duration_seconds, 60);
eq("歌曲与流 token 原样传给后端", [sends[0]?.song_id, sends[0]?.stream_token], [1, "token-1"]);

advance(70_000);
reporter.setPlaying(false);
reporter.setTarget(target(2));
await settle();
eq("切歌补报上一首尾段", [sends.length, sends[1]?.play_duration_seconds], [2, 10]);
eq("尾段归属上一首", sends[1]?.song_id, 1);

reporter.setPlaying(true);
advance(130_000);
await settle();
eq("暂停期间不累计", sends.length, 3); // 恢复后只累计 60s，恰好又满一段

advance(140_000);
enabled = false;
reporter.pulse();
await settle();
eq("关闭时不发送", sends.length, 3);
enabled = true;
reporter.setPlaying(false);
reporter.flush();
await settle();
eq("关闭期间的时间不补发", sends.length, 3);

// 很短的手动切歌不单独发流水，避免上游被碎片请求淹没。
now = 145_000;
reporter.setPlaying(true);
now = 147_000;
reporter.pulse();
reporter.setPlaying(false);
reporter.setTarget(target(3));
await settle();
eq("不足 5 秒的碎片不单独上报", sends.length, 3);

reporter.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
