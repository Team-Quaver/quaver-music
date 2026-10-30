// 同曲兜底匹配的纯单测（零依赖；Node strip-types 直接跑）。
//
// 这里钉住「宁可找不到，也不能误播另一首同名歌」这条底线：
// 歌名必须过阈值；两边都有歌手时歌手必须沾边；版本后缀可以放宽。
import { baseSongTitle, normSongText, songMatchScore } from "../src/lib/song-match.ts";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);

    return;
  }

  failed++;
  console.log(`  ❌ ${label}`);
}

console.log("\n=== 归一化 ===");

check("全半角/空白/标点归一", normSongText("大石碎胸口 (Live)") === "大石碎胸口live");

check("版本括号可剥离", baseSongTitle("大石碎胸口 (Live)") === "大石碎胸口");

check("多层版本括号可连续剥离", baseSongTitle("大石碎胸口 (Live) [Remastered]") === "大石碎胸口");

console.log("\n=== 同曲判定 ===");

const want = { title: "大石碎胸口", artists: ["万能青年旅店"] };

check("同名同歌手可接", songMatchScore(want, { title: "大石碎胸口", artist: "万能青年旅店" }) >= 4);

check("同名带版本后缀可接", songMatchScore(want, { title: "大石碎胸口 (Live)", artist: "万能青年旅店" }) >= 4);

check("合唱名单包含目标歌手可接",
  songMatchScore(want, { title: "大石碎胸口", artist: "万能青年旅店 / 二手玫瑰" }) >= 4);

check("同名不同歌手必须拒绝",
  songMatchScore(want, { title: "大石碎胸口", artist: "别的乐队" }) === 0);

check("歌名不沾必须拒绝",
  songMatchScore(want, { title: "完全不同的歌", artist: "万能青年旅店" }) === 0);

check("短歌名不能靠包含误命中",
  songMatchScore({ title: "海" }, { title: "上海滩", artist: "叶丽仪" }) === 0);

check("文件名带编码后缀仍可匹配",
  songMatchScore(want, { title: "大石碎胸口 (Live) [aq].ogg", artist: "万能青年旅店" }) >= 4);

console.log("\n=== 接线 ===");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

check("package.json 有独立入口", String(pkg.scripts?.["verify:song-match"] ?? "").includes("verify-song-match.ts"));

check("verify:static 收录 song-match", String(pkg.scripts?.["verify:static"] ?? "").includes("verify-song-match.ts"));

console.log(`\n${failed ? "❌" : "✅"} song-match: ${passed} pass, ${failed} fail`);

if (failed) process.exit(1);
