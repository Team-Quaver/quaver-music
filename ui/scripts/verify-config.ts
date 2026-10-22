// Quaver — 配置文件（electron/config.ts）单测：纯 Node，不需要 Electron / 浏览器。
// 跑：  node scripts/verify-config.ts
// 覆盖：模板生成、INI 保注释解析、set 命中/追加/补段、值域校验、原子写与 0600 权限、路径规则。
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_NAME, configDir, configFile, credentialFile, credentialStoreFile, deviceFile,
  defaults, IniDoc, readValues, resetConfig, template, writeValues,
} from "../electron/config.ts";

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
check("模板含全部段", ["[Style]", "[Window]", "[Playing]", "[Quality]", "[Lyrics]", "[DesktopLyrics]", "[Security]", "[Update]"].every((s) => template().includes(s)));
check("模板注释来自 schema", template().includes("可选 dark,light,follow-system"));
eq("默认值与模板占位一致", (() => { const v = readValues().values; return v["Style.Style"] === "dark" && v["Playing.Backend"] === "MPV" && v["Quality.DefaultQuality"] === "Auto" && v["Quality.FallbackToQMAtmos"] === "False"; })(), true);
eq("schema 默认值表条数", Object.keys(defaults()).length, 74); // [DesktopLyrics] 21 键（Enabled/Locked/Opacity/Backdrop/Scale/Weight/Font/Border/Shadow/ShadowBlur/ShadowOpacity/ShadowX/ShadowY/Mode/SingleCenter/ColorMode/Color + X/Y/W/H 记忆坐标）；[Lyrics] 4 键（ChineseConvert 繁简档/OnlineTtml 在线逐字开关/TtmlDatabase 地址模板/TtmlLibrary 本地库目录）；LyricAux 为歌词辅助行（关闭/翻译/音译，两路同位置且各按档位回落）；LyricScale 为行级歌词缩放；LyricLayout 为正在播放页歌词列四档；Background/BackgroundImage/BackgroundBlur 为默认主题背景（模式/自定义图/模糊强度）；Tint/TintColor 为界面高亮色（来源档位/自定义色）；ControlBar 为控制条停靠形态；PlaylistMode 为歌单显示模式（菜单栏/歌单集合页）；MenuBlur 为浮层菜单毛玻璃开关；Spectrum/SpectrumMode 为正在播放页真实音频频谱开关与形态；Equalizer 为 Quark EQ 整段 JSON（默认空曲线、最多 10 段、bypass）；PrevReplay 为上一首按钮逻辑；InhibitSleep 为播放音频时睡眠禁止；[Hotkeys.Global]/[Hotkeys.Focus] 共 11 键；[Sparkle] 1 键（Blacklist）；[Update] 共 3 键（AutoCheck/Channel/LastNotified）
check("模板含热键两段", ["[Hotkeys.Global]", "[Hotkeys.Focus]"].every((s) => template().includes(s)));
eq("全局热键默认 Ctrl+Alt+P", defaults()["Hotkeys.Global.Toggle"], "Ctrl+Alt+P");
eq("焦点退出默认 Ctrl+Q", defaults()["Hotkeys.Focus.Quit"], "Ctrl+Q");
eq("音量默认 0.8", defaults()["Playing.Volume"], "0.8");
eq("EQ 默认 bypass 且为空曲线（0/10）", (() => {
  const e = JSON.parse(defaults()["Playing.Equalizer"]);
  return [e.enabled, e.preamp, e.bands.length];
})(), [false, 0, 0]);
eq("EQ 拒绝坏 JSON", writeValues({ "Playing.Equalizer": "{not-json" }), []);
eq("EQ 拒绝超过 10 段", writeValues({ "Playing.Equalizer": JSON.stringify({ enabled: true, preamp: 0, bands: Array.from({ length: 11 }, (_, i) => ({ id: `z${i}`, freq: 100 + i, gain: 0, q: 1, type: "bell" })) }) }), []);
eq("EQ 接受修改后的合法曲线", writeValues({ "Playing.Equalizer": JSON.stringify({ enabled: true, preamp: -3.5, bands: [{ id: "myBand", freq: 1000, gain: 4.5, q: 1.2, type: "bell" }] }) }), ["Playing.Equalizer"]);
eq("歌词辅助默认翻译", defaults()["Style.LyricAux"], "translation");
eq("频谱默认关闭", defaults()["Style.Spectrum"], "False");
eq("频谱形态默认柱状", defaults()["Style.SpectrumMode"], "bars");
eq("频谱开关接受布尔写法", writeValues({ "Style.Spectrum": "True" }), ["Style.Spectrum"]);
eq("频谱形态接受插件 id", writeValues({ "Style.SpectrumMode": "my-cool-mode" }), ["Style.SpectrumMode"]);
eq("频谱形态拒绝非法 id", writeValues({ "Style.SpectrumMode": "Bad Mode!" }), []);
writeValues({ "Style.Spectrum": "False", "Style.SpectrumMode": "bars" });
eq("歌词翻译兼容键默认开", defaults()["Style.ShowTranslation"], "True");
eq("上一首逻辑默认开（重放当前曲）", defaults()["Playing.PrevReplay"], "True");
eq("睡眠禁止默认开", defaults()["Playing.InhibitSleep"], "True");
eq("侧栏默认展开", defaults()["Window.SidebarCollapsed"], "False");
eq("侧栏宽度默认未自定义", defaults()["Window.SidebarWidth"], "");
eq("队列宽度默认未自定义", defaults()["Window.QueueWidth"], "");
eq("繁简转换默认不转", defaults()["Lyrics.ChineseConvert"], "off");
eq("在线 TTML 默认开", defaults()["Lyrics.OnlineTtml"], "True");
eq("TTML 数据库默认模板（全平台 %p）", defaults()["Lyrics.TtmlDatabase"], "https://amlldb.bikonoo.com/%p/%s.ttml");
eq("本地 TTML 库默认未设置", defaults()["Lyrics.TtmlLibrary"], "");
eq("桌面歌词默认关", defaults()["DesktopLyrics.Enabled"], "False");
eq("桌面歌词歌词层默认完全不透明", defaults()["DesktopLyrics.Opacity"], "1");
eq("桌面歌词窗体默认无背板（全透明，只有字）", defaults()["DesktopLyrics.Backdrop"], "0");
eq("桌面歌词字号默认 1", defaults()["DesktopLyrics.Scale"], "1");
eq("桌面歌词字重默认 400", defaults()["DesktopLyrics.Weight"], "400");
eq("桌面歌词字体独立默认宋体", defaults()["DesktopLyrics.Font"], "Source Han Serif");
eq("桌面歌词描边默认 1px", defaults()["DesktopLyrics.Border"], "1");
eq("桌面歌词阴影默认开", defaults()["DesktopLyrics.Shadow"], "True");
eq("桌面歌词阴影模糊默认 8px", defaults()["DesktopLyrics.ShadowBlur"], "8");
eq("桌面歌词阴影不透明度默认 0.45", defaults()["DesktopLyrics.ShadowOpacity"], "0.45");
eq("桌面歌词阴影偏移默认 X=0/Y=2", [defaults()["DesktopLyrics.ShadowX"], defaults()["DesktopLyrics.ShadowY"]], ["0", "2"]);
eq("桌面歌词默认单行", defaults()["DesktopLyrics.Mode"], "single");
eq("桌面歌词默认单行居中", defaults()["DesktopLyrics.SingleCenter"], "True");
eq("桌面歌词颜色默认档", defaults()["DesktopLyrics.ColorMode"], "default");
eq("桌面歌词自定义色默认白", defaults()["DesktopLyrics.Color"], "#ffffff");
eq("桌面歌词行数拒绝瞎写", writeValues({ "DesktopLyrics.Mode": "triple" }), []);
eq("桌面歌词颜色档拒绝瞎写", writeValues({ "DesktopLyrics.ColorMode": "rainbow" }), []);
eq("桌面歌词自定义色拒绝非 HEX", writeValues({ "DesktopLyrics.Color": "red" }), []);
eq("桌面歌词自定义色接受 HEX", writeValues({ "DesktopLyrics.Color": "#19c2d8" }).length, 1);
eq("桌面歌词坐标默认未记忆", defaults()["DesktopLyrics.X"], "");
eq("桌面歌词拒绝瞎写的字号", writeValues({ "DesktopLyrics.Scale": "9" }), []);
eq("桌面歌词接受合法字号", writeValues({ "DesktopLyrics.Scale": "1.3" }).length, 1);
eq("桌面歌词字重拒绝越界", writeValues({ "DesktopLyrics.Weight": "950" }), []);
eq("桌面歌词字重拒绝小数", writeValues({ "DesktopLyrics.Weight": "450.5" }), []);
eq("桌面歌词字重接受任意整数", writeValues({ "DesktopLyrics.Weight": "637" }).length, 1);
eq("桌面歌词字体拒绝 CSS 注入", writeValues({ "DesktopLyrics.Font": "x; } body{display:none" }), []);
eq("桌面歌词字体接受独立字体列表", writeValues({ "DesktopLyrics.Font": "\"LXGW WenKai\", serif" }).length, 1);
eq("桌面歌词描边拒绝越界", writeValues({ "DesktopLyrics.Border": "9" }), []);
eq("桌面歌词描边接受 0（无描边）", writeValues({ "DesktopLyrics.Border": "0" }).length, 1);
eq("桌面歌词阴影模糊拒绝越界", writeValues({ "DesktopLyrics.ShadowBlur": "40" }), []);
eq("桌面歌词阴影模糊接受 0（硬边）", writeValues({ "DesktopLyrics.ShadowBlur": "0" }).length, 1);
eq("桌面歌词阴影不透明度拒绝越界", writeValues({ "DesktopLyrics.ShadowOpacity": "2" }), []);
eq("桌面歌词阴影偏移接受负值", writeValues({ "DesktopLyrics.ShadowX": "-12", "DesktopLyrics.ShadowY": "12" }).length, 2);
eq("桌面歌词阴影开关拒绝瞎写", writeValues({ "DesktopLyrics.Shadow": "maybe" }), []);
eq("桌面歌词接受负坐标（多屏副屏在左）", writeValues({ "DesktopLyrics.X": "-1920" }).length, 1);
eq("繁简档拒绝瞎写", writeValues({ "Lyrics.ChineseConvert": "both" }), []);
eq("繁简档接受三档", writeValues({ "Lyrics.ChineseConvert": "simplified" }).length, 1);
eq("繁简档拒绝简转繁以外的乱写回落", (() => { writeValues({ "Lyrics.ChineseConvert": "traditional" }); return readValues().values["Lyrics.ChineseConvert"]; })(), "traditional");
eq("TTML 地址缺 %s 被拒", writeValues({ "Lyrics.TtmlDatabase": "https://x.example/%p.lyric" }), []);
eq("TTML 地址非 http(s) 被拒", writeValues({ "Lyrics.TtmlDatabase": "ftp://x.example/%s.ttml" }), []);
eq("TTML 地址带空格被拒", writeValues({ "Lyrics.TtmlDatabase": "https://x.example/a b/%s.ttml" }), []);
eq("TTML 合法模板可写入", writeValues({ "Lyrics.TtmlDatabase": "https://mirror.example/%p/%s.ttml" }).length, 1);
eq("在线 TTML 布尔档拒绝瞎写", writeValues({ "Lyrics.OnlineTtml": "maybe" }), []);
eq("宽度键拒绝非数值", writeValues({ "Window.SidebarWidth": "wide" }), []);
eq("宽度键拒绝超界", writeValues({ "Window.SidebarWidth": "99999", "Window.QueueWidth": "-3" }), []);
eq("宽度键接受合法值与空值", writeValues({ "Window.SidebarWidth": "260", "Window.QueueWidth": "" }), ["Window.SidebarWidth", "Window.QueueWidth"]);

// ——— 默认主题的背景（模式 / 自定义图路径 / 模糊强度）———
eq("背景默认关闭（只有主题底色）", defaults()["Style.Background"], "off");
eq("背景图默认未选择", defaults()["Style.BackgroundImage"], "");
eq("背景模糊默认 70px", defaults()["Style.BackgroundBlur"], "70");
eq("背景模式拒绝瞎写", writeValues({ "Style.Background": "wallpaper" }), []);
eq("背景模式接受关闭", writeValues({ "Style.Background": "off" }), ["Style.Background"]);
eq("背景模式接受自定义", writeValues({ "Style.Background": "custom" }), ["Style.Background"]);
eq("背景模式回到默认", writeValues({ "Style.Background": "cover" }), ["Style.Background"]);
eq("背景图接受 Windows 绝对路径（反斜杠不特殊）", writeValues({ "Style.BackgroundImage": "C:\\Users\\me\\Pictures\\bg.jpg" }), ["Style.BackgroundImage"]);
eq("背景图路径含空格与引号也能存", writeValues({ "Style.BackgroundImage": "/home/me/my pics/it's.jpg" }), ["Style.BackgroundImage"]);
eq("背景图路径拒绝换行（会把 INI 段结构撕开）", writeValues({ "Style.BackgroundImage": "a.jpg\n[Evil]\nx=1" }), []);
eq("背景图路径允许清空（= 未选择）", writeValues({ "Style.BackgroundImage": "" }), ["Style.BackgroundImage"]);
eq("模糊强度拒绝超界", writeValues({ "Style.BackgroundBlur": "500" }), []);
eq("模糊强度拒绝非数值", writeValues({ "Style.BackgroundBlur": "很糊" }), []);
eq("模糊强度接受 0（原图不模糊）", (writeValues({ "Style.BackgroundBlur": "0" }), readValues().values["Style.BackgroundBlur"]), "0");
eq("模糊强度回到默认", writeValues({ "Style.BackgroundBlur": "70" }), ["Style.BackgroundBlur"]);
eq("非法布尔值被拒绝（侧栏缩回）", writeValues({ "Window.SidebarCollapsed": "maybe" }), []);
eq("合法布尔值写入（侧栏缩回）", writeValues({ "Window.SidebarCollapsed": "True" }), ["Window.SidebarCollapsed"]);
eq("非法音量被拒绝", writeValues({ "Playing.Volume": "1.5" }), []);
eq("非法音量被拒绝（负数）", writeValues({ "Playing.Volume": "-0.1" }), []);
eq("空音量被拒绝（Number('')===0 的坑）", writeValues({ "Playing.Volume": "" }), []);
eq("合法音量写入", writeValues({ "Playing.Volume": "0.35" }), ["Playing.Volume"]);
eq("非法布尔值被拒绝（上一首逻辑）", writeValues({ "Playing.PrevReplay": "maybe" }), []);
eq("合法布尔值写入（上一首逻辑）", writeValues({ "Playing.PrevReplay": "False" }), ["Playing.PrevReplay"]);
writeValues({ "Playing.PrevReplay": "True" }); // 后续断言不受影响，回到默认
eq("非法布尔值被拒绝（睡眠禁止）", writeValues({ "Playing.InhibitSleep": "maybe" }), []);
eq("合法布尔值写入（睡眠禁止）", writeValues({ "Playing.InhibitSleep": "False" }), ["Playing.InhibitSleep"]);
eq("自动检查默认开", defaults()["Update.AutoCheck"], "True");
eq("更新渠道默认 stable", defaults()["Update.Channel"], "stable");
eq("已提醒版本标识默认空", defaults()["Update.LastNotified"], "");
eq("非法更新渠道被拒绝", writeValues({ "Update.Channel": "canary" }), []);
eq("合法更新渠道写入（nightly）", writeValues({ "Update.Channel": "nightly" }), ["Update.Channel"]);
eq("合法更新渠道写入（beta）", writeValues({ "Update.Channel": "beta" }), ["Update.Channel"]);
writeValues({ "Update.Channel": "stable" }); // 后续断言不受影响，回到默认
writeValues({ "Playing.InhibitSleep": "True" }); // 后续断言不受影响，回到默认

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
