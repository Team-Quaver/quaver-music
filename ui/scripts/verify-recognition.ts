// Quaver — 听歌识曲：AFP 资产、主进程指纹、中继接线与结果归一化的护栏。
// 跑：node scripts/verify-recognition.ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fingerprintPcm, isAfpAvailable } from "../electron/recognition-fingerprint.ts";
import { normalizeMatchResults, resolveQQMatches } from "../electron/recognition-match.ts";
import { recognitionSong } from "../src/lib/recognition-candidate.ts";

const UI = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(UI, p), "utf8");
const exists = (p: string) => existsSync(join(UI, p));

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n=== AFP 资产 ===");

for (const file of ["resources/afp/afp.mjs", "resources/afp/afp.wasm.mjs"]) {
  check(`${file} 随包存在`, exists(file) && statSync(join(UI, file)).size > 0);
}

check("主进程能定位 AFP", isAfpAvailable());

const rate = 8000;
const pcm = new Float32Array(rate * 3);

for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(2 * Math.PI * 440 * i / rate) * 0.3;

const fingerprint = await fingerprintPcm(pcm);

check("3 秒 PCM 能算出指纹", !!fingerprint && fingerprint.length > 100, String(fingerprint?.length ?? 0));

check("空样本不产出指纹", (await fingerprintPcm(new Float32Array(0))) === null);

console.log("\n=== 中继 ===");

const relay = read("src/relay.ts");
const native = read("electron/native-server.ts");

for (const [name, src] of [["dev/preview", relay], ["打包态", native]] as const) {
  check(`${name}有指纹端点`, /recognition\/fingerprint/.test(src) && src.includes("fingerprintPcm(pcm)"));
  check(`${name}匹配结果走统一归一化`, src.includes("normalizeMatchResults(await matchFingerprint"));
  check(`${name}给候选补 QQ songmid`, src.includes("resolveQQMatches(matched.slice(0, 3))"));
  check(`${name}无结果不再回 502`, /data\.result\.length \? "ok" : "没有识别到结果"/.test(src));
  check(`${name}限制 PCM 请求体积`, src.includes("2 * 1024 * 1024"));
}

check("渲染层不再自己 import AFP WASM", !/afp\.mjs|GenerateFP/.test(read("src/lib/song-recognition.ts")));

check("渲染层把 PCM POST 给主进程", /\/api\/recognition\/fingerprint/.test(read("src/lib/song-recognition.ts")));

check("采集后会重采样到 8 kHz", /resampleTo8k\(captured\.pcm, captured\.sampleRate\)/.test(read("src/lib/song-recognition.ts")));

check("AudioWorklet 先 addModule 再建节点", /addModule\(blobUrl\)[\s\S]{0,180}new AudioWorkletNode/.test(read("src/lib/song-recognition.ts")));

check("系统声音有主进程中继端点", /recognition\/system-pcm/.test(relay) && /recognition\/system-pcm/.test(native));

check("Linux 系统声音走 monitor source", /parec/.test(read("electron/recognition-capture.ts"))
  && /pw-record/.test(read("electron/recognition-capture.ts")));

check("Windows display-capture 提供 loopback 音频", /setDisplayMediaRequestHandler/.test(read("electron/main.ts"))
  && /audio: "loopback"/.test(read("electron/main.ts")));

check("弹窗提供系统声音/麦克风选项", /data-source="system"/.test(read("src/components/SongRecognitionDialog.ts"))
  && /data-source="microphone"/.test(read("src/components/SongRecognitionDialog.ts")));

check("候选按钮用索引绑定，避免 NUL 打断 data 属性", /data-rec="\$\{index\}"/.test(read("src/components/SongRecognitionDialog.ts"))
  && /candidates\[Number\(button\.dataset\.rec/.test(read("src/components/SongRecognitionDialog.ts")));

check("识曲弹窗复用更新/Credits 外壳", /className = "upd-overlay"/.test(read("src/components/SongRecognitionDialog.ts"))
  && /class="upd-dialog rec-panel"/.test(read("src/components/SongRecognitionDialog.ts")));

check("识曲动画柱底部对齐", /transform-origin: 50% 100%/.test(read("src/style.css")));

check("匹配走网易云官方 AFP 接口", /NETEASE_MATCH_URL/.test(read("electron/recognition-match.ts"))
  && /algorithmCode", "shazam_v2/.test(read("electron/recognition-match.ts")));

check("识别结果回查 QQ 曲库补 songmid", /resolveQQMatches/.test(read("electron/recognition-match.ts"))
  && /\/search\?keyword=/.test(read("electron/recognition-match.ts")));

check("QQ AISEE 已移除", !/fcg_aisee_entry|AISEE_UID|AISEE_UDID/.test(read("electron/recognition-match.ts")));

check("识曲期间暂停自身播放", /player\.pause\(\)/.test(read("src/components/SongRecognitionDialog.ts"))
  && /player\.resume\(\)/.test(read("src/components/SongRecognitionDialog.ts")));

console.log("\n=== 结果归一化 ===");

const qq = normalizeMatchResults({
  code: 200,
  data: {
    result: [{
      song: { id: 123, name: "歌", artists: [{ name: "人" }], album: { name: "碟", picUrl: "p" } },
      startTime: 12_000,
      score: 100,
    }],
  },
});

check("网易云结果保留 songID", qq[0]?.song.id === 123);

check("开始时间统一成秒", qq[0]?.startTime === 12);

check("封面/专辑字段保留", qq[0]?.song.album.name === "碟" && qq[0]?.song.album.picUrl === "p");

check("候选补 mid 的函数可调用", (await resolveQQMatches([])).length === 0);

const mapped = recognitionSong({
  id: "123",
  mid: "003abc",
  title: "歌",
  artists: ["人", "另一位"],
  album: "碟",
}, 0);

check("扁平候选直接映射成播放器 Song", mapped.song.name === "歌" && mapped.song.mid === "003abc");

check("候选 key 不含 NUL（否则 data 属性会被 HTML 解析器截断）", !mapped.key.includes("\u0000"));

check("多歌手不丢字段", mapped.song.singer?.map((a) => a.name).join("/") === "人/另一位");

check("搜索关键词由标题与歌手拼成", mapped.keyword === "歌 人 另一位");

check("弹窗消费扁平候选而非 raw.song", !/raw\?\.song/.test(read("src/components/SongRecognitionDialog.ts"))
  && /recognitionSong\(candidate, index\)/.test(read("src/components/SongRecognitionDialog.ts")));

console.log("\n=== 打包 ===");

check("electron-builder 带 AFP extraResources", /from: resources\/afp[\s\S]{0,80}to: afp/.test(read("../packages/electron-builder-base.yml")));

console.log(`\n${fail === 0 ? "✅" : "❌"} recognition: ${pass} pass, ${fail} fail`);

process.exit(fail === 0 ? 0 : 1);
