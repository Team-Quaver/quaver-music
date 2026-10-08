// Quaver — 应用身份与图标（package.json 身份链 + electron/linux-desktop.ts + electron/tray-icon.ts）单测与源码护栏。
// 跑：  node scripts/verify-icon.ts
//
// 背景：桌面环境按 app_id（red.0w0.quaver）反查 <ID>.desktop → Icon= → 图标主题。这条链上任何
// 一环写岔（desktop 文件名与 app_id 不一致、Icon 撞上图标主题的通配名、打包漏配 icon），表现都是
// 「某个桌面显示错图/兜底图」，而且每个桌面表现还不一样，从 UI 上无从排查。所以这里两头抓：
//   • 源码/配置护栏：身份真相只允许在 package.json（desktopName / linux.executableName / appId /
//     mac.executableName），几处必须逐字对齐；主进程不得再手工 setDesktopName；三平台 icon 配置、
//     macOS 可执行名、托盘图素材与尺寸口径必须齐。
//   • 功能测试：linux-desktop 自装逻辑用临时目录当 XDG root 真写真读（全新安装 / 幂等 / 收编坏
//     文件 / 对集成工具的条目让位）；托盘图的 PNG 产物与 SVG 设计源逐像素核对（主色 + 形状）。
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  DESKTOP_ID, desktopEntryContent, installLinuxDesktopIntegration, quoteExecPath,
  readDesktopEntryValue, readDesktopHidden, readDesktopIcon, xdgDataHome,
} from "../electron/linux-desktop.ts";
import { TRAY_ICON_FILES, TRAY_ICON_PT, trayIconFile } from "../electron/tray-icon.ts";

let pass = 0, fail = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/**
 * 最小 PNG 解码（8bit 非隔行，RGB/RGBA）——只为了能核对「PNG 与 SVG 的主色/形状是否还对得上」。
 * 托盘素材是设计源（SVG）的光栅化产物，改了 SVG 忘了重新导出，只有像素能证明。
 * @returns {{width:number, height:number, ch:number, px:Buffer}|null} px = RGBA 逐像素
 */
function decodePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  let p = 8, ihdr = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len; // len + type(4) + data + crc(4)
  }
  // 只支持本项目导出的那几种：8bit、不隔行、RGB(2)/RGBA(6)
  if (!ihdr || ihdr.depth !== 8 || ihdr.interlace !== 0 || ![2, 6].includes(ihdr.color)) return null;
  const ch = ihdr.color === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * ch;
  const out = Buffer.alloc(ihdr.width * ihdr.height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;          // 左
      const b = prev[i];                             // 上
      const c = i >= ch ? prev[i - ch] : 0;          // 左上
      if (filter === 1) line[i] = (line[i] + a) & 0xff;
      else if (filter === 2) line[i] = (line[i] + b) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 0xff;
      }
    }
    for (let x = 0; x < ihdr.width; x++) {
      const s = x * ch, d = (y * ihdr.width + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = ch === 4 ? line[s + 3] : 0xff;
    }
    prev = line;
  }
  return { width: ihdr.width, height: ihdr.height, ch, px: out };
}

/** 取 SVG 里出现最多的 fill 色（本项目这些素材是单色图形）→ "#rrggbb" 小写；没有返回 null */
function svgFill(text) {
  const count = new Map();
  for (const m of text.matchAll(/fill:\s*(#[0-9a-fA-F]{6})/g)) {
    const c = m[1].toLowerCase();
    count.set(c, (count.get(c) ?? 0) + 1);
  }
  let best = null;
  for (const [c, n] of count) if (!best || n > count.get(best)) best = c;
  return best;
}

/** 不透明像素里出现最多的颜色 → "#rrggbb"；顺带给出不透明占比、alpha 掩码与图形包围盒 */
function opaqueStats(img) {
  const count = new Map();
  const mask = Buffer.alloc(img.width * img.height);
  let opaque = 0;
  let x0 = img.width, x1 = -1, y0 = img.height, y1 = -1;
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.px[i * 4 + 3] <= 128) continue;
    opaque++; mask[i] = 1;
    const x = i % img.width, y = (i - x) / img.width;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    const c = "#" + img.px.subarray(i * 4, i * 4 + 3).toString("hex");
    count.set(c, (count.get(c) ?? 0) + 1);
  }
  let best = null;
  for (const [c, n] of count) if (!best || n > count.get(best)) best = c;
  const w = Math.max(0, x1 - x0 + 1), h = Math.max(0, y1 - y0 + 1);
  return {
    color: best, opaque, mask,
    ratio: opaque / (img.width * img.height),
    bbox: { x0, y0, w, h, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 },
  };
}

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
check("extraResources 打包 build-res/tray（托盘图素材，主进程按 build-res 相对路径取）",
  (pkg.build?.extraResources ?? []).some((r) => r.from === "build-res/tray" && r.to === "build-res/tray"));
check("extraResources 里不再有 tray.png（旧的那张 512² 直塞 Tray 就是 mac 上「图标巨大」的成因）",
  !(pkg.build?.extraResources ?? []).some((r) => String(r.from).includes("tray.png")));

// ——— macOS 可执行名 ———
section("macOS 可执行名 = Quaver Music");
// app-builder-lib 的 AppInfo：productFilename = 平台配置的 executableName ?? 顶层 executableName ?? productName；
// .app 目录名与 CFBundleExecutable 都取 productFilename。顶层留着 quaver（Windows 侧现状不动），
// mac 必须单独覆盖 —— 否则装出来是 quaver.app / Contents/MacOS/quaver。
eq("mac.executableName = Quaver Music", pkg.build?.mac?.executableName, "Quaver Music");
eq("顶层 executableName 保持 quaver（Windows 不动）", pkg.build?.executableName, "quaver");
eq("productName 仍是 Quaver Music（CFBundleName / 菜单栏名 / 提示语）", pkg.build?.productName, "Quaver Music");

// ——— 主进程源码护栏 ———
section("main.ts 源码护栏");
const mainSrc = readFileSync(join(UI, "electron", "main.ts"), "utf8");
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

// ——— 托盘图标 ———
section("托盘图标：尺寸口径 + 明暗素材 + 接线");
eq("逻辑尺寸统一 16pt（mac 菜单栏 / win 通知区 / linux SNI 的通用档位）", TRAY_ICON_PT, 16);
eq("深色外壳配浅色图标", trayIconFile("dark"), TRAY_ICON_FILES.dark);
eq("浅色外壳配深色图标", trayIconFile("light"), TRAY_ICON_FILES.light);
eq("外观判不出来时按深色处理（浅色图标在两种底色上都能看）", trayIconFile(null), TRAY_ICON_FILES.dark);
check("两份素材是两个不同的文件", TRAY_ICON_FILES.dark !== TRAY_ICON_FILES.light);

// SVG（设计源）与它的光栅化产物必须还对得上：改了 SVG 忘了重新导出，只有像素能证明
// （重新导出命令见 electron/tray-icon.ts 头部）
const SRC_SVG = { dark: "tray-icon.svg", light: "tray-icon-dark.svg" };
const decoded = {};
for (const [appearance, pngRel] of Object.entries(TRAY_ICON_FILES)) {
  const svgSrc = join(UI, "..", "img", SRC_SVG[appearance]);      // 设计源
  const png = join(UI, "build-res", pngRel);                      // 随包产物
  const svgPacked = join(UI, "build-res", "tray", SRC_SVG[appearance]);   // 随包带上源文件
  check(`${appearance}：设计源 img/${SRC_SVG[appearance]} 在位`, existsSync(svgSrc));
  check(`${appearance}：随包产物 build-res/${pngRel} 在位`, existsSync(png));
  check(`${appearance}：随包也带上 SVG 源（build-res/tray/${SRC_SVG[appearance]}）`, existsSync(svgPacked));
  if (!existsSync(png)) continue;
  const img = decodePng(readFileSync(png));
  if (!img) { check(`${pngRel} 能解码（8bit 非隔行 PNG）`, false, "解不开"); continue; }
  const st = opaqueStats(img);
  decoded[appearance] = st;
  check(`${pngRel} 是正方形 256²（缩到 @2x 的 32 是降采样，不会糊）`,
    img.width === 256 && img.height === 256 && img.width >= TRAY_ICON_PT * 2, `${img.width}x${img.height}`);
  check(`${pngRel} 保留透明通道（图形带 alpha，不是白底方块）`,
    st.ratio > 0.02 && st.ratio < 0.9, `不透明占比 ${(st.ratio * 100).toFixed(1)}%`);
  // 设计稿自带 ~22%/边空白，直出会只剩 ~56% 实形（16pt 盒子里约 9px，报过「小了一点点」）
  // → 必须走 gen-tray-icons.sh 的裁边流程；这条断言就是防「哪天直接 inkscape 导出一份」。
  const fill = Math.max(st.bbox.w, st.bbox.h) / img.width;
  check(`${pngRel} 已裁边（图形占画布 ≥82%，不是留着设计稿空白直出）`,
    fill >= 0.82 && fill <= 0.99, `图形占画布 ${(fill * 100).toFixed(0)}%`);
  const off = Math.max(Math.abs(st.bbox.cx - img.width / 2), Math.abs(st.bbox.cy - img.height / 2));
  check(`${pngRel} 图形在画布居中（偏心会让托盘看着没对齐）`, off <= img.width * 0.03, `偏心 ${off.toFixed(1)}px`);
  const fillColor = existsSync(svgSrc) ? svgFill(readFileSync(svgSrc, "utf8")) : null;
  check(`${pngRel} 是单色图形且主色与 SVG 一致`, st.color !== null && st.color === fillColor,
    `png ${st.color} vs svg ${fillColor}`);
  const rgb = st.color ? [1, 3, 5].map((i) => parseInt(st.color.slice(i, i + 2), 16)) : null;
  const luma = rgb ? rgb.reduce((a, b) => a + b, 0) / 3 : 0;
  check(`${pngRel} 明暗与用途相符（${appearance === "dark" ? "深色外壳 → 浅色图形" : "浅色外壳 → 深色图形"}）`,
    appearance === "dark" ? luma > 127 : luma < 128, `主色亮度 ${luma.toFixed(0)}`);
}
if (decoded.dark && decoded.light) {
  check("两份素材形状一致（同一份图形只换了颜色，不是各画一套）",
    decoded.dark.mask.equals(decoded.light.mask));
}
check("build-res/tray 下没有留下 tray.png", !existsSync(join(UI, "build-res", "tray", "tray.png")));

check("主进程不再硬编码旧托盘图（tray.png）", !mainSrc.includes("tray.png"));
check("主进程经 tray-icon.ts 挑素材（明暗映射只有一份真相）",
  /const appearance = trayAppearance\(\)/.test(mainSrc) && /trayIconFile\(appearance\)/.test(mainSrc));
check("判据结果进日志（外壳=… → 哪份素材）：外壳底色判错时只看日志就能定位",
  /tray icon: 外壳=\$\{appearance\}/.test(mainSrc));
check("托盘图按逻辑尺寸 resize（不 resize 就是 mac 上「图标巨大」的成因）",
  /resize\(\{\s*width:\s*px,\s*height:\s*px/.test(mainSrc));
check("附了 @2x 位图（高 DPI 菜单栏不糊）", /addRepresentation\(\{\s*scaleFactor:\s*2/.test(mainSrc));
// 这条是踩过的坑：拿 nativeTheme 当判据 → 被应用主题（默认 dark）钉死 → 系统切浅色后图标看不见
check("外壳外观按平台取「系统给外壳的颜色」：Linux 探测 / mac 读系统设置 / win 系统集成档",
  /readSystemTheme\(\)/.test(mainSrc) && /readMacShellTheme\(\)/.test(mainSrc)
    && /shouldUseDarkColorsForSystemIntegratedUI/.test(mainSrc));
check("托盘判据不直接吃 nativeTheme.shouldUseDarkColors 当主判据（只能是最后的兜底）",
  !/readSystemTheme\(\)\s*\?\?\s*nativeTheme\.shouldUseDarkColors/.test(mainSrc));
check("系统配色变化会刷新托盘图（nativeTheme.updated / Linux watchSystemTheme / mac watchMacShellTheme 三条都接）",
  /nativeTheme\.on\("updated",\s*\(\)\s*=>\s*refreshTrayImage\(\)\)/.test(mainSrc)
    && /watchSystemTheme\(\(\) => \{[\s\S]{0,240}refreshTrayImage\(\)/.test(mainSrc)
    && /watchMacShellTheme\(\(\) => refreshTrayImage\(\)\)/.test(mainSrc));
check("裁边生成脚本在位（PNG 不是直接导出的那份空白稿）",
  existsSync(join(UI, "scripts", "gen-tray-icons.sh")));

// ——— linux-desktop.ts 功能测试 ———
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
    "X-Quaver-Managed=true",
  ].join("\n") + "\n");
check("条目必须可见（NoDisplay/Hidden 会让 Noctalia 整条丢弃 → app_id 丢图标，#4626）",
  !/^\s*(NoDisplay|Hidden)\s*=/mi.test(entry));
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
check("既有条目内容原样保留（没被加 NoDisplay）", readFileSync(desktopFile, "utf8") === integrated);

// 隐藏条目不能让位：NoDisplay/Hidden 的条目 Noctalia 整条丢弃（#4626），Icon 对了也没用，必须收编成可见
for (const [label, hideLine] of [["NoDisplay", "NoDisplay=true"], ["Hidden", "Hidden=true"]]) {
  const hidden = `[Desktop Entry]\nType=Application\nName=Quaver Music\nExec=appimage %U\nIcon=red.0w0.quaver\n${hideLine}\n`;
  writeFileSync(desktopFile, hidden);
  const rh = await installLinuxDesktopIntegration(spec);
  eq(`被 ${label} 藏起来的条目不被让位（收编改写）`, rh.desktopAction, "written");
  check(`收编后条目可见（无 ${label}）`, !readDesktopHidden(readFileSync(desktopFile, "utf8")));
  check("收编后 Icon 仍指向我们的图标名", readDesktopIcon(readFileSync(desktopFile, "utf8")) === DESKTOP_ID);
}

eq("readDesktopHidden 识别 NoDisplay=true", readDesktopHidden("[Desktop Entry]\nNoDisplay=true\n"), true);
eq("readDesktopHidden 识别 Hidden=1", readDesktopHidden("[Desktop Entry]\nHidden=1\n"), true);
eq("readDesktopHidden 识别 yes", readDesktopHidden("[Desktop Entry]\nHidden=yes\n"), true);
eq("readDesktopHidden 对 NoDisplay=false 不误报", readDesktopHidden("[Desktop Entry]\nNoDisplay=false\n"), false);
eq("readDesktopHidden 只认 Desktop Entry 段", readDesktopHidden("[Desktop Action X]\nNoDisplay=true\n"), false);

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
  readFileSync(join(UI, "electron", "linux-desktop.ts"), "utf8").includes("gtk-update-icon-cache"));

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
console.log(`\n${fail === 0 ? "✅" : "❌"} verify-icon: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
