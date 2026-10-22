// Quaver — Quark EQ 纯逻辑 + 接线护栏。
// 跑：node scripts/verify-eq.ts
//
// 四类红线：
//   ① 模型归一化：坏值不能带进 mpv；默认 0 点、最多 10 点、Q/增益/前级夹紧。
//   ② 滤镜串：bypass = 空串；bell/shelf/pass 映射到 equalizer/bass/treble/highpass/lowpass。
//   ③ APO：PK/LS/HS/LP/HP + GraphicEQ + Preamp 都能导入；不支持的类型必须明说。
//   ④ 接线：设置页 / 音量浮窗打开同一浮窗；主进程写 af；频谱 Peak + Loudness 真取 FFT。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EQ_MAX_BANDS, defaultEqState, eqFilterString, normalizeEqState } from "../electron/audio/eq-config.ts";
import { eqResponseDb, migrateLegacyFlat, parseApoPreset } from "../electron/audio/eq-core.ts";
import { EQ_PRESET_FREQS, EQ_PRESETS, matchPreset, presetBands } from "../electron/audio/eq-presets.ts";

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n=== ${t} ===`);

const check = (name: string, cond: unknown, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const UI = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(join(UI, rel), "utf8");

section("模型与默认曲线");

const flat = defaultEqState();

eq("默认 bypass", flat.enabled, false);

eq("默认 preamp 0", flat.preamp, 0);

eq("默认 0 点（不是预铺 10 个）", flat.bands.length, 0);

check("10 是上限而不是初始节点数", EQ_MAX_BANDS === 10);

const bad = normalizeEqState({
  enabled: true,
  preamp: 99,
  bands: [{ id: "bad id!", freq: -5, gain: 99, q: 0, type: "not-a-filter" }],
});

eq("坏值被夹紧/兜底", [bad.preamp, bad.bands[0].freq, bad.bands[0].gain, bad.bands[0].q, bad.bands[0].type], [24, 20, 24, 0.1, "bell"]);

const many = normalizeEqState({ bands: Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, freq: 20 + i, gain: 0, q: 1, type: "bell" })) });

eq(`段数封顶 ${EQ_MAX_BANDS}`, many.bands.length, EQ_MAX_BANDS);

eq("LP/HP 的 gain 强制归零", normalizeEqState({ bands: [{ id: "hp", freq: 80, gain: 9, q: 0.7, type: "highPass" }] }).bands[0].gain, 0);

eq("显式空数组保留为空（允许删掉最后一段）", normalizeEqState({ enabled: true, preamp: 0, bands: [] }).bands.length, 0);

eq("手改字符串 false 不会误开 EQ", normalizeEqState({ enabled: "false", bands: [] }).enabled, false);

eq("旧开发版 10 点平直默认自动迁成空曲线（懒加载迁移）", migrateLegacyFlat(normalizeEqState({ enabled: false, preamp: 0, bands: [31,62,125,250,500,1000,2000,4000,8000,16000].map((freq, i) => ({ id: `b${i}`, freq, gain: 0, q: 1.41, type: "bell" })) })).bands.length, 0);

section("内置 10 Band 预设");

const expectedPresets: Record<string, number[]> = {
  pop: [1, 2, 3, 4, 3, 1, -1, 1, 2, 3],
  rock: [4, 3, 1, 0, -1, 0, 1, 2, 3, 4],
  classical: [3, 2, 1, 1, 0, 0, 0, 1, 2, 3],
  jazz: [2, 1, 0, 1, -1, -1, 0, 1, 2, 2],
  electronic: [5, 4, 2, 0, -2, -1, 0, 1, 3, 4],
  country: [2, 1, 0, 1, 2, 1, 0, 1, 2, 2],
  headphone: [3, 2, 0, -1, -2, -1, 0, 2, 4, 5],
  "treble-boost": [0, -1, -2, -2, -1, 0, 1, 3, 5, 6],
  "bass-boost": [6, 5, 4, 2, 0, -1, -2, -2, -1, 0],
  vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  "bass-cut": [-4, -3, -2, -1, 0, 0, 0, 0, 0, 0],
  "treble-cut": [0, 0, 0, 0, 0, 0, -1, -2, -3, -4],
  smile: [4, 3, 1, -1, -2, -2, -1, 1, 3, 4],
};

eq("预设名称与顺序", EQ_PRESETS.map((p) => p.label), ["流行", "摇滚", "古典", "爵士", "电子", "乡村", "耳机补偿", "高音增强", "低音增强", "中音/人声增强", "低音减弱", "高音减弱", "微笑曲线"]);

eq("预设频点固定为 10 Band", [...EQ_PRESET_FREQS], [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);

for (const p of EQ_PRESETS) {
  eq(`预设「${p.label}」增益表`, [...p.gains], expectedPresets[p.id]);
  const bands = presetBands(p);
  check(`预设「${p.label}」生成 10 个 bell 节点`,
    bands.length === 10 && bands.every((b, i) => b.freq === EQ_PRESET_FREQS[i] && b.gain === p.gains[i] && b.q === 1.41 && b.type === "bell"));
  eq(`预设「${p.label}」可被当前曲线反查`, matchPreset(bands)?.id, p.id);
}

const popBands = presetBands(EQ_PRESETS.find((p) => p.id === "pop")!);

popBands[5].gain += 1;

eq("手动改节点后不再误认成预设", matchPreset(popBands), null);

section("mpv af 滤镜串");

const state = {
  enabled: true,
  preamp: -3.5,
  bands: [
    { id: "hp", freq: 30, gain: 0, q: 0.7, type: "highPass" as const },
    { id: "l", freq: 80, gain: 4, q: 0.7, type: "lowShelf" as const },
    { id: "m", freq: 1000, gain: -2.5, q: 1.2, type: "bell" as const },
    { id: "h", freq: 12000, gain: 3, q: 0.8, type: "highShelf" as const },
    { id: "lp", freq: 18000, gain: 0, q: 0.7, type: "lowPass" as const },
    { id: "z", freq: 4000, gain: 0, q: 1, type: "bell" as const },
  ],
};

eq("preamp + shelf + bell + HP/LP，同一条 lavfi；0dB bell 省略",
  eqFilterString(state),
  "lavfi=[volume=-3.5dB,highpass=f=30:width_type=q:width=0.7,bass=f=80:width_type=q:width=0.7:g=4,equalizer=f=1000:width_type=q:width=1.2:g=-2.5,treble=f=12000:width_type=q:width=0.8:g=3,lowpass=f=18000:width_type=q:width=0.7]");

eq("bypass 时 af 必须为空串（不能留旧滤镜）", eqFilterString({ ...state, enabled: false }), "");

eq("只有 0dB 节点时也输出空串", eqFilterString({ enabled: true, preamp: 0, bands: [{ id: "x", freq: 1000, gain: 0, q: 1, type: "bell" }] }), "");

section("曲线预览");

const boost = { enabled: true, preamp: 3, bands: [{ id: "x", freq: 1000, gain: 6, q: 1.4, type: "bell" as const }] };
const at1k = eqResponseDb(boost, 1000);

check("1kHz +6dB + preamp +3dB 在中心点叠加", at1k > 8.7 && at1k < 9.3, at1k.toFixed(2));

check("远离中心点回落接近 preamp", Math.abs(eqResponseDb(boost, 40) - 3) < 0.7, eqResponseDb(boost, 40).toFixed(2));

check("响应始终是有限数", [20, 50, 1000, 10000, 20000].every((f) => Number.isFinite(eqResponseDb(boost, f))));

const hp = { enabled: true, preamp: 0, bands: [{ id: "hp", freq: 1000, gain: 0, q: 0.707, type: "highPass" as const }] };
const lp = { enabled: true, preamp: 0, bands: [{ id: "lp", freq: 1000, gain: 0, q: 0.707, type: "lowPass" as const }] };

check("High-Pass 在截止点约 -3dB、低频继续下坠", Math.abs(eqResponseDb(hp, 1000) + 3) < 0.8 && eqResponseDb(hp, 40) < -24, `${eqResponseDb(hp,1000).toFixed(1)} / ${eqResponseDb(hp,40).toFixed(1)}`);

check("Low-Pass 在截止点约 -3dB、高频继续下坠", Math.abs(eqResponseDb(lp, 1000) + 3) < 0.8 && eqResponseDb(lp, 16000) < -24, `${eqResponseDb(lp,1000).toFixed(1)} / ${eqResponseDb(lp,16000).toFixed(1)}`);

section("APO / GraphicEQ 导入");

const apoText = `Preamp: -6.0 dB
Filter 1: ON PK Fc 1000 Hz Gain 3.0 dB Q 1.41
Filter 2: ON LSC Fc 80 Hz Gain -2.0 dB Q 0.7
Filter 3: ON HSC Fc 12000 Hz Gain 4.0 dB Q 0.8
Filter 4: OFF PK Fc 200 Hz Gain 9 dB Q 2
Filter 5: ON HP Fc 30 Hz Q 0.7
Filter 6: ON LP Fc 18000 Hz Q 0.7
Filter 7: ON NOTCH Fc 3000 Hz Gain -6 dB Q 2`;

const apo = parseApoPreset(apoText, "apo");

eq("APO preamp", apo.preamp, -6);

eq("APO 五个受支持滤波", [apo.filters, apo.state.bands.length], [5, 5]);

eq("PK/LS/HS/HP/LP 映射齐全", apo.state.bands.map((b) => b.type), ["highPass", "lowShelf", "bell", "highShelf", "lowPass"]);

check("OFF 项不导入", !apo.state.bands.some((b) => b.freq === 200));

check("不支持的 Notch 明确告警", apo.warnings.some((w) => w.includes("NOTCH")));

const graphic = parseApoPreset("GraphicEQ: 31 -2; 62 0; 125 3; 250 4; 500 1; 1000 0; 2000 -2; 4000 -3; 8000 0; 16000 2", "graphic");

eq("GraphicEQ 十个频点", graphic.graphicPoints, 10);

eq("GraphicEQ 频点/增益保真", graphic.state.bands.map((b) => [b.freq, b.gain]), [[31, -2], [62, 0], [125, 3], [250, 4], [500, 1], [1000, 0], [2000, -2], [4000, -3], [8000, 0], [16000, 2]]);

check("GraphicEQ 自动算 Q（10 段约一倍频程）", graphic.state.bands.every((b) => b.q > 1.3 && b.q < 1.5));

const graphic31 = parseApoPreset("GraphicEQ: " + Array.from({ length: 31 }, (_, i) => `${Math.round(20 * (1000 ** (i / 30)))} ${i - 15}`).join("; "), "graphic");

eq("31 段 GraphicEQ 压到 10 点而不是截掉高频", graphic31.state.bands.length, 10);

check("31 段压缩保留全频段首尾与告警", graphic31.state.bands[0].freq <= 21 && graphic31.state.bands[9].freq >= 19000 && graphic31.warnings.some((w) => w.includes("压缩")), graphic31.state.bands.map((b) => Math.round(b.freq)).join(","));

let rejected = false;

try { parseApoPreset("Filter 1: ON NOTCH Fc 1000 Hz Gain -6 dB Q 2", "apo"); } catch { rejected = true; }

check("全是未支持滤波时抛错而不是导入空曲线", rejected);

let noGraphic = false;

try { parseApoPreset("Filter 1: ON PK Fc 100 Hz Gain 3 dB Q 1", "graphic"); } catch { noGraphic = true; }

check("Graphic 模式找不到 GraphicEQ 行时抛错", noGraphic);

section("源码接线");

const engine = src("electron/audio/engine.ts");
const bar = src("src/components/PlayerBar.ts");
const settings = src("src/views/settings.ts");
const dialog = src("src/components/EqualizerDialog.ts");
const dialogCss = src("src/components/equalizer.css");
const style = src("src/style.css");
const config = src("electron/config.ts");
const core = src("electron/audio/eq-core.ts");

check("主进程 eq 命令写共享状态", /case "eq":[\s\S]{0,600}normalizeEqState\(cmd\.state\)/.test(engine));

check("mpv 运行时真的写 af 属性", /setProp\("af", filter\)/.test(engine));

check("mpv 重拉后重新套用 EQ（不只在播放中生效）", /await mpv\.start\(\);[\s\S]{0,300}applyEqualizer\(mpv\)/.test(engine));

check("音量浮窗有 EQ 快捷入口", /id="pb-eq-shortcut"/.test(bar) && /import\("\.\/EqualizerDialog"\)/.test(bar));

check("设置 → 播放有打开 EQ 浮窗按钮", /id="open-equalizer"/.test(settings) && /import\("\.\.\/components\/EqualizerDialog"\)/.test(settings));

check("EQ 浮窗是懒加载块（设置/播放条不静态 import）", !/^import .*EqualizerDialog/m.test(bar) && !/^import .*EqualizerDialog/m.test(settings));

check("浮窗只在 MPV 可编辑", /const isMpv = \(\) => player\.backend === "mpv"/.test(dialog) && /const ok = isMpv\(\)/.test(dialog));

check("点空白添加、拖动节点、双击/右键删除、滚轮调 Q", /state\.bands\.push\(\{ id, freq: p\.freq/.test(dialog) && /pointermove/.test(dialog) && /dblclick/.test(dialog) && /contextmenu/.test(dialog) && /addEventListener\("wheel"/.test(dialog));

check("Delete 只有窗口级一处处理器（节点级再挂一次会连删两段）", (dialog.match(/addEventListener\("keydown"/g) || []).length === 1);

check("Q 影响宽度（检查器 + wheel 都写 q）", /id="eq-q-range"/.test(dialog) && /b\.q \* \(e\.deltaY > 0/.test(dialog));

check("滤波类型含真正的高通 / 低通", /value="highPass">High-Pass/.test(dialog) && /value="lowPass">Low-Pass/.test(dialog));

check("预设下拉由 13 个内置预设生成并可即时应用", /EQ_PRESETS\.map/.test(dialog) && /id="eq-preset"/.test(dialog) && /presetSelect\.onchange/.test(dialog) && /presetBands\(preset\)/.test(dialog));

check("手动改节点后预设回落到自定义", /matchPreset\(state\.bands\)\?\.id \?\? ""/.test(dialog));

check("频谱 Peak + Loudness 真取 WebAudio FFT（不是随机动画）", /audioSpectrum\.onFrame\(drawSpectrum\)/.test(dialog) && /PEAK/.test(dialog) && /LOUDNESS/.test(dialog) && /getFloatFrequencyData/.test(src("src/lib/audio-spectrum.ts")));

check("频谱 canvas 与折线 EQ SVG 分层叠加", /id="eq-spectrum"/.test(dialog) && /id="eq-graph"/.test(dialog) && dialogCss.includes(".eq-graph-stage") && dialogCss.includes(".eq-spectrum"));

check("可视化明确消费当前音量与 EQ 响应（Post-Fader）", /POST-FADER/.test(dialog) && /const fader = player\.muted \? 0 : player\.volume/.test(dialog) && /20 \* Math\.log10\(fader\)/.test(dialog) && /spectrumEqDb\[i\]/.test(dialog) && /updateSpectrumEq\(\)/.test(dialog));

check("图下描述语已删除", !/eq-graph-hint/.test(dialog) && !/eq-graph-hint/.test(dialogCss));

check("桌面图形 EQ 吃掉左侧剩余高度（动态 viewBox，不拉伸圆点/文字）", /\.eq-graph-stage \{[^}]*flex: 1/.test(dialogCss) && /syncViewMetrics/.test(dialog) && /VIEW_H = VIEW_W \* r\.height \/ r\.width/.test(dialog) && /svg\.setAttribute\("viewBox"/.test(dialog));

check("anti-slop：事件目标不再用 as 断言", !/e\.target as (Element|HTMLElement)/.test(dialog) && /e\.target instanceof Element/.test(dialog));

check("anti-slop：下拉类型不再 as 断言", !/type\.value as EqBandType/.test(dialog) && /isEqBandType\(nextType\)/.test(dialog));

check("anti-slop：APO 属性不再用开放 dictionary", !/Record<string, number>/.test(core) && /attrs: \{ freq\?: number; gain\?: number; q\?: number; bw\?: number \}/.test(core));

check("EQ 是模态浮窗：遮罩 + aria-modal + 点遮罩关闭", /className = "eq-overlay"/.test(dialog) && /aria-modal", "true"/.test(dialog) && /e\.target === overlay/.test(dialog) && dialogCss.includes(".eq-overlay"));

check("模态遮罩继续受设置里的统一模糊开关管理", /\.eq-overlay \{[\s\S]{0,180}backdrop-filter: var\(--shell-filter\)/.test(dialogCss) && !/-webkit-backdrop-filter/.test(dialogCss));

check("APO 与 APO Graphic EQ 两个导入入口", /导入 APO/.test(dialog) && /导入 APO Graphic EQ/.test(dialog));

check("右下角 Powered By Quark EQ", /Powered By <b>Quark EQ<\/b>/.test(dialog));

check("整窗 CSS 走懒加载（首屏 style.css 不再含 eq-float 大段）", !style.includes(".eq-float {") && dialogCss.includes(".eq-float {") && /import "\.\/equalizer\.css"/.test(dialog));

check("配置 schema 有 Playing.Equalizer", /key: "Equalizer"/.test(config));

check("设置项只为 MPV 承诺", /仅 MPV · 实时预览/.test(settings));

check("设置页与浮窗标题不再出现 Quark EQ 品牌字样", !/Quark EQ/.test(settings) && /<span class="eq-title"><b>EQ<\/b>/.test(dialog) && !/<span class="eq-title"><b>Quark EQ/.test(dialog));

check("默认 0 点 / 最多 10 点写在 UI", /0 \/ 10 BANDS/.test(dialog) && /最多 \$\{EQ_MAX_BANDS\} 个/.test(dialog));

check("清空按钮只清节点并保留 preamp", /清空全部频段/.test(dialog) && /preamp: state\.preamp, bands: \[\]/.test(dialog));

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-eq: ${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);
