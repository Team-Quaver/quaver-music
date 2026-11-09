// Quaver — Liino 后端接入的静态自检：读源码做正则断言（与 verify-mpv.ts 同一形态）。
//
// 它守的是「契约仍在」：
//   • main.ts 走 bootAudioEngine（二选一 init，Liino dlopen 失败必须回落 mpv）
//   • ipcMain.handle("quaver:audio") 全进程只注册一次（backend.ts 门面），引擎只实现命令；
//     运行时切换经门面的 { cmd: "backend" } 拆旧建新，两个引擎自己不许抢注册
//   • Liino 禁用 waitEvent（FFI 阻塞 = 冻窗）
//   • 渲染层按 backend 识别 liino，EQ/fake-audio 用 engineBacked 单一判断
//   • 打包把 libliino 带上（extraResources + asarUnpack）
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFormatHint } from "../electron/audio/liino-runtime.ts";

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

ok("main.ts 从 backend.ts 引擎门面接入",
  /import \{[^}]*\bbootAudioEngine\b[^}]*\} from "\.\/audio\/backend\.ts"/.test(main)
    && /import \{[^}]*\bshutdownAudioEngine\b[^}]*\} from "\.\/audio\/backend\.ts"/.test(main));

ok("main.ts 不再直接 init 引擎", !/audioEngine\.init\(/.test(main));

ok("音频收尾走 shutdownAudioEngine（两处：信号 + will-quit）",
  (main.match(/shutdownAudioEngine\(\)/g) ?? []).length >= 2, `${(main.match(/shutdownAudioEngine\(\)/g) ?? []).length} 处`);

ok("外部进程账走 audioExternalPids", /audioExternalPids\(\)/.test(main));

ok("backend.ts：QUAVER_AUDIO_BACKEND 或启动快照=Liino 才进 Liino", /selectedBackend\(process\.env\.QUAVER_AUDIO_BACKEND \?\? boot\.backendPreference\)/.test(backend));

ok("backend.ts：dlopen 失败回落 mpv", /Liino 后端不可用，回落 mpv/.test(backend));

ok("backend.ts：init 前先 probe（dlopen 成功才算选中 Liino）", /await liinoEngine\.probe\(\)/.test(backend) && /liinoEngine\.init\(boot\)/.test(backend));

ok("quaver:audio 只有一个主人（backend.ts 门面注册）",
  /ipcMain\.handle\("quaver:audio"/.test(backend) && !/ipcMain\.handle\("quaver:audio"/.test(engine) && !/ipcMain\.handle\("quaver:audio"/.test(src("electron/audio/engine.ts")));

ok("backend.ts 按 backend 命令运行时换引擎", /cmd\.cmd === "backend"/.test(backend) && /switchAudioBackend\(/.test(backend));

ok("运行时切换以用户选择为准（env 只顶启动）",
  /active = await bootOne\(want, \{ \.\.\.boot, backendPreference: preference \}\)/.test(backend));

ok("Liino 引擎对齐 IPC 契约（命令面 onInvoke）", /async onInvoke\(cmd: CommandEnvelope\)/.test(engine));

ok("Liino 引擎广播同一事件通道（quaver:audio-event）", /wc\.send\("quaver:audio-event"/.test(engine));

ok("Liino 引擎禁用 waitEvent（FFI 阻塞 = 冻窗）",
  !/\.waitEvent\(/.test(engine));

ok("Liino 世代读 snapshot 的 gen（native JSON 字段名不是 generation）",
  /gen\?: number/.test(engine) && /snap\?\.gen \?\? snap\?\.generation/.test(engine));

ok("迟到的旧 stop 不能拆掉新流（native StopIf 按 track 世代守卫）",
  /func \(p \*Player\) StopIf\(gen uint64\) error/.test(src("../vendor/Liino/liino.go"))
    && /h\.player\.TrackGeneration\(\)/.test(src("../vendor/Liino/capi/capi.go"))
    && /h\.player\.StopIf\(gen\)/.test(src("../vendor/Liino/capi/capi.go")));

ok("淡出/阻塞期间的新 load 不能被旧 stop 重置（hardStopIf 二次校验）",
  /func \(p \*Player\) hardStopIf\(trackGen uint64\)/.test(src("../vendor/Liino/liino.go"))
    && /p\.pending = func\(\) \{ p\.hardStopIf\(gen\) \}/.test(src("../vendor/Liino/liino.go")));

ok("native 异步事件按产生它的世代发布（旧 loaded/ended 不冒充新流）",
  /func \(p \*Player\) publishFrom\(gen uint64, ev Event\) bool/.test(src("../vendor/Liino/liino.go"))
    && /p\.publishFrom\(gen, Event\{Kind: KindLoaded/.test(src("../vendor/Liino/pipeline.go"))
    && /p\.publishFrom\(gen, Event\{Kind: KindEnded/.test(src("../vendor/Liino/pipeline.go")));

ok("Liino 意外 closed 立刻报错，不留在 buffering 干等看门狗",
  /case "closed":/.test(engine) && /wasLive/.test(engine) && /Liino 音频流意外停止/.test(engine));

ok("Liino 事件轮询异常会被接住并重建会话（不把主进程带崩）",
  /nextEvent\(\)/.test(engine) && /Liino 事件轮询失败/.test(engine) && /this\.stopPolling\(\)/.test(engine));

ok("库解析认 QUAVER_LIINO 排障口", /QUAVER_LIINO/.test(runtime));

ok("开发态回落 vendor/Liino/build", /vendorBuildRoot/.test(engine) && /vendor\/Liino\/build/.test(engine));

ok("开发态 Windows 目录按 GOOS 映射（windows-*，不是 win32-*）",
  /goPlatformName\(/.test(runtime) && /platform === "win32" \? "windows" : platform/.test(runtime));

ok("Windows 解码顺序 WinRT → WMF（0/1）",
  /func \(backend\) Priority\(\) int \{ return 0 \}/.test(src("../vendor/Liino/decode/winrt/winrt.go"))
    && /func \(backend\) Priority\(\) int \{ return 1 \}/.test(src("../vendor/Liino/decode/wmf/wmf.go")));

ok("Windows HTTP Ogg 在系统 FFmpeg 可用时优先 ffgo（avoid WinRT cold-open/seek）",
  /func \(backend\) PriorityFor\(src decode\.Source\) int/.test(src("../vendor/Liino/decode/native/prefer_windows.go"))
    && /return -1/.test(src("../vendor/Liino/decode/native/prefer_windows.go"))
    && /backendsFor\(src\)/.test(src("../vendor/Liino/decode/decode.go")));

ok("WinRT 初始 seek 前先预热网络源（切回 FLAC 不再卡 5s/E_ABORT）",
  /func \(s \*stream\) warmUp\(\) error/.test(src("../vendor/Liino/decode/winrt/session.go"))
    && /if s\.warm \|\| !isNetworkURI\(s\.uri\)/.test(src("../vendor/Liino/decode/winrt/session.go"))
    && /if err := s\.warmUp\(\); err != nil/.test(src("../vendor/Liino/decode/winrt/session.go"))
    && /func isNetworkURI\(uri string\) bool/.test(src("../vendor/Liino/decode/winrt/session.go"))
    && /TestSeekBeforeFirstFrameOverHTTP/.test(src("../vendor/Liino/decode/winrt/winrt_test.go")));

ok("实时解码 buffering 按实际拉流恢复，短 seek 不闪转圈",
  /framesPulledSince/.test(src("../vendor/Liino/pipeline.go"))
    && /WAIT_DEBOUNCE_MS/.test(src("src/lib/transport.ts")));

ok("初始 start_ms 未落地时 Liino 引擎补一次普通 seek（切档不回到 0）",
  /private maybeResume\(player: LiinoPlayer\)/.test(engine)
    && /this\.resumeAt = startAt > 1 \? startAt : 0/.test(engine)
    && /player\.seek\(Math\.round\(target \* 1000\)\)/.test(engine));

ok("初始 start= 未落地时 mpv 引擎补一次普通 seek",
  /private maybeResumeMpv\(mpv: MpvIpc \| null\)/.test(src("electron/audio/engine.ts"))
    && /"seek", target, "absolute"/.test(src("electron/audio/engine.ts")));

ok("容器提示：mime 优先 + 档位兜底（Ogg FLAC/7.1 走 ffgo）",
  decodeFormatHint("audio/ogg", "weiyun") === "ogg"
    && decodeFormatHint("application/octet-stream", "atmos71") === "ogg"
    && decodeFormatHint("", "640ogg") === "ogg"
    && decodeFormatHint("audio/flac", "master") === "flac"
    && decodeFormatHint("", "128") === "mp3");

ok("dev/app/build/typecheck:node 自动补齐 liino-node dist",
  (src("package.json").match(/node scripts\/ensure-liino-node\.ts/g) ?? []).length === 3
    && /scripts\/ensure-liino-node\.ts/.test(src("scripts/dev.ts"))
    && /scripts\/dev\.ts/.test(src("package.json")));

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

ok("macOS 设置页把 Liino 标为实验性、其余平台标为默认",
  /isMac \? "Liino（实验性原生模式）" : "Liino（原生直出，默认）"/.test(settings));

ok("macOS 设置页把 MPV 标为默认", /isMac \? "原生直出（MPV，默认）" : "原生直出（MPV）"/.test(settings));

ok("macOS 默认后端为 MPV", /platform === "darwin" \? "MPV" : "Liino"/.test(src("electron/config.ts")));

ok("播放器说清 Liino 的边界（无 PCM 兼容拓扑）", /没有 MPV 的 PCM 兼容拓扑/.test(player));

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
