// Quaver — 自然曲末一次性闸门：纯单测 + 播放器/引擎接线护栏。
// 跑：node scripts/verify-playback-end.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlaybackEndGate } from "../src/lib/playback-end.ts";

const UI = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(UI, p), "utf8");
const player = read("src/player.ts");
const engine = read("electron/audio/engine.ts");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n=== 曲末闸门 ===");

const gate = new PlaybackEndGate();

check("首次曲末放行", gate.consume() === true);

check("PCM 尾音排空后的迟到 ended 被吞", gate.consume() === false);

gate.reset();

check("新曲起播后重新放行", gate.consume() === true);

check("播放器不再用 loading 吞真实曲末",
  !/case "ended":\s*\n\s*if \(this\.loading\) break/.test(player)
    && /case "ended":\s*\n\s*if \(!this\.endGate\.consume\(\)\) break/.test(player));

check("PCM ending 与 ended 共用同一个曲末闸门",
  /case "ending":[\s\S]{0,260}this\.endGate\.consume\(\)/.test(player)
    && /case "ended":[\s\S]{0,100}this\.endGate\.consume\(\)/.test(player));

check("PCM ending 自带判重，不依赖通用 loading",
  /case "ending":[\s\S]{0,220}!this\.endGate\.consume\(\)/.test(player)
    && !/case "ending":[\s\S]{0,220}this\.loading/.test(player));

check("主动打断/新曲出声会重置闸门",
  /private interrupt\(stopOutput = true\)[\s\S]{0,180}this\.endGate\.reset\(\)/.test(player)
    && /case "playing":[\s\S]{0,180}this\.endGate\.reset\(\)/.test(player));

check("引擎的 MPV 曲末按 entry id 只发一次",
  /private finishTrack\(\): void \{[\s\S]{0,140}this\.endedEntryId === this\.currentEntryId/.test(engine)
    && /this\.endedEntryId = this\.currentEntryId/.test(engine));

check("pause/idle 晚到不会重复推进队列",
  /d === true && this\.st\.idle\) this\.finishTrack\(\)/.test(engine));

console.log(`\n${fail === 0 ? "✅" : "❌"} playback-end: ${pass} pass, ${fail} fail`);

process.exit(fail === 0 ? 0 : 1);
