// Quaver — 配置文件（electron/config.mjs）单测：纯 Node，不需要 Electron / 浏览器。
// 跑：  node scripts/verify-config.mjs
// 覆盖：模板生成、INI 保注释解析、set 命中/追加/补段、值域校验、原子写与 0600 权限、路径规则。
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_NAME, configDir, configFile, credentialFile, credentialStoreFile, deviceFile,
  defaults, IniDoc, readValues, resetConfig, template, writeValues,
} from "../electron/config.mjs";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const ROOT = mkdtempSync(join(tmpdir(), "quaver-conf-"));
const dir = join(ROOT, "Quaver Music");
process.env.QUAVER_CONFIG_DIR = dir;
const FILE = configFile();

// ——— 路径 ———
section("路径规则");
eq("QUAVER_CONFIG_DIR 覆盖生效", configDir(), dir);
eq("配置文件落在目录内", FILE, join(dir, CONFIG_NAME));
check("凭证同目录", credentialFile() === join(dir, "credential.json"));
check("密钥环存档同目录", credentialStoreFile() === join(dir, "credential.enc"));
check("设备指纹同目录", deviceFile() === join(dir, "device.json"));
check("平台默认值不含 QUAVER_CONFIG_DIR 覆盖（Linux 走 XDG）",
  (() => { const bak = process.env.QUAVER_CONFIG_DIR; delete process.env.QUAVER_CONFIG_DIR;
    const xdg = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = "/x";
    const got = configDir(); process.env.XDG_CONFIG_HOME = xdg; process.env.QUAVER_CONFIG_DIR = bak;
    return got === "/x/quaver-music" || got.endsWith("quaver-music"); })());

// ——— INI 解析（保结构）———
section("INI 解析与保注释");
const SRC = [
  "# 文件头注释",
  "[Style]",
  "# 段内说明",
  "Style=dark",
  "",
  "Custom=keep-me",
  "[Playing]",
  "Backend=MPV",
  "",
].join("\n");
const doc = IniDoc.parse(SRC);
eq("读到键值", doc.values(), { "Style.Style": "dark", "Style.Custom": "keep-me", "Playing.Backend": "MPV" });
check("段名大小写不敏感", doc.get("style", "STYLE") === "dark");
doc.set("Style", "Style", "light");
check("改值只动那一行，注释保留", doc.toString().includes("# 文件头注释") && doc.toString().includes("# 段内说明"));
check("改值后取值正确", doc.get("Style", "Style") === "light");
check("原有顺序不变", doc.toString().indexOf("# 文件头注释") < doc.toString().indexOf("[Style]"));

const d2 = IniDoc.parse(SRC);
d2.set("Style", "NewKey", "v1");
const afterNew = d2.toString().split("\n");
check("段内新键追加在段尾（不跨段）",
  afterNew.indexOf("NewKey=v1") > afterNew.indexOf("Custom=keep-me") && afterNew.indexOf("NewKey=v1") < afterNew.indexOf("[Playing]"));
const d3 = IniDoc.parse(SRC);
d3.set("Fresh", "K", "v");
check("段不存在则补段头", d3.toString().includes("[Fresh]") && d3.toString().trimEnd().endsWith("K=v"));
const d4 = IniDoc.parse("[A]\nx=1\n");
d4.set("A", "x", "has=eq value");
check("值里带 = 能原样写回", d4.get("A", "x") === "has=eq value");
const d5 = IniDoc.parse("[A]\nx=old  # 行内注释\n");
d5.set("A", "x", "new");
eq("改值后取值是剥离注释的", d5.get("A", "x"), "new");
check("改值保留行尾注释", d5.toString().includes("x=new # 行内注释"), d5.toString());
eq("values() 同样剥离行内注释", IniDoc.parse("[A]\nx=v # c\n").values(), { "A.x": "v" });
eq("注释行不会被当成键", IniDoc.parse("[A]\n; c=1\n# d=2\nZ=3\n").values(), { "A.Z": "3" });

// ——— 首次运行 ———
section("首次运行");
check("模板随读取落地", (readValues(), existsSync(FILE)));
check("模板含全部段", ["[Style]", "[Window]", "[Playing]", "[Quality]", "[Security]"].every((s) => template().includes(s)));
check("模板注释来自 schema", template().includes("可选 dark,light,follow-system"));
eq("默认值与模板占位一致", (() => { const v = readValues().values; return v["Style.Style"] === "dark" && v["Playing.Backend"] === "MPV" && v["Quality.DefaultQuality"] === "Auto" && v["Quality.FallbackToQMAtmos"] === "False"; })(), true);
eq("schema 默认值表条数", Object.keys(defaults()).length, 16);
eq("音量默认 0.8", defaults()["Playing.Volume"], "0.8");
eq("歌词翻译默认开", defaults()["Style.ShowTranslation"], "True");
eq("侧栏默认展开", defaults()["Window.SidebarCollapsed"], "False");
eq("非法布尔值被拒绝（侧栏缩回）", writeValues({ "Window.SidebarCollapsed": "maybe" }), []);
eq("合法布尔值写入（侧栏缩回）", writeValues({ "Window.SidebarCollapsed": "True" }), ["Window.SidebarCollapsed"]);
eq("非法音量被拒绝", writeValues({ "Playing.Volume": "1.5" }), []);
eq("非法音量被拒绝（负数）", writeValues({ "Playing.Volume": "-0.1" }), []);
eq("空音量被拒绝（Number('')===0 的坑）", writeValues({ "Playing.Volume": "" }), []);
eq("合法音量写入", writeValues({ "Playing.Volume": "0.35" }), ["Playing.Volume"]);

// ——— 权限 ———
section("权限与原子写");
const mode = statSync(FILE).mode & 0o777;
check(`配置文件 0600（实际 ${mode.toString(8)}）`, mode === 0o600);
const dmode = statSync(dir).mode & 0o777;
check(`配置目录 0700（实际 ${dmode.toString(8)}）`, dmode === 0o700);
check("目录下无残留临时文件", readdirSync(dir).every((f) => !f.endsWith(".tmp")));

// ——— 写回 ———
section("写入与校验");
eq("合法键写入", writeValues({ "Style.Style": "follow-system", "Playing.Fade": "long" }), ["Style.Style", "Playing.Fade"]);
const v1 = readValues().values;
eq("写入后读回", [v1["Style.Style"], v1["Playing.Fade"]], ["follow-system", "long"]);
eq("未知键被忽略", writeValues({ "Nope.Key": "x", "Style.Style": "light" }), ["Style.Style"]);
eq("非法值被拒绝（不落盘）", writeValues({ "Style.Style": "Not Valid Theme!" }), []);
eq("非法值拒绝后旧值仍在", readValues().values["Style.Style"], "light");
// 用户手写在文件里的自定义键：不进运行时表，但改别的键时也不能被抹掉
writeFileSync(FILE, readFileSync(FILE, "utf8").replace("[Style]", "[Style]\nCustomX=y"));
eq("自加键不进运行时表", readValues().values["Style.CustomX"], undefined);
eq("写别的键不会抹掉自加键", (writeValues({ "Playing.Fade": "short" }), readFileSync(FILE, "utf8").includes("CustomX=y")), true);
writeValues({ "Playing.Fade": "long" });
eq("Backend 接受 Chromium", (writeValues({ "Playing.Backend": "Chromium" }), readValues().values["Playing.Backend"]), "Chromium");
eq("空字体值合法（表示不覆盖）", (writeValues({ "Style.DefaultUIFonts": "" }), readValues().values["Style.DefaultUIFonts"]), "");eq("字体值拒绝 CSS 注入", writeValues({ "Style.DefaultUIFonts": "x; } body{display:none" }), []);
eq("字体值拒绝 url()", writeValues({ "Style.DefaultLyricsFonts": "url(http://evil)" }), []);

// ——— [Security]：凭证存储口径（取值域写错了会静默退回默认，最难查）———
section("[Security] 凭证存储");
eq("默认 auto（能用密钥环就用）", defaults()["Security.CredentialStore"], "auto");
eq("默认后端探测", defaults()["Security.KeyringBackend"], "auto");
eq("**没有明文那一档**（账户安全不让步）", writeValues({ "Security.CredentialStore": "file" }), []);
eq("接受 keyring", writeValues({ "Security.CredentialStore": "keyring" }), ["Security.CredentialStore"]);
eq("接受 memory（只驻内存）", writeValues({ "Security.CredentialStore": "memory" }), ["Security.CredentialStore"]);
eq("拒绝瞎写的存储模式", writeValues({ "Security.CredentialStore": "keychain" }), []);
eq("接受显式后端 kwallet6", writeValues({ "Security.KeyringBackend": "kwallet6" }), ["Security.KeyringBackend"]);
eq("拒绝瞎写的后端名", writeValues({ "Security.KeyringBackend": "gnome" }), []);
eq("接受 gnome-libsecret", writeValues({ "Security.KeyringBackend": "gnome-libsecret" }), ["Security.KeyringBackend"]);
eq("DevPlaintextFallback 已随明文一并删除", defaults()["Security.DevPlaintextFallback"], undefined);
eq("取值都读得回来", (() => { const v = readValues().values; return [v["Security.CredentialStore"], v["Security.KeyringBackend"]]; })(), ["memory", "gnome-libsecret"]);
eq("回到 auto（后续断言不受影响）", writeValues({ "Security.CredentialStore": "auto", "Security.KeyringBackend": "auto" }).length, 2);

// ——— 手改文件后读回（模拟用户编辑）———
section("用户手改文件");
const edited = readFileSync(FILE, "utf8")
  .replace(/^Style=.*$/m, "Style=  custom-neon  ") // 带空格的值
  .replace(/^FallbackToQMAtmos=.*$/m, "FallbackToQMAtmos=maybe"); // 非法值
writeFileSync(FILE, edited);
const r2 = readValues();
eq("带空格的值被 trim", r2.values["Style.Style"], "custom-neon");
eq("非法值回落默认", r2.values["Quality.FallbackToQMAtmos"], "False");
eq("非法值给出 warning", r2.warnings.length, 1);
check("warning 文案含键名", r2.warnings[0].includes("Quality.FallbackToQMAtmos"), r2.warnings[0]);
check("手改后注释仍完整", readFileSync(FILE, "utf8").includes("# 可选 dark,light,follow-system"));

// ——— 重置 ———
section("重置");
const resetVals = resetConfig();
eq("重置后回到默认", resetVals["Style.Style"], "dark");
check("重置后文件即模板", readFileSync(FILE, "utf8") === template());

// ——— 只读/异常容错 ———
section("异常容错");
process.env.QUAVER_CONFIG_DIR = join(ROOT, "missing", "deep");
check("目录不存在时自动创建", (readValues(), existsSync(configFile())));
process.env.QUAVER_CONFIG_DIR = dir;
mkdirSync(dir, { recursive: true });
writeFileSync(FILE, "\uFEFF[BOM]\nA=1\n"); // BOM
eq("BOM 不影响解析", IniDoc.parse(readFileSync(FILE, "utf8")).get("BOM", "A"), "1");
writeFileSync(FILE, "[A]\nA=1\r\n"); // CRLF
eq("CRLF 归一", IniDoc.parse(readFileSync(FILE, "utf8")).get("A", "A"), "1");

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-config: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
