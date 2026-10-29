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

check("显式 stop 清掉 eof 后重挂用的 lastUrl（清队列后不会再复活旧曲）",
  /case "stop":[\s\S]{0,900}this\.lastUrl = ""/.test(engine));

console.log("\n=== 同曲兜底 ===");

check("兜底匹配共享同曲在途 Promise",
  /private fallbackLookup: \{ mid: string; promise: Promise<Song \| null> \} \| null/.test(player)
    && /this\.fallbackLookup\?\.mid === s\.mid \? this\.fallbackLookup\.promise : null/.test(player)
    && /const found = await lookup/.test(player));

check("在途兜底不会被并发失败分支当成「已失败」",
  /if \(this\.fallbackForMid === s\.mid && !this\.fallbackLookup\) return false/.test(player)
    && /if \(this\.fallbackSong && this\.fallbackForMid === s\.mid\) return true/.test(player));

check("流错误分支也会加入同一轮在途兜底",
  /} else if \(await this\.tryPlaybackFallback\(s, this\.transport\.position > 1/.test(player));

check("兜底源不会再次重定向到自身",
  /if \(!overrideTier && s === this\.current && this\.fallbackSong && this\.fallbackForMid === s\.mid\)/.test(player));

check("起播异常先等兜底落定，再决定跳曲",
  /if \(await this\.tryPlaybackFallback\(s, resumedAt\)\) return;[\s\S]{0,420}this\.skipSong\(msg\)/.test(player));

check("空闲时预热本地/微云兜底索引",
  /window\.requestIdleCallback\(warmFallback, \{ timeout: 2_000 \}\)/.test(player)
    && /window\.setTimeout\(warmFallback, 1_200\)/.test(player));

check("兜底源也受起播看门狗保护",
  /if \(!autoplay \|\| isLocalSong\(s\) \|\| s\.directUrl\) return;/.test(player)
    && /const timeout = this\.playbackFallback \? 15_000 : 20_000/.test(player));

check("加载中优先用当前队列行曲长，不沿用上一首时长",
  /if \(this\.loading && hint > 0\) return hint;/.test(player));

check("同曲副本存在时并行快探 QQ 128 档",
  /private async resolveQuickFallback\(s: Song\)/.test(player)
    && /await this\.resolveWithSources\(s, "128"\)/.test(player)
    && /const first = await Promise\.race\(\[/.test(player)
    && /if \(!overrideTier && !fallbackPreflight && !s\.directUrl && !isLocalSong\(s\)\)/.test(player));

check("后端明确无播档位时不再重复请求 128",
  /if \(e instanceof ApiError && \/无可播档位\/\.test\(e\.message\)\) throw e;/.test(read("src/lib/api.ts")));

console.log(`\n${fail === 0 ? "✅" : "❌"} playback-end: ${pass} pass, ${fail} fail`);

process.exit(fail === 0 ? 0 : 1);
