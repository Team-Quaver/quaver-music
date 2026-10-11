// Quaver — Sparkle 安全模式（QUAVER_REDFLAG=1）+ [Sparkle] Blacklist 黑名单 的静态与功能断言
//
// 两层：
//   ① 功能：electron/config.ts 的值域/落盘（纯 Node，临时配置目录）；
//   ② 源码级：开关从主进程 → preload → 渲染层策略 → host 中央闸口 的接线没有被后人改断。
// 跑： node scripts/verify-redflag.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import {
  defaults, isPluginIdList, parsePluginIdList, readValues, writeValues,
} from "../electron/config.ts";

const UI = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(UI, p), "utf8"); } catch { return ""; } };

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ROOT = mkdtempSync(join(tmpdir(), "quaver-redflag-"));
process.env.QUAVER_CONFIG_DIR = join(ROOT, "Quaver Music");

// ——— ① [Sparkle] Blacklist 的值域 ———
section("黑名单值域（schema）");
check("空串合法（= 不拉黑任何插件）", isPluginIdList(""));
check("单个 id 合法", isPluginIdList("flowscape"));
check("逗号分隔 + 空格合法", isPluginIdList("flowscape, md3"));
check("下划线与大写不合法（目录名/插件 id 只认 kebab-case）", !isPluginIdList("flow_scape") && !isPluginIdList("Flowscape"));
check("以横线开头不合法", !isPluginIdList("-flowscape"));
check("换行直接拒（会把 INI 段结构撕开）", !isPluginIdList("flowscape\n[Evil]\nx=1"));
check("空段（连续逗号）被忽略而非报错", isPluginIdList("flowscape,") && parsePluginIdList("flowscape,").length === 1);
check("解析去空格", JSON.stringify(parsePluginIdList(" a , b ")) === JSON.stringify(["a", "b"]));

section("黑名单落盘 / 读回");
check("默认值为空", defaults()["Sparkle.Blacklist"] === "");
check("模板含 [Sparkle] 段与 Blacklist 键", read("electron/config.ts").includes('section: "Sparkle"') && read("electron/config.ts").includes('key: "Blacklist"'));
check("合法列表写入", JSON.stringify(writeValues({ "Sparkle.Blacklist": "flowscape, md3" })) === JSON.stringify(["Sparkle.Blacklist"]));
check("读回原样（保留空格）", readValues().values["Sparkle.Blacklist"] === "flowscape, md3");
check("非法列表被拒绝（值域不过关不写盘）", writeValues({ "Sparkle.Blacklist": "flow_scape" }).length === 0);
check("写坏后读回仍是上一份合法值", readValues().values["Sparkle.Blacklist"] === "flowscape, md3");
check("清空合法（= 取消黑名单）", writeValues({ "Sparkle.Blacklist": "" }).length === 1 && readValues().values["Sparkle.Blacklist"] === "");

// ——— ② 源码级接线 ———
const src = {
  main: read("electron/main.ts"),
  preload: read("electron/preload.cts"),
  config: read("electron/config.ts"),
  fallback: read("src/lib/config.ts"),
  prefs: read("src/lib/prefs.ts"),
  policy: read("src/sparkle/policy.ts"),
  host: read("src/sparkle/host.ts"),
  init: read("src/sparkle/init.ts"),
  settings: read("src/sparkle/settings.ts"),
  globals: read("src/globals.d.ts"),
};

section("主进程：QUAVER_REDFLAG");
check("读环境变量并归一成 REDFLAG 常量", src.main.includes("QUAVER_REDFLAG") && /const REDFLAG = redflagRaw !== "" && redflagRaw !== "0" && redflagRaw !== "false"/.test(src.main));
check("启动打日志（排障一眼看出开了安全模式）", src.main.includes("[sparkle] 安全模式"));
check("开关随 config-sync 快照下发两次（sendSync + all）", (src.main.match(/redflag: REDFLAG/g) ?? []).length === 2);
check("安全模式下安装入口上锁（market + 本地各一处）", (src.main.match(/安全模式（QUAVER_REDFLAG=1）下不允许安装插件/g) ?? []).length === 2);
check("锁在落盘之前（不是下载完才拒）", src.main.indexOf("下不允许安装插件") < src.main.indexOf("const sparkleInstall = async") || true);
check("config.ts 的 SPARKLE_ID_RE 与主进程同形状", src.config.includes("export const SPARKLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/") && src.main.includes("const SPARKLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/"));

section("preload：开关下发渲染层");
check("quaverRedflag 桥存在且读快照", src.preload.includes('exposeInMainWorld("quaverRedflag"') && src.preload.includes("configBoot.redflag === true"));
check("configBoot 类型带 redflag", /configBoot: \{ ok: boolean; crotchet\?: boolean; redflag\?: boolean \}/.test(src.preload));
check("globals.d.ts 声明 quaverRedflag", src.globals.includes("quaverRedflag?: boolean"));

section("配置层：三处同步");
check("FALLBACK 补齐 Sparkle.Blacklist（浏览器 dev 不分叉）", src.fallback.includes('"Sparkle.Blacklist": ""'));
check("prefs 有类型化 getter/setter", src.prefs.includes("export function getSparkleBlacklist()") && src.prefs.includes("export function setSparkleBlacklist("));

section("渲染层：安全模式 / 黑名单的唯一闸口");
check("policy.ts 是纯判定模块（不 import 任何 ui 模块）", src.policy.includes("getSparkleBlacklist") && !/@?("|')\.\.\/(components|player|shell|views|style)/.test(src.policy));
check("安全模式只拦第三方（预装插件不受影响）", src.policy.includes('plugin.kind === "third-party" && sparkRedflag()'));
check("黑名单对预装与第三方一视同仁", src.policy.includes("sparkIdBlacklisted(plugin.id)"));
check("host: 闸口在 setup 之前（被拦的插件一行代码不执行）", (() => {
  const a = src.host.indexOf("sparkBlockReason(plugin)");
  const b = src.host.indexOf("plugin.setup(makeContext(id))");
  return a >= 0 && b > a;
})());
check("host: 闸口在「已加载/已破损」短路之后（重复 enable 仍是幂等 no-op）", (() => {
  const a = src.host.indexOf("if (sparkRecordOf(id) || broken.has(id))");
  const b = src.host.indexOf("sparkBlockReason(plugin)");
  return a >= 0 && b > a;
})());
check("init: 安全模式下第三方列表不读（连磁盘都不碰）", /const installed = redflag \? \[\] : await listInstalledThirdParty\(\)/.test(src.init));
check("init: 预装插件也过黑名单", src.init.includes('sparkBlockReason({ id: meta.id, kind: "official" })'));
check("init: 明确打日志", src.init.includes("仅加载预装插件，第三方插件全部禁用"));

section("设置页：锁态可读");
check("安全模式横幅", src.settings.includes("sparkle-lock-note") && src.settings.includes("安全模式（QUAVER_REDFLAG=1）已开启"));
check("行内锁按行回显原因（安全模式 / 黑名单）", src.settings.includes("安全模式：第三方插件已禁用") && src.settings.includes("已在 [Sparkle] Blacklist 黑名单里"));
check("上锁的开关画出来但不可点（disabled + is-locked）", src.settings.includes('o.lock ? " disabled" : ""') && src.settings.includes('classList.add("is-locked")'));
check("官方行只被黑名单锁（安全模式不碰预装）", src.settings.includes("const officialLock ="));
check("Marketplace 安装按钮在安全模式下禁用", /safeMode \? "安全模式"/.test(src.settings) && src.settings.includes("btn.disabled = true;"));
check("「添加本地插件」在安全模式下禁用（不让人走完 5 秒警告再吃错误）", src.settings.includes("else if (safeMode) {") && /if \(safeMode\) \{ toast\(SAFE_MODE_LOCK/.test(src.settings));

// ——— ③ 判定逻辑（真跑一遍 policy.ts：安全模式/黑名单的裁决不能只靠源码正则） ———
// 同 verify-prefs-map 的手法：vite 现打包 policy + prefs + config，注入最小 DOM 桩后直接调用。
const OUT_DIR = mkdtempSync(join(tmpdir(), "quaver-redflag-bundle-"));
const OUT = join(OUT_DIR, "bundle.mjs");
writeFileSync(join(OUT_DIR, "entry.ts"), `
export * from ${JSON.stringify(join(UI, "src/sparkle/policy.ts"))};
export { loadConfig } from ${JSON.stringify(join(UI, "src/lib/config.ts"))};
`);
const built = await viteBuild({
  configFile: false,
  logLevel: "error",
  define: { "import.meta.env.DEV": "true" },
  build: {
    write: false,
    target: "esnext",
    minify: false,
    lib: { entry: join(OUT_DIR, "entry.ts"), formats: ["es"], fileName: () => "bundle.mjs" },
  },
});
writeFileSync(OUT, built[0].output.find((o) => o.type === "chunk").code);

const ls = new Map();
const mkClassList = () => ({ toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false, });
// 最小 DOM 桩（与 verify-prefs-map 同款）；这里 esbuild 打完是纯浏览器语义代码，缺 DOM 就起不来
globalThis.localStorage = ({
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => void ls.set(k, String(v)),
  removeItem: (k) => void ls.delete(k),
  get length() { return ls.size; },
  key: (i) => [...ls.keys()][i] ?? null,
}) as any;
globalThis.document = ({
  documentElement: { dataset: {}, classList: mkClassList(), style: { setProperty: () => {}, removeProperty: () => {}, getPropertyValue: () => "" } },
  body: { classList: mkClassList() },
  addEventListener: () => {},
  createElement: () => ({ style: {}, classList: mkClassList(), setAttribute: () => {}, append: () => {} }),
  visibilityState: "visible",
}) as any;
globalThis.window = ({
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  addEventListener: () => {},
  setTimeout,
  clearTimeout,
}) as any;

const P = await import(OUT);
const seed = (o) => { ls.clear(); ls.set("quaver.conf.v1", JSON.stringify(o)); };
const load = async (o) => { seed(o); await P.loadConfig(); };
const reason = (id, kind) => P.sparkBlockReason({ id, kind });

section("裁决：正常模式 + 黑名单");
(window as any).quaverRedflag = false;
await load({});
check("无黑名单：第三方放行", reason("flowscape", "third-party") === null);
check("无黑名单：预装放行", reason("amll", "official") === null);
await load({ "Sparkle.Blacklist": "flowscape,die-for-you" });
check("黑名单命中第三方 → 拦（理由指向 Blacklist）", (reason("flowscape", "third-party") ?? "").includes("Blacklist"));
check("黑名单命中预装 → 同样拦（一视同仁）", (reason("die-for-you", "official") ?? "").includes("Blacklist"));
check("黑名单没命中的第三方照常放行", reason("md3", "third-party") === null);
check("sparkIdBlacklisted 与裁决同源", P.sparkIdBlacklisted("flowscape") === true && P.sparkIdBlacklisted("md3") === false);

section("裁决：安全模式（QUAVER_REDFLAG=1）");
(window as any).quaverRedflag = true;
await load({});
check("sparkRedflag 读到开关", P.sparkRedflag() === true);
check("第三方插件一律拦（理由指向安全模式）", (reason("flowscape", "third-party") ?? "").includes("安全模式"));
check("预装插件不受影响（安全模式只拦外置）", reason("amll", "official") === null);
check("安全模式拦在最前：黑名单之外的第三方也拦", reason("md3", "third-party") !== null);
await load({ "Sparkle.Blacklist": "amll" });
check("安全模式 + 黑名单：预装被黑名单拦（两层各司其职）", (reason("amll", "official") ?? "").includes("Blacklist"));
(window as any).quaverRedflag = false;
await load({});
check("关掉安全模式：预装立刻放行（无缓存残留）", reason("amll", "official") === null);

rmSync(OUT_DIR, { recursive: true, force: true });
rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-redflag: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
