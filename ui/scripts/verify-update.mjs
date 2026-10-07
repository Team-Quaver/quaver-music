// Quaver — 应用自更新纯逻辑单测（纯 Node，不需要浏览器/Electron）。
// ui/src/lib/update-core.ts 是版本解析/比较、安装包匹配、release notes 渲染的唯一真相，
// 这里用 vite build 打包后直接跑断言 —— 改比较规则先来这补用例。
// 跑： node scripts/verify-update.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const UI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = mkdtempSync(join(tmpdir(), "quaver-upd-"));
const OUT = join(OUT_DIR, "bundle.mjs");

// 临时入口：update-core 是纯逻辑（无 DOM / 无桥），单文件 lib 打包即可
writeFileSync(join(OUT_DIR, "entry.ts"), `export * from ${JSON.stringify(join(UI_ROOT, "src/lib/update-core.ts"))};`);

const res = await viteBuild({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    target: "esnext",
    minify: false,
    lib: { entry: join(OUT_DIR, "entry.ts"), formats: ["es"], fileName: () => "bundle.mjs" },
  },
});
const chunk = res[0].output.find((o) => o.type === "chunk");
writeFileSync(OUT, chunk.code);
const C = await import(OUT);

let failed = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
const check = (name, ok, extra = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${!ok && extra ? ` — ${extra}` : ""}`); if (!ok) failed++; };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** release fixture：assets 传 [文件名, 大小] */
const rel = (tag, assets = [], extra = {}) => ({
  tag, name: tag, prerelease: false, publishedAt: "2026-10-07T02:00:00Z", body: "", ...extra,
  assets: assets.map(([name, size]) => ({ name, size, url: `https://github.com/x/releases/download/${tag}/${name}` })),
});

// ——— 版本解析 ———
section("版本解析");
eq("纯 semver", C.parseVersion("1.2.3"), { semver: [1, 2, 3], sha: "", nightly: false });
eq("容忍 v 前缀（git describe 态的 __APP_VERSION__）", C.parseVersion("v1.2.3"), { semver: [1, 2, 3], sha: "", nightly: false });
eq("nightly 完整形态（resolve-version 输出）", C.parseVersion("1.2.0-abc1234-nightly"), { semver: [1, 2, 0], sha: "abc1234", nightly: true });
eq("nightly 产物名形态（无 -nightly 后缀）", C.parseVersion("1.2.0-abc1234"), { semver: [1, 2, 0], sha: "abc1234", nightly: true });
check("非版本串返回 null", C.parseVersion("nightly") === null && C.parseVersion("") === null);
eq("展示规范化去 v", C.normalizeVersion("v1.2.2"), "1.2.2");
check("1.2.10 > 1.2.9（数值比较不是字符串）", C.cmpSemver([1, 2, 10], [1, 2, 9]) > 0);
check("2.0.0 > 1.99.99", C.cmpSemver([2, 0, 0], [1, 99, 99]) > 0);
eq("相等", C.cmpSemver([1, 2, 3], [1, 2, 3]), 0);

// ——— 更新判定：stable ———
section("stable 渠道判定");
{
  const d = C.decideUpdate("1.2.0", "stable", C.normalizeRelease({ tag_name: "v1.2.3" }));
  check("低版本 → 有更新", d.available === true && d.latestDisplay === "v1.2.3" && d.key === "stable:v1.2.3", JSON.stringify(d));
  check("同版本 → 无更新", C.decideUpdate("1.2.3", "stable", C.normalizeRelease({ tag_name: "v1.2.3" })).available === false);
  check("回滚（当前更高）→ 无更新", C.decideUpdate("1.2.4", "stable", C.normalizeRelease({ tag_name: "v1.2.3" })).available === false);
  check("nightly 构建切回 stable：更高正式版仍提示", C.decideUpdate("1.2.4-abc1234-nightly", "stable", C.normalizeRelease({ tag_name: "v1.3.0" })).available === true);
  check("nightly 构建 ≥ 同版号正式版 → 不提示", C.decideUpdate("1.2.4-abc1234-nightly", "stable", C.normalizeRelease({ tag_name: "v1.2.4" })).available === false);
  check("坏 tag → error", "error" in C.decideUpdate("1.2.0", "stable", C.normalizeRelease({ tag_name: "not-a-version" })));
}

// ——— 更新判定：nightly ———
section("nightly 渠道判定");
{
  const assets = [["Quaver-1.2.0-bbb2222-x86_64.AppImage", 100], ["Quaver-1.2.0-bbb2222-aarch64.AppImage", 100]];
  const r = C.normalizeRelease({ tag_name: "nightly", prerelease: true, published_at: "2026-10-07T02:00:00Z", assets: assets.map(([n, s]) => ({ name: n, size: s, browser_download_url: `https://x/${n}` })) });
  const d = C.decideUpdate("1.2.0-aaa1111-nightly", "nightly", r);
  check("同版号不同 sha → 有新构建", d.available === true, JSON.stringify(d));
  check("nightly 展示认渠道不造版本号", d.latestDisplay === "Nightly", d.latestDisplay);
  check("构建时间透传（published_at）", d.latestDate === "2026-10-07T02:00:00Z");
  eq("跳过键含构建身份", d.key, "nightly:1.2.0-bbb2222");
  check("同 sha → 无更新", C.decideUpdate("1.2.0-bbb2222-nightly", "nightly", r).available === false);
  check("更高版号 → 有更新", C.decideUpdate("1.2.0-aaa1111-nightly", "nightly", C.normalizeRelease({ tag_name: "nightly", assets: [{ name: "Quaver-1.2.1-bbb2222-x86_64.AppImage", size: 1, browser_download_url: "https://x/1" }] })).available === true);
  check("回滚（更高版号本地构建）→ 无更新", C.decideUpdate("1.2.2-aaa1111-nightly", "nightly", r).available === false);
  check("stable 构建跑 nightly 渠道：同版号 nightly 也提示", C.decideUpdate("1.2.0", "nightly", r).available === true);
  check("产物解析不出构建标识 → error", "error" in C.decideUpdate("1.2.0", "nightly", C.normalizeRelease({ tag_name: "nightly", assets: [{ name: "README.txt", size: 1, browser_download_url: "https://x/1" }] })));
}

// ——— 安装包匹配（平台 × 架构；CI 产物命名见 build.yml）———
section("安装包匹配");
{
  const full = [
    ["Quaver-1.2.3-x86_64.AppImage", 1],
    ["Quaver-1.2.3-aarch64.AppImage", 1],
    ["Quaver-1.2.3-x64.exe", 1],
    ["Quaver-1.2.3-arm64.exe", 1],
    ["Quaver-1.2.3-arm64.dmg", 1],
    ["Quaver-1.2.3-loong64.deb", 1],
  ];
  const A = (list) => C.normalizeRelease({ tag_name: "v1", assets: list.map(([n, s]) => ({ name: n, size: s, browser_download_url: `https://x/${n}` })) }).assets;
  eq("linux x64 → x86_64 AppImage", C.pickAsset("linux", "x64", A(full))?.asset.name, "Quaver-1.2.3-x86_64.AppImage");
  eq("linux arm64 → aarch64 AppImage", C.pickAsset("linux", "arm64", A(full))?.asset.name, "Quaver-1.2.3-aarch64.AppImage");
  eq("linux loong64 → deb", C.pickAsset("linux", "loong64", A(full))?.asset.name, "Quaver-1.2.3-loong64.deb");
  eq("loongarch64 同义命名也认", C.pickAsset("linux", "loong64", A([["Quaver-1.2.3-loongarch64.deb", 1]]))?.asset.name, "Quaver-1.2.3-loongarch64.deb");
  eq("win32 x64 → x64 exe", C.pickAsset("win32", "x64", A(full))?.asset.name, "Quaver-1.2.3-x64.exe");
  eq("win32 arm64 → arm64 exe", C.pickAsset("win32", "arm64", A(full))?.asset.name, "Quaver-1.2.3-arm64.exe");
  eq("darwin arm64 → dmg", C.pickAsset("darwin", "arm64", A(full))?.asset.name, "Quaver-1.2.3-arm64.dmg");
  check("darwin x64 无产物（构建已裁撤）→ null", C.pickAsset("darwin", "x64", A(full)) === null);
  check("linux x64 不误配 loong64 deb", C.pickAsset("linux", "x64", A([["Quaver-1.2.3-loong64.deb", 1]])) === null);
  check("无匹配 → null", C.pickAsset("linux", "x64", A([["latest.yml", 1]])) === null);
}

// ——— release notes 迷你渲染（第三方内容，注入面必须为零）———
section("更新日志渲染");
{
  const md = [
    "# What's Changed",
    "## 新功能",
    "- 支持 **自动更新**，详见 [发布页](https://github.com/team-quaver/quaver-music/releases)",
    "- 裸链接 https://example.com/a 和行内代码 `cfg(\"x\")`",
    "",
    "```bash",
    "echo \"**不渲染**\"",
    "```",
  ].join("\n");
  const html = C.renderNotes(md);
  check("标题", html.includes("<h4>What&#39;s Changed</h4>"), html);
  check("列表", html.includes("<li>"), html);
  check("粗体", html.includes("<b>自动更新</b>"), html);
  check("显式链接", html.includes('href="https://github.com/team-quaver/quaver-music/releases"'), html);
  check("裸链接", html.includes(">https://example.com/a</a>"), html);
  check("行内代码", html.includes("<code>cfg(&quot;x&quot;)</code>"), html);
  check("围栏代码块整体转义", html.includes("echo &quot;**不渲染**&quot;"), html);
  check("HTML 注入被转义", C.renderNotes("<script>alert(1)</script>").includes("<script>") === false);
  check("javascript: 链接不生成 <a>", C.renderNotes("[点我](javascript:alert(1))").includes("<a ") === false, C.renderNotes("[点我](javascript:alert(1))"));
  // 文本节点里允许出现转义后的 onmouseover 字样；<a> 属性里绝不允许
  const hostile = C.renderNotes('[x](https://a" onmouseover="alert(1))');
  const anchors = hostile.match(/<a [^>]*>/g) ?? [];
  check("事件句柄注入不进 <a> 属性", anchors.length > 0 && anchors.every((a) => !a.includes("onmouseover")), anchors.join(" | "));
  check("图片渲染（release 截图）", C.renderNotes("![截图](https://user-images.githubusercontent.com/u/1/a.png)")
    .includes('<img src="https://user-images.githubusercontent.com/u/1/a.png" alt="截图"'), C.renderNotes("![截图](https://user-images.githubusercontent.com/u/1/a.png)"));
  check("非 http(s) 图片不生成 <img>", C.renderNotes("![x](javascript:alert(1))").includes("<img") === false);
  check("HTML <img> 标签渲染（GitHub 手写截图）", (() => {
    const h = C.renderNotes('<img src="https://github.com/user-attachments/assets/abc" width="360" alt="截图">');
    return h.includes('src="https://github.com/user-attachments/assets/abc"')
      && h.includes('width="360"') && h.includes('alt="截图"') && h.includes('loading="lazy"') && h.includes("<img ");
  })());
  check("非 https 的 HTML img 丢弃", C.renderNotes('<img src="http://a.b/x.png">').includes("<img") === false);
  check("HTML img 事件属性被丢弃", C.renderNotes('<img src="https://a.b/x.png" onerror="alert(1)">').includes("onerror") === false);
  check("HTML img 非法宽高被丢弃", !C.renderNotes('<img src="https://a.b/x.png" width="100)alert(1)">').includes("100)"));
  {
    const q = C.renderNotes("> 注意这是**引用**\n> 第二行\n\n正文");
    check("引用块", q.includes("<blockquote><p>注意这是<b>引用</b></p><p>第二行</p></blockquote>"), q);
    check("引用后接段落", q.trimEnd().endsWith("<p>正文</p>"), q);
  }
  check("空 body 有占位", C.renderNotes("").includes("没有填写更新说明"));
}

console.log(failed ? `\n${failed} 项断言失败` : "\n全部通过");
process.exit(failed ? 1 : 0);

// 清理（放不到 finally 就手动跑；失败时保留现场也无妨）
process.on("exit", () => { try { rmSync(OUT_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ } });
