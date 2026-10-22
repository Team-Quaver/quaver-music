// Quaver — 随包 audio 运行时（mpv）的版本钉 + 门槛判据 + 接线：单测与源码护栏。
// 跑：  node scripts/verify-mpv.ts
//
// 背景：这一块最贵的回归是「随包 mpv 在某一类机器上一启动就死」，而它在本机与 CI 都验不出来 ——
// CI 是 macOS 15 runner，v0.41 的 macos-15 那份在那儿跑得好好的，macOS 14 的用户却直接 SIGABRT
// （dyld: built for macOS 15.0 which is newer than running OS）。所以抓三头：
//   • 判据本身：macho.ts 用合成镜像单测（mos 编码/优先级/fat/垃圾输入）
//   • 版本钉：mpv-assets.ts —— mac 那份不能比地板高（数字就是载荷的最低系统版本）
//   • 接线：暂存脚本必须真按地板卡、运行期必须真自检并回落（源码护栏，跟 verify-icon 同款路子）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:process";
import { runInNewContext } from "node:vm";
import {
  formatOsVersion, machOMinOs, osVersionGt, parseOsVersion,
} from "../electron/audio/macho.ts";
import { probeRuntime, resolveBundled } from "../electron/audio/bins.ts";
import { ASSETS, MACOS_FLOOR, MPV_VERSION, macosAssetMajor } from "./mpv-assets.ts";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);

function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const UI = join(import.meta.dirname, "..");
const pack = (major, minor = 0, patch = 0) => ((major & 0xffff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);

/** 合成一个 thin Mach-O：只放我们要的 load command（足够喂解析器，不需要真能跑） */
function fakeMacho(commands, { magic = 0xfeedfacf, is64 = true } = {}) {
  const head = Buffer.alloc(is64 ? 32 : 28);
  head.writeUInt32LE(magic, 0);
  head.writeUInt32LE(0x0100000c, 4);              // CPU_TYPE_ARM64
  head.writeUInt32LE(0, 8);
  head.writeUInt32LE(2, 12);                      // MH_EXECUTE
  head.writeUInt32LE(commands.length, 16);
  head.writeUInt32LE(commands.reduce((n, c) => n + c.length, 0), 20);

  return Buffer.concat([head, ...commands]);
}

/** LC_BUILD_VERSION（cmd 0x32）：minos 在偏移 12 */
function lcBuild(minos) {
  const b = Buffer.alloc(24);
  b.writeUInt32LE(0x32, 0); b.writeUInt32LE(24, 4);
  b.writeUInt32LE(1, 8);            // platform = macOS
  b.writeUInt32LE(minos, 12);
  b.writeUInt32LE(pack(15), 16);

  return b;
}

/** LC_VERSION_MIN_MACOSX（cmd 0x24）：version 在偏移 8 */
function lcVersionMin(version) {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x24, 0); b.writeUInt32LE(16, 4);
  b.writeUInt32LE(version, 8); b.writeUInt32LE(pack(15), 12);

  return b;
}

/** 合成一个 fat 二进制：头 + 一个 arch 描述，切片放在 offset 处 */
function fakeFat(thin, offset = 4096) {
  const head = Buffer.alloc(4096);
  head.writeUInt32BE(0xcafebabe, 0); // FAT_MAGIC（大端）
  head.writeUInt32BE(1, 4);          // nfat_arch
  head.writeUInt32BE(0x0100000c, 8); // cputype
  head.writeUInt32BE(0, 12);
  head.writeUInt32BE(offset, 16);
  head.writeUInt32BE(thin.length, 20);
  head.writeUInt32BE(14, 24);

  return Buffer.concat([head, thin]);
}

// ——— Mach-O 最低系统版本解析 ———
section("macho.ts：门槛判据");

eq("LC_BUILD_VERSION 的 minos（major/minor/patch 拆分）", machOMinOs(fakeMacho([lcBuild(pack(15, 0, 0))])), { major: 15, minor: 0, patch: 0 });

eq("小版本号也拆得对", machOMinOs(fakeMacho([lcBuild(pack(14, 5, 0))])), { major: 14, minor: 5, patch: 0 });

eq("只有 LC_VERSION_MIN_MACOSX 时回落它", machOMinOs(fakeMacho([lcVersionMin(pack(11, 2, 0))])), { major: 11, minor: 2, patch: 0 });

eq("两条都在时 BUILD_VERSION 优先（新链接器口径）",
  machOMinOs(fakeMacho([lcVersionMin(pack(11, 2, 0)), lcBuild(pack(15, 0, 0))])), { major: 15, minor: 0, patch: 0 });

eq("两条都在、顺序反过来同样优先 BUILD_VERSION",
  machOMinOs(fakeMacho([lcBuild(pack(15, 0, 0)), lcVersionMin(pack(11, 2, 0))])), { major: 15, minor: 0, patch: 0 });

eq("fat（universal）取第一个架构切片", machOMinOs(fakeFat(fakeMacho([lcBuild(pack(14, 0, 0))]))), { major: 14, minor: 0, patch: 0 });

eq("没有门槛类 load command → null", machOMinOs(fakeMacho([])), null);

eq("不是 Mach-O（PNG 头）→ null", machOMinOs(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")), null);

eq("全是 0 的垃圾 → null", machOMinOs(Buffer.alloc(64)), null);

eq("32 位头也认（MH_MAGIC）", machOMinOs(fakeMacho([lcBuild(pack(12, 0, 0))], { magic: 0xfeedface, is64: false })), { major: 12, minor: 0, patch: 0 });

eq("长度不够 → null（不许抛）", machOMinOs(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), null);

eq("路径不存在 → null（不许抛）", machOMinOs(join(UI, "build-res", "audio", "__nope__")), null);

eq("formatOsVersion 补足三段", formatOsVersion({ major: 14, minor: 0, patch: 0 }), "14.0.0");

eq("formatOsVersion 对 null 返回空串", formatOsVersion(null), "");

eq("parseOsVersion \"14.5.2\"", parseOsVersion("14.5.2"), { major: 14, minor: 5, patch: 2 });

eq("parseOsVersion \"14.5\" 补 0", parseOsVersion("14.5"), { major: 14, minor: 5, patch: 0 });

eq("parseOsVersion 认不出的返回 null", parseOsVersion("Sonoma"), null);

check("osVersionGt：15.0.0 > 14.0.0", osVersionGt({ major: 15, minor: 0, patch: 0 }, { major: 14, minor: 5, patch: 3 }) === true);

check("osVersionGt：14.0.0 不大于 14.0.0", osVersionGt({ major: 14, minor: 0, patch: 0 }, { major: 14, minor: 0, patch: 0 }) === false);

check("osVersionGt：任一侧 null 时判不出来（不乱报警）",
  osVersionGt({ major: 15, minor: 0, patch: 0 }, null) === false && osVersionGt(null, { major: 14, minor: 0, patch: 0 }) === false);

// ——— 版本钉：mac 那份不能比地板高 ———
section("mpv-assets.ts：版本钉");

check("三个平台的资产都在（CI 就 stage 这三份）",
  ["win32/x64", "win32/arm64", "darwin/arm64"].every((k) => ASSETS[k]),
  `实有 ${Object.keys(ASSETS).join(" ")}`);

for (const [key, a] of Object.entries(ASSETS)) {
  check(`${key}：url 指向上游 v${MPV_VERSION} 的 release 资产`,
    a.url.startsWith(`https://github.com/mpv-player/mpv/releases/download/v${MPV_VERSION}/mpv-v${MPV_VERSION}-`), a.url);
  check(`${key}：sha256 是 64 位小写 hex（digest 抄错就是「下载校验失败」）`,
    /^[0-9a-f]{64}$/.test(a.sha256 ?? ""), String(a.sha256));
}

const macMajor = macosAssetMajor(ASSETS["darwin/arm64"].url);

eq("darwin 资产能抠出 macos 档位号", macMajor, 14);

check("darwin 资产档位 ≤ 本项目地板（装高了低版本系统一启动就 SIGABRT）",
  macMajor !== null && macMajor <= MACOS_FLOOR.major,
  `资产 macOS ${macMajor} > 地板 ${MACOS_FLOOR.major}`);

eq("macosAssetMajor 对非 mac 资产返回 null", macosAssetMajor(ASSETS["win32/x64"].url), null);

// ——— 接线：暂存脚本与运行期 ———
section("源码护栏：构建期卡门槛 + 运行期自检");

const stageSrc = readFileSync(join(UI, "scripts", "stage-mpv-official.ts"), "utf8");

check("暂存脚本从 mpv-assets.ts 取资产表（版本钉只有一份真相）",
  /from "\.\/mpv-assets\.ts"/.test(stageSrc) && !/^const ASSETS = /m.test(stageSrc));

check("darwin 分支落盘后按地板校验最低系统版本", /assertMacOSFloor\(\s*join\(dest/.test(stageSrc));

check("校验高于地板就 die（不是只打日志）", /osVersionGt\(min, MACOS_FLOOR\)[\s\S]{0,120}die\(/.test(stageSrc));

const engineSrc = readFileSync(join(UI, "electron", "audio", "engine.ts"), "utf8");

check("引擎导入 probeRuntime 做开机自检", /import \{[^}]*probeRuntime[^}]*\} from "\.\/bins\.ts"/.test(engineSrc));

check("自检结果只算一次（bundledProbe 缓存）", /this\.bundledProbe === undefined/.test(engineSrc));

check("自检失败回落宿主 mpv（bundledRoot: null）",
  /this\.bin = resolveMpv\(\{ bundledRoot: null \}\)/.test(engineSrc));

check("失败原因进日志（含 macOS 门槛 vs 本机的对照）",
  /osVersionGt\(min, running\)/.test(engineSrc) && /this\.binNote =/.test(engineSrc));

check("找不运行时把随包失败原因一并说清（别只说「未找到 mpv」）",
  /未找到 mpv 可执行文件[\s\S]{0,80}this\.binNote/.test(engineSrc));

const ipcSrc = readFileSync(join(UI, "electron", "audio", "mpv-ipc.ts"), "utf8");
const pipeSrc = readFileSync(join(UI, "electron", "audio", "pcm-pipe.ts"), "utf8");
const sinkSrc = readFileSync(join(UI, "src", "lib", "pcm-sink.ts"), "utf8");
const transportSrc = readFileSync(join(UI, "src", "lib", "transport.ts"), "utf8");
const playerSrc = readFileSync(join(UI, "src", "player.ts"), "utf8");

check("原生兼容接入 mpv --ao=pcm（不走 mpv 自己的音频设备）",
  /--ao=pcm/.test(ipcSrc) && /--ao-pcm-file=/.test(ipcSrc) && /--audio-format=float/.test(ipcSrc));

check("PCM 固定 48k/stereo，与 renderer sink 的 48k/2ch 口径一致",
  /--audio-samplerate=48000/.test(ipcSrc) && /--audio-channels=stereo/.test(ipcSrc) && /PCM_RATE = 48000/.test(sinkSrc));

check("管道默认暂停，由 renderer pcm-ready 恢复（背压而不是整首预解码）",
  /private paused = true/.test(pipeSrc) && /case "pcm-ready"/.test(engineSrc) && /pcmPipe\?\.resume/.test(engineSrc));

check("pcm EOF 等 renderer 队列播完再发 ended", /pcm-eof/.test(engineSrc) && /markEof/.test(sinkSrc) && /availableFrames === 0/.test(sinkSrc));

check("pcm-progress 回推 state（不能只信 mpv 不动的 time-pos）",
  /case "pcm-progress"[\s\S]{0,700}pushState\(true\)/.test(engineSrc) && /pcm-ended/.test(engineSrc));

check("pcm 硬预读窗口防止 mpv 先写完整首进 idle", /PCM_MAX_AHEAD_SEC/.test(engineSrc) && /drainPcm\(/.test(engineSrc));

check("pcm 音量走 renderer GainNode（不让 mpv 预写缓冲区造成半拍延迟）",
  /pcm-gain/.test(engineSrc) && /setGain\(/.test(sinkSrc) && /this\.pcm\?\.setGain/.test(transportSrc));

check("pcm EQ 走 renderer BiquadFilter（不让 mpv af 慢一个预写缓冲）",
  /pcm-eq/.test(engineSrc) && /setEq\(/.test(sinkSrc) && /rebuildFilters/.test(sinkSrc));

check("pcm seek 重拉 MPV + 管道，丢弃 FIFO 旧帧", /restartPcmAt/.test(engineSrc) && /loadfile[\s\S]{0,100}start=/.test(engineSrc));

check("pcm 换歌/换音质也重开 MPV，避免上一首 FIFO 尾巴混入",
  /mode === "pcm" && this\.lastUrl[\s\S]{0,160}this\.stopMpv\(\)/.test(engineSrc));

check("pcm 块 50ms，降低 AudioBuffer/IPC 调度频率", /PCM_RATE \/ 20/.test(engineSrc));

check("pcm renderer 使用单个 AudioWorklet ring buffer（不再按块建 source node）",
  /AudioWorkletNode/.test(sinkSrc) && /quaver-pcm/.test(readFileSync(join(UI, "public", "pcm-worklet.js"), "utf8")));

check("兼容模式暂停不 suspend AudioContext（避免 WASAPI 重激活卡顿）",
  !/ctx\??\.suspend\(/.test(sinkSrc) && /type: "pause"/.test(sinkSrc) && /type: "resume"/.test(sinkSrc));

// 真跑一遍 worklet 内核：暂停必须输出静音但冻结消费，恢复从原帧继续。
{
  let WorkletProcessor: any;
  const status = [];

  class FakeAudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (msg) => status.push(msg),
      };
    }
  }

  runInNewContext(readFileSync(join(UI, "public", "pcm-worklet.js"), "utf8"), {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (_name, cls) => { WorkletProcessor = cls; },
    Float32Array,
    Math,
  });

  const proc = new WorkletProcessor();
  const pcm = new Float32Array(512 * 2).fill(0.25);

  const render = () => {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    proc.process([], [[left, right]]);

    return { left, right };
  };

  proc.port.onmessage({ data: { type: "pcm", data: pcm.buffer } });
  const first = render();
  const beforePause = { played: proc.playedFrames, available: proc.availableFrames };
  proc.port.onmessage({ data: { type: "pause" } });
  const paused = render();
  const afterPause = { played: proc.playedFrames, available: proc.availableFrames };
  proc.port.onmessage({ data: { type: "resume" } });
  const resumed = render();

  check("worklet 暂停输出静音且不消费环形队列",
    first.left[0] === 0.25 && paused.left[0] === 0 && paused.right[0] === 0
      && afterPause.available === beforePause.available && afterPause.played === beforePause.played);
  check("worklet 恢复从暂停前的下一帧继续",
    resumed.left[0] === 0.25 && proc.availableFrames === beforePause.available - 128 && proc.playedFrames === beforePause.played + 128);
}

check("PCM 数据/EOF 按 epoch 丢弃旧会话尾巴",
  /case "pcm"[\s\S]{0,100}Number\(ev\.epoch\) !== this\.pcmEpoch/.test(transportSrc)
    && /case "pcm-eof"[\s\S]{0,100}Number\(ev\.epoch\) !== this\.pcmEpoch/.test(transportSrc));

check("窗口重建/后端热切时 renderer 接上主进程 PCM epoch",
  /const epoch = Number\(r\?\.epoch\)/.test(transportSrc) && /epoch: this\.pcmEpoch/.test(engineSrc));

check("切歌创建新 sink，旧 sink 独立淡出后再销毁（跨曲交叉）",
  /retirePcm\(old\)/.test(transportSrc) && /fadingPcms/.test(transportSrc)
    && /sink\.fadeOut\(ms\)/.test(transportSrc) && /Math\.max\(fade\.inMs, fade\.outMs\)/.test(transportSrc));

check("淡出后的旧 sink 关闭 AudioContext，不堆积音频会话",
  /setTimeout\(\(\) => \{[\s\S]{0,80}sink\.destroy\(\)/.test(transportSrc)
    && /for \(const \[sink, timer\] of this\.fadingPcms\)[\s\S]{0,120}sink\.destroy\(\)/.test(transportSrc));

check("PCM EOF 先发 ending，让下一首在尾音排空前起播",
  /onEnding\?:/.test(sinkSrc) && /type: "ending"/.test(transportSrc) && /case "ending"/.test(playerSrc));

check("PCM 切歌不在取链前停旧曲（由 load 做交叉淡化）",
  /this\.interrupt\(!\(this\.transport\.kind === "engine" && this\.transport\.mode === "pcm"\)\)/.test(playerSrc)
    && /private interrupt\(stopOutput = true\)/.test(playerSrc) && /if \(stopOutput\)/.test(playerSrc));

check("PCM 起播后预取下一首，EOF 交叉淡化不等取链 RTT",
  /prefetchNextForCrossfade\(\)/.test(playerSrc)
    && /this\.transport\.mode !== "pcm"[\s\S]{0,400}prefetchSong\(this\.queue\[i\]\)/.test(playerSrc));

check("并发 load 用 epoch 防旧请求反杀新会话",
  /if \(epoch < this\.pcmEpoch\) return \{ ok: true, stale: true \}/.test(engineSrc)
    && /await mpv\.setProp\("pause", paused\);[\s\S]{0,80}epoch !== this\.pcmEpoch/.test(engineSrc));

const doPauseSrc = engineSrc.slice(engineSrc.indexOf("doPause()"), engineSrc.indexOf("findBin()"));
const pcmPauseStart = doPauseSrc.indexOf('this.mode === "pcm"');
const pcmPauseSrc = doPauseSrc.slice(pcmPauseStart, doPauseSrc.indexOf("return;", pcmPauseStart));

check("PCM 暂停只停读管道，不向 mpv 发 pause（避免 AO 线程阻塞）",
  /pcmPipe\?\.pause\(\)/.test(pcmPauseSrc) && !/setProp\("pause"/.test(pcmPauseSrc));

check("PCM 恢复先查 mpv pause，只在挂流暂停时解除（不会永远不出声）",
  /const mpvPaused = await mpv\.getProp\("pause"\)/.test(engineSrc)
    && /if \(mpvPaused\) await mpv\.setProp\("pause", false\)/.test(engineSrc));

check("pcm stop 等淡出结束再销毁 sink（load 可取消旧 stop timer）",
  /pcmStopTimer/.test(transportSrc) && /fadeOutMs \+ 40/.test(transportSrc) && /this\.pcmStopTimer = null/.test(transportSrc));

const binsSrc = readFileSync(join(UI, "electron", "audio", "bins.ts"), "utf8");

check("bins.ts 导出 probeRuntime（CI --check 与运行期共用同一判据）",
  /export function probeRuntime\(/.test(binsSrc) && /const probe = probeRuntime\(found\)/.test(binsSrc));

check("probeRuntime 认「被信号带走」为失败（dyld abort 就是这种）", /!r\.signal/.test(binsSrc));

// ——— 有随包运行时的话，真跑一次（本机没 stage 就跳过） ———
section("随包运行时实跑（可选）");

const root = join(UI, "build-res", "audio");
const found = resolveBundled(root);

if (!found) {
  console.log("  ⏭  本机没有 stage 随包运行时（build-res/audio 空）—— 跳过；CI 与装机后各跑一次");
} else {
  const probe = probeRuntime(found, 30000);
  check(`随包 mpv 真跑得起来（${found.payload}）`, probe.ok, `exit=${probe.status} signal=${probe.signal}\n${probe.output.slice(0, 300)}`);

  if (platform === "darwin") {
    const min = machOMinOs(found.payload);
    check("随包 mpv 声明的最低系统版本不高于地板",
      min !== null && !osVersionGt(min, MACOS_FLOOR),
      `载荷 macOS ${formatOsVersion(min)} > 地板 ${formatOsVersion(MACOS_FLOOR)}`);
    check("本机系统版本够跑这份随包运行时",
      !osVersionGt(min, parseOsVersion(process.getSystemVersion?.() ?? "")),
      `本机 ${process.getSystemVersion?.()} < 载荷要求的 ${formatOsVersion(min)}`);
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-mpv: ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);
