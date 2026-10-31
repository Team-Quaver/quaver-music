// Quaver — Liino 后端接入的静态自检：读源码做正则断言（与 verify-mpv.ts 同一形态）。
//
// 它守的是「契约仍在」：
//   • main.ts 走 bootAudioEngine（二选一 init，Liino dlopen 失败必须回落 mpv）
//   • ipcMain.handle("quaver:audio") 全进程只许两处注册且互斥（mpv 引擎 / Liino 引擎）
//   • Liino 禁用 waitEvent（FFI 阻塞 = 冻窗）
//   • 渲染层按 backend 识别 liino，EQ/fake-audio 用 engineBacked 单一判断
//   • 打包把 libliino 带上（extraResources + asarUnpack）
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const UI = join(dirname(fileURLToPath(import.meta.url)), "..");

let fails = 0;

const ok = (name: string, cond: boolean, note = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${note ? " — " + note : ""}`);

  if (!cond) fails++;
};

const src = (p: string) => readFileSync(join(UI, p), "utf8");

// —— 主进程接入 ——

const main = src("electron/main.ts");
const backend = src("electron/audio/backend.ts");
const engine = src("electron/audio/liino-engine.ts");
const runtime = src("electron/audio/liino-runtime.ts");

ok("main.ts 从 backend.ts 引擎门面接入", /import \{ audioExternalPids, bootAudioEngine, shutdownAudioEngine \} from "\.\/audio\/backend\.ts"/.test(main));

ok("main.ts 不再直接 init 引擎", !/audioEngine\.init\(/.test(main));

ok("音频收尾走 shutdownAudioEngine（两处：信号 + will-quit）",
  (main.match(/shutdownAudioEngine\(\)/g) ?? []).length >= 2, `${(main.match(/shutdownAudioEngine\(\)/g) ?? []).length} 处`);

ok("外部进程账走 audioExternalPids", /audioExternalPids\(\)/.test(main));

ok("backend.ts：QUAVER_AUDIO_BACKEND 或启动快照=Liino 才进 Liino", /selectedBackend\(process\.env\.QUAVER_AUDIO_BACKEND \?\? boot\.backendPreference\)/.test(backend));

ok("backend.ts：dlopen 失败回落 mpv", /Liino 后端不可用，回落 mpv/.test(backend));

ok("backend.ts：init 前先 probe（ipcMain.handle 先到先得）", /await liinoEngine\.probe\(\)/.test(backend) && /liinoEngine\.init\(boot\)/.test(backend));

ok("Liino 引擎对齐 IPC 契约（quaver:audio）", /ipcMain\.handle\("quaver:audio"/.test(engine));

ok("Liino 引擎广播同一事件通道（quaver:audio-event）", /wc\.send\("quaver:audio-event"/.test(engine));

ok("Liino 引擎禁用 waitEvent（FFI 阻塞 = 冻窗）",
  !/\.waitEvent\(/.test(engine));

ok("库解析认 QUAVER_LIINO 排障口", /QUAVER_LIINO/.test(runtime));

ok("开发态回落 vendor/Liino/build", /vendorBuildRoot/.test(engine) && /vendor\/Liino\/build/.test(engine));

// —— 渲染层识别 ——

const player = src("src/player.ts");
const transport = src("src/lib/transport.ts");

ok("player 识别 status.backend=liino", /st\.backend === "liino" \? "liino" : "mpv"/.test(player));

ok("ActiveBackend 含 liino 档", /export type ActiveBackend = "mpv" \| "mpv-compat" \| "liino" \| "web"/.test(player));

ok("PCM 兼容模式独占 mpv（Liino 无管道）", /this\.engineKind === "liino" \|\| pref !== "MPVCompat".*return "native"/.test(player.replace(/\n/g, " ")));

ok("engine transport 是唯一桥（Liino 复用同一命令面）", /const t = await createEngineTransport\(/.test(player) && /export type EngineBridge/.test(transport));

const eq = src("src/components/EqualizerDialog.ts");
const fake = src("src/fake-audio.ts");

ok("EQ 用 engineBacked 单一判断（mpv/兼容/Liino 都算原生）", /const isEngine = \(\) => player\.engineBacked/.test(eq));

ok("假音频镜像对 Liino 同样生效", /player\.engineBacked && !!player\.current/.test(fake));

const settings = src("src/views/settings.ts");

ok("设置页有 Liino 引擎行", /Liino 原生直出运行中/.test(settings));
ok("设置页有 Liino 实验性原生模式选项", /decodeRow\("Liino", "Liino（实验性原生模式）"\)/.test(settings));

ok("设置页说清 Liino 的边界（无 PCM 兼容模式）", /无 PCM 兼容模式，窗口级音频捕获请改回 MPV/.test(settings));

// —— 打包 ——

const builder = src("../packages/electron-builder-base.yml");

ok("打包带上随包 libliino", /from:\s*build-res\/liino/.test(builder) && /to:\s*liino/.test(builder));

ok("libliino 解包出 asar（FFI 不能进asar 虚拟路径）", /asarUnpack/.test(builder) && /liino/.test(builder));

const ag = src("AGENTS.md");

ok("AGENTS.md 记录了后端开关与验证入口", /QUAVER_AUDIO_BACKEND=liino/.test(ag) && /probe-liino/.test(ag));

const prefs = src("src/lib/prefs.ts");

ok("播放偏好含 Liino 档", /export type DecodeBackend = "MPV" \| "MPVCompat" \| "Liino" \| "Blink"/.test(prefs));

ok("Liino 不可用时明确回落提示", /Liino 后端不可用，已回落 MPV/.test(src("src/player.ts")) && /Liino 后端不可用，已回落 MPV/.test(src("AGENTS.md")));

console.log(fails ? `\n${fails} 项失败` : "\nverify-liino: 全部通过");

process.exit(fails ? 1 : 0);
