// Quaver — 应用身份与图标（package.json 身份链 + electron/linux-desktop.mjs）单测与源码护栏。
// 跑：  node scripts/verify-icon.mjs
//
// 背景：桌面环境按 app_id（red.0w0.quaver）反查 <ID>.desktop → Icon= → 图标主题。这条链上任何
// 一环写岔（desktop 文件名与 app_id 不一致、Icon 撞上图标主题的通配名、打包漏配 icon），表现都是
// 「某个桌面显示错图/兜底图」，而且每个桌面表现还不一样，从 UI 上无从排查。所以这里两头抓：
//   • 源码/配置护栏：身份真相只允许在 package.json（desktopName / linux.executableName / appId），
//     三处必须逐字对齐；主进程不得再手工 setDesktopName；三平台 icon 配置与素材必须齐。
//   • 功能测试：linux-desktop 自装逻辑用临时目录当 XDG root 真写真读（全新安装 / 幂等 / 收编坏
//     文件 / 对集成工具的条目让位）。
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_ID, desktopEntryContent, installLinuxDesktopIntegration, quoteExecPath, readDesktopIcon, xdgDataHome,
} from "../electron/linux-desktop.mjs";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const UI = join(import.meta.dirname, "..");

// ——— 身份真相：package.json ———
section("package.json 身份链");
const pkg = JSON.parse(readFileSync(join(UI, "package.json"), "utf8"));
const appId = pkg.build?.appId;
eq("appId", appId, "red.0w0.quaver");
eq("desktopName = <appId>.desktop（Electron init 经 CHROME_DESKTOP 生成 app_id/WM_CLASS）",
  pkg.desktopName, `${appId}.desktop`);
eq("name = appId", pkg.name, appId);
eq("linux.executableName = appId（AppImage 内二进制名 = desktop 文件名 = Icon 名，三方只能同源）",
  pkg.build?.linux?.executableName, appId);
eq("linux.icon 指向多尺寸图标集", pkg.build?.linux?.icon, "build-res/icons");
check("win.icon 已配（electron-builder 以 png 自动转 ico，缺省就是 Electron 默认图标）",
  pkg.build?.win?.icon === "build-res/icon.png");
check("mac.icon 已配（同上自动转 icns）", pkg.build?.mac?.icon === "build-res/icon.png");
check("extraResources 打包 build-res/icons（运行时 hicolor 自装的素材来源）",
  (pkg.build?.extraResources ?? []).some((r) => r.from === "build-res/icons" && r.to === "build-res/icons"));

// ——— 主进程源码护栏 ———
section("main.mjs 源码护栏");
const mainSrc = readFileSync(join(UI, "electron", "main.mjs"), "utf8");
check("主进程不再调用 setDesktopName（真相唯一在 package.json；两处赋值迟早写岔。注释提到 API 名不算）",
  !/\bsetDesktopName\s*\(/.test(mainSrc));
check("whenReady 接了 linux-desktop 自装", mainSrc.includes("installLinuxDesktopIntegration"));
check("BrowserWindow 仍带 X11 窗口图标", /icon:\s*buildRes\("icon\.png"\)/.test(mainSrc));

// ——— 图标素材 ———
section("build-res/icons 素材");
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
for (const s of ICON_SIZES) {
  const p = join(UI, "build-res", "icons", `${s}x${s}.png`);
  if (!existsSync(p)) { check(`${s}x${s}.png 存在`, false, "缺文件"); continue; }
  const buf = readFileSync(p);
  // PNG 签名 8 字节 + IHDR 头 8 字节 → 宽高分别在 16/20（大端）
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  check(`${s}x${s}.png 尺寸属实（IHDR ${w}x${h}）`, w === s && h === s && buf.readUInt32BE(12) === 0x49484452);
}

// ——— linux-desktop.mjs 功能测试 ———
section("desktopEntryContent / 引号 / 解析");
const entry = desktopEntryContent({
  desktopId: "red.0w0.quaver", name: "Quaver Music", comment: "又一个第三方 QQ 音乐客户端",
  exec: '"/opt/Quaver Music" --no-sandbox %U',
});
check("键序固定（幂等比对的确定性来源）",
  entry === [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Quaver Music",
    "Comment=又一个第三方 QQ 音乐客户端",
    'Exec="/opt/Quaver Music" --no-sandbox %U',
    "Icon=red.0w0.quaver",
    "Terminal=false",
    "Categories=AudioVideo;Audio;",
    "StartupWMClass=red.0w0.quaver",
    "NoDisplay=true",
    "X-Quaver-Managed=true",
  ].join("\n") + "\n");
eq("带空格的路径被引号包住", quoteExecPath("/home/u/Applications/Quaver Music"), '"/home/u/Applications/Quaver Music"');
eq("Exec 路径里的引号被转义", quoteExecPath('/a"b'), '"/a\\"b"');
eq("值里的反斜杠按 spec 转义", desktopEntryContent({ desktopId: "x", name: "a\\b", exec: "e" }).includes("Name=a\\\\b"), true);
eq("值里的换行不破结构", desktopEntryContent({ desktopId: "x", name: "a\nb", exec: "e" }).match(/^Name=a\\nb$/m) !== null, true);
eq("readDesktopIcon 命中", readDesktopIcon("[Desktop Entry]\nType=Application\nIcon=audio-x-generic\n"), "audio-x-generic");
eq("readDesktopIcon 大小写不敏感", readDesktopIcon("[Desktop Entry]\n icon = quaver \n"), "quaver");
eq("readDesktopIcon 只认 Desktop Entry 段", readDesktopIcon("[Desktop Action X]\nIcon=a\n[Desktop Entry]\nIcon=b\n"), "b");
eq("readDesktopIcon 无 Icon 返回 null", readDesktopIcon("[Desktop Entry]\nType=Application\n"), null);
eq("xdgDataHome 尊重 XDG_DATA_HOME", xdgDataHome({ XDG_DATA_HOME: "/xdg" }, "/home/u"), "/xdg");
eq("xdgDataHome 默认 ~/.local/share", xdgDataHome({}, "/home/u"), "/home/u/.local/share");

section("自装：全新安装 → 幂等 → 收编 → 让位");
const ROOT = mkdtempSync(join(tmpdir(), "quaver-icon-"));
const dataHome = join(ROOT, "data");
const iconsSrc = join(ROOT, "icons-src");
mkdirSync(join(iconsSrc, "plain"), { recursive: true });
// 素材用真 PNG（尺寸可任意，这里不校验内容合法性）
const tinyPng = Buffer.from(
  "89504e470000000149484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201" +
  "6b6ad2440000000049454e44ae426082", "hex");
for (const s of [16, 32, 512]) writeFileSync(join(iconsSrc, `${s}x${s}.png`), tinyPng);
writeFileSync(join(iconsSrc, "ignored.txt"), "x");

const spec = {
  desktopId: DESKTOP_ID, name: "Quaver Music", comment: "测试", exec: '"/opt/q" %U',
  iconSourceDir: iconsSrc, dataHome, refreshCache: false,
};
const r1 = await installLinuxDesktopIntegration(spec);
const desktopFile = join(dataHome, "applications", `${DESKTOP_ID}.desktop`);
eq("首次安装：desktop 文件落位", r1.desktopFile, desktopFile);
eq("首次安装：动作为 written", r1.desktopAction, "written");
check("首次安装：desktop 内容正确", readFileSync(desktopFile, "utf8") === desktopEntryContent({
  desktopId: DESKTOP_ID, name: "Quaver Music", comment: "测试", exec: '"/opt/q" %U',
}));
eq("首次安装：三个尺寸图标就位",
  [16, 32, 512].every((s) => existsSync(join(dataHome, "icons", "hicolor", `${s}x${s}`, "apps", `${DESKTOP_ID}.png`))), true);
check("非尺寸命名的素材不被拷贝", !existsSync(join(dataHome, "icons", "hicolor", "plain")));

const r2 = await installLinuxDesktopIntegration(spec);
eq("二次安装：幂等（kept，不重写）", r2.desktopAction, "kept");
eq("二次安装：图标零写入（内容一致跳过，不刷 mtime）", r2.iconsWritten, []);
const mtimeAfter2 = statSync(desktopFile).mtimeMs;
await installLinuxDesktopIntegration(spec);
check("三次安装：desktop mtime 未变", statSync(desktopFile).mtimeMs === mtimeAfter2);

// 收编：手写/历史遗留的坏条目（Icon 指向通配名 —— Tela 下就是「音符」图标的那类问题）
const bad = "[Desktop Entry]\nType=Application\nName=Quaver Music\nExec=electron .\nIcon=audio-x-generic\nNoDisplay=true\n";
writeFileSync(desktopFile, bad);
const r3 = await installLinuxDesktopIntegration(spec);
eq("坏 Icon 被收编（改写为正确内容）", r3.desktopAction, "written");
check("收编后 Icon 指向我们的图标名", readDesktopIcon(readFileSync(desktopFile, "utf8")) === DESKTOP_ID);

// 让位：集成工具（AppImageLauncher 等）装的可见条目 Icon 已正确 → 原样保留，避免启动器重复
const integrated = "[Desktop Entry]\nType=Application\nName=Quaver Music\nExec=appimage %U\nIcon=red.0w0.quaver\n";
writeFileSync(desktopFile, integrated);
const r4 = await installLinuxDesktopIntegration(spec);
eq("Icon 已正确的既有条目让位（kept）", r4.desktopAction, "kept");
check("既有条目内容原样保留（NoDisplay 没被加上）", readFileSync(desktopFile, "utf8") === integrated);

// 托管文件漂移：带 X-Quaver-Managed 标记的文件整份强制对齐（Exec 被改坏也要修回来）
const drifted = desktopEntryContent({
  desktopId: DESKTOP_ID, name: "Quaver Music", comment: "测试", exec: '"$HOME/broken" %U',
}).replace('Exec="$HOME/broken" %U', "Exec=$HOME/broken");
writeFileSync(desktopFile, drifted);
const r5 = await installLinuxDesktopIntegration(spec);
eq("托管文件漂移被整份修回（written）", r5.desktopAction, "written");
check("修回后 Exec 恢复正确", readFileSync(desktopFile, "utf8") === desktopEntryContent({
  desktopId: DESKTOP_ID, name: "Quaver Music", comment: "测试", exec: '"/opt/q" %U',
}));

// 素材目录缺失：不抛、desktop 照装（图标走系统 fallback）
const r6 = await installLinuxDesktopIntegration({ ...spec, iconSourceDir: join(ROOT, "nope"), dataHome: join(ROOT, "data2") });
check("素材目录缺失不致命", r6.iconsWritten.length === 0 && r6.desktopAction === "written");

// GTK 缓存：图标有实际写入时必须刷 icon-theme.cache（有 cache 的系统不会自动重扫新文件）
check("图标写入后会触发 gtk-update-icon-cache（GNOME 侧新图标立即可见的前提）",
  readFileSync(join(UI, "electron", "linux-desktop.mjs"), "utf8").includes("gtk-update-icon-cache"));

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-icon: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
