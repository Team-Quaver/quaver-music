// Quaver — 应用自更新纯逻辑单测（纯 Node，不需要浏览器/Electron）。
// ui/src/lib/update-core.ts 是版本解析/比较、安装包匹配、release notes 渲染的唯一真相，
// 这里用 vite build 打包后直接跑断言 —— 改比较规则先来这补用例。
// 末尾还有一段**源码级接线断言**：渠道切换这条链（updater 判定 → 弹窗措辞 → 设置页入口）
// 拆在三个文件里，纯逻辑单测覆盖不到「有没有接上」。
// 跑： node scripts/verify-update.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const has = (src, n) => src.includes(n);
const re = (src, rx) => rx.test(src);
// 注释里提到某个标识符会被 includes 命中（踩过），源码级断言一律先剥注释
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const readSrc = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/** 取 A 到 B 之间的源码（跨函数断言用，避免命中同名的别处） */
const slice = (src, a, b) => {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i);
  return i < 0 || j < 0 ? "" : src.slice(i, j);
};

/** release fixture：assets 传 [文件名, 大小] */
const rel = (tag, assets = [], extra = {}) => ({
  tag, name: tag, prerelease: false, publishedAt: "2026-10-07T02:00:00Z", body: "", ...extra,
  assets: assets.map(([name, size]) => ({ name, size, url: `https://github.com/x/releases/download/${tag}/${name}` })),
});

// ——— 版本解析 ———
section("版本解析");
eq("纯 semver", C.parseVersion("1.2.3"), { semver: [1, 2, 3], pre: "", sha: "", nightly: false, beta: false });
eq("容忍 v 前缀（git describe 态的 __APP_VERSION__）", C.parseVersion("v1.2.3"), { semver: [1, 2, 3], pre: "", sha: "", nightly: false, beta: false });
eq("nightly 完整形态（resolve-version 输出）", C.parseVersion("1.2.0-abc1234-nightly"), { semver: [1, 2, 0], pre: "abc1234-nightly", sha: "abc1234", nightly: true, beta: false });
eq("nightly 产物名形态（无 -nightly 后缀）", C.parseVersion("1.2.0-abc1234"), { semver: [1, 2, 0], pre: "abc1234", sha: "abc1234", nightly: true, beta: false });
eq("beta 带序号", C.parseVersion("v1.5.0-beta.1"), { semver: [1, 5, 0], pre: "beta.1", sha: "", nightly: false, beta: true });
eq("beta 大小写不敏感、无序号也认", C.parseVersion("1.5.0-Beta"), { semver: [1, 5, 0], pre: "beta", sha: "", nightly: false, beta: true });
check("非版本串返回 null", C.parseVersion("nightly") === null && C.parseVersion("") === null);
check("未知 prerelease（rc 等）保守返回 null，不误判成 stable", C.parseVersion("1.2.3-rc1") === null);
eq("展示规范化去 v", C.normalizeVersion("v1.2.2"), "1.2.2");
check("1.2.10 > 1.2.9（数值比较不是字符串）", C.cmpSemver([1, 2, 10], [1, 2, 9]) > 0);
check("2.0.0 > 1.99.99", C.cmpSemver([2, 0, 0], [1, 99, 99]) > 0);
eq("相等", C.cmpSemver([1, 2, 3], [1, 2, 3]), 0);
// prerelease 段比较（semver §11）：正式版 > 预发布；beta.2 > beta.1；数字 < 字母数字
check("正式版 > 预发布", C.cmpPre("", "beta.1") > 0);
check("beta.2 > beta.1", C.cmpPre("beta.2", "beta.1") > 0);
check("beta.10 > beta.9（数值比较）", C.cmpPre("beta.10", "beta.9") > 0);
check("beta > beta.1（同前缀短者更小）", C.cmpPre("beta.1", "beta") > 0);
check("完整版本比较含 prerelease", C.cmpVersion(C.parseVersion("1.5.0-beta.2"), C.parseVersion("1.5.0-beta.1")) > 0);
check("同版号正式版 > beta", C.cmpVersion(C.parseVersion("1.5.0"), C.parseVersion("1.5.0-beta.1")) > 0);

// ——— 更新判定：stable ———
section("stable 渠道判定");
{
  const d = C.decideUpdate("1.2.0", "stable", C.normalizeRelease({ tag_name: "v1.2.3" }));
  check("低版本 → 有更新", d.available === true && d.latestDisplay === "v1.2.3" && d.key === "stable:v1.2.3", JSON.stringify(d));
  check("同版本 → 无更新", C.decideUpdate("1.2.3", "stable", C.normalizeRelease({ tag_name: "v1.2.3" })).available === false);
  check("回滚（当前更高）→ 无更新", C.decideUpdate("1.2.4", "stable", C.normalizeRelease({ tag_name: "v1.2.3" })).available === false);
  check("nightly 构建切回 stable：更高正式版仍提示", C.decideUpdate("1.2.4-abc1234-nightly", "stable", C.normalizeRelease({ tag_name: "v1.3.0" })).available === true);
  check("nightly 构建 ≥ 同版号正式版 → 同渠道升级不提示（换渠道另判，见「渠道切换判定」）", C.decideUpdate("1.2.4-abc1234-nightly", "stable", C.normalizeRelease({ tag_name: "v1.2.4" })).available === false);
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

// ——— 更新判定：beta ———
section("beta 渠道判定");
{
  const betaRel = (tag, opts = {}) => C.normalizeRelease({
    tag_name: tag, prerelease: true, published_at: "2026-10-07T02:00:00Z",
    assets: [{ name: `Quaver-${tag.replace(/^v/, "")}-x86_64.AppImage`, size: 100, browser_download_url: `https://x/${tag}` }],
    ...opts,
  });

  const d = C.decideUpdate("1.4.0", "beta", betaRel("v1.5.0-beta.2"));
  check("正式版 → 更高 beta：有更新", d.available === true && d.relation === "upgrade", JSON.stringify(d));
  eq("beta 展示用版本号", d.latestDisplay, "v1.5.0-beta.2");
  eq("beta 跳过键", d.key, "beta:v1.5.0-beta.2");
  check("beta.2 → beta.1（回退）不提示", C.decideUpdate("1.5.0-beta.2", "beta", betaRel("v1.5.0-beta.1")).available === false);
  check("beta.1 → beta.2（同版号新序号）提示", C.decideUpdate("1.5.0-beta.1", "beta", betaRel("v1.5.0-beta.2")).available === true);
  check("同一份 beta（同 tag）不提示", C.decideUpdate("1.5.0-beta.2", "beta", betaRel("v1.5.0-beta.2")).available === false);
  check("同版号正式版 → beta：同渠道升级不提示（换渠道另判）", C.decideUpdate("1.5.0", "beta", betaRel("v1.5.0-beta.2")).available === false);
  check("nightly 构建 → 更高 beta：顺带升版提示", C.decideUpdate("1.4.0-abc1234-nightly", "beta", betaRel("v1.5.0-beta.2")).available === true);
  check("非 prerelease 的 beta tag → error（必须是预发布）", "error" in C.decideUpdate("1.4.0", "beta", betaRel("v1.5.0-beta.2", { prerelease: false })));
  check("tag 不含 beta → error", "error" in C.decideUpdate("1.4.0", "beta", C.normalizeRelease({ tag_name: "v1.5.0", prerelease: true })));
  check("坏 tag → error", "error" in C.decideUpdate("1.4.0", "beta", betaRel("beta")));
}

// ——— beta 渠道选版（GitHub 没有 latest-prerelease 接口，自己从列表里挑）———
section("beta 渠道选版");
{
  const raw = (tag, prerelease, published = "2026-10-07T02:00:00Z") => ({
    tag_name: tag, prerelease, published_at: published, body: "",
    assets: [{ name: `Quaver-${tag.replace(/^v/, "")}-x86_64.AppImage`, size: 1, browser_download_url: `https://x/${tag}` }],
  });
  const list = [
    raw("v1.5.0", false),                                 // 正式版 → 排除
    raw("nightly", true),                                 // 每夜版（tag 不含 beta）→ 排除
    raw("v1.5.0-beta.1", true, "2026-10-01T00:00:00Z"),
    raw("v1.5.0-beta.2", true, "2026-10-05T00:00:00Z"),
    raw("v1.4.0-beta.9", true, "2026-10-08T00:00:00Z"),   // 发布时间更晚但版本更低
  ];
  const picked = C.pickBetaRelease(list);
  check("只认 prerelease 且 tag 含 beta", picked?.tag === "v1.5.0-beta.2", JSON.stringify(picked?.tag));
  check("取 semver 最大（不按发布时间先后）", picked?.tag === "v1.5.0-beta.2");
  check("没有符合的 → null", C.pickBetaRelease([raw("v1.5.0", false), raw("nightly", true)]) === null);
  check("非法输入 → null", C.pickBetaRelease(null) === null && C.pickBetaRelease("x") === null);
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

// ——— 构建渠道判定（当前构建属于哪个渠道）———
section("构建渠道判定");
check("纯 semver → stable（含 v 前缀）", C.buildChannel("1.2.3") === "stable" && C.buildChannel("v1.2.3") === "stable");
check("带短 sha → nightly（两种写法都认）", C.buildChannel("1.2.0-abc1234-nightly") === "nightly" && C.buildChannel("1.2.0-abc1234") === "nightly");
check("带 beta 段 → beta", C.buildChannel("v1.5.0-beta.1") === "beta" && C.buildChannel("1.5.0-Beta") === "beta");
check("解析不出的脏串保守按 stable（例如 dev 的 git describe 残次品）", C.buildChannel("nightly") === "stable" && C.buildChannel("") === "stable");
eq("构建描述：正式版", C.describeBuild("v1.2.3"), "Stable v1.2.3");
eq("构建描述：nightly 带短 sha", C.describeBuild("1.2.0-abc1234-nightly"), "Nightly 1.2.0-abc1234");
eq("构建描述：beta 带 prerelease 序号", C.describeBuild("1.5.0-beta.1"), "Beta v1.5.0-beta.1");

// ——— 渠道切换判定（decideUpdate opts.switch）———
// 与同渠道升级是两套判据：换渠道只排除「同一份构建」，同版号 / 回退都要能提示。
section("渠道切换判定");
{
  const nightlyRel = C.normalizeRelease({
    tag_name: "nightly", prerelease: true, published_at: "2026-10-07T02:00:00Z",
    assets: [{ name: "Quaver-1.2.0-bbb2222-x86_64.AppImage", size: 100, browser_download_url: "https://x/1" }],
  });
  const st = (v) => C.normalizeRelease({ tag_name: v });

  // 核心回归：nightly 构建同版号切回 stable。不 switch 时按同渠道升级语义（不提示），
  // 带 switch 必须提示 —— 否则切到 nightly 之后永远回不到 stable（正式版不会为了某份 nightly 抬版本号）。
  const plain = C.decideUpdate("1.2.0-abc1234-nightly", "stable", st("v1.2.0"));
  check("同版号回 stable：默认（同渠道升级）不提示", plain.available === false && plain.switching === false, JSON.stringify(plain));
  const back = C.decideUpdate("1.2.0-abc1234-nightly", "stable", st("v1.2.0"), { switch: true });
  check("同版号回 stable：切换模式提示", back.available === true && back.switching === true && back.relation === "same", JSON.stringify(back));
  eq("切换目标标识", back.targetLabel, "v1.2.0");
  eq("切换键带 switch 前缀（与升级键互不吞提醒）", back.key, "switch:v1.2.0");

  const down = C.decideUpdate("1.3.0-abc1234-nightly", "stable", st("v1.2.0"), { switch: true });
  check("nightly 版号更高 → 回 stable 标回退，但仍允许（用户明确要 Stable）", down.available === true && down.relation === "downgrade");
  const up = C.decideUpdate("1.2.0-bbb2222-nightly", "stable", st("v1.3.0"), { switch: true });
  check("正式版更高 → 回 stable 顺带升版", up.available === true && up.relation === "upgrade");

  const toN = C.decideUpdate("1.2.0", "nightly", nightlyRel, { switch: true });
  check("stable 同版号 → 切到 nightly：提示", toN.available === true && toN.switching === true && toN.relation === "same");
  eq("nightly 目标标识带短 sha", toN.targetLabel, "1.2.0-bbb2222");
  eq("nightly 切换键", toN.key, "switch:1.2.0-bbb2222");
  const dn = C.decideUpdate("1.5.0", "nightly", nightlyRel, { switch: true });
  check("stable 版号更高 → 切到 nightly 标回退", dn.available === true && dn.relation === "downgrade");

  const same = C.decideUpdate("1.2.0-bbb2222-nightly", "nightly", nightlyRel, { switch: true });
  check("同一份 nightly 构建（同版号同 sha）→ 切换模式也不提示", same.available === false && same.relation === "same");

  // beta 参与三向切换：stable ↔ beta ↔ nightly 都要能提示（含版本号回退 / 同版号换构建）
  const betaRel = C.normalizeRelease({
    tag_name: "v1.2.0-beta.1", prerelease: true, published_at: "2026-10-07T02:00:00Z",
    assets: [{ name: "Quaver-1.2.0-beta.1-x86_64.AppImage", size: 100, browser_download_url: "https://x/b1" }],
  });
  const toB = C.decideUpdate("1.2.0", "beta", betaRel, { switch: true });
  check("stable 同版号 → 切到 beta：提示（beta 有版号，标回退）", toB.available === true && toB.switching === true && toB.relation === "downgrade", JSON.stringify(toB));
  eq("beta 切换目标标识", toB.targetLabel, "v1.2.0-beta.1");
  eq("beta 切换键", toB.key, "switch:v1.2.0-beta.1");
  const bBack = C.decideUpdate("1.2.0-beta.1", "stable", st("v1.1.0"), { switch: true });
  check("beta 版号更高 → 切回 stable 标回退，但仍允许", bBack.available === true && bBack.relation === "downgrade");
  const bToN = C.decideUpdate("1.2.0-beta.1", "nightly", nightlyRel, { switch: true });
  check("beta → nightly：提示（换渠道）", bToN.available === true && bToN.switching === true);
  const nToB = C.decideUpdate("1.2.0-bbb2222-nightly", "beta", betaRel, { switch: true });
  check("nightly → beta：提示（换渠道）", nToB.available === true && nToB.switching === true);
  const bSame = C.decideUpdate("1.2.0-beta.1", "beta", betaRel, { switch: true });
  check("同一份 beta（同 tag）→ 切换模式也不提示", bSame.available === false && bSame.relation === "same");

  const upg = C.decideUpdate("1.2.0", "stable", st("v1.2.3"), { switch: false });
  check("switch:false 与不传等价（同渠道升级路径不变）", upg.available === true && upg.switching === false && upg.relation === "upgrade");
  check("坏版本号在切换模式下仍然报错", "error" in C.decideUpdate("nope", "nightly", nightlyRel, { switch: true }));
  check("坏 tag 在切换模式下仍然报错", "error" in C.decideUpdate("1.2.0-abc1234-nightly", "stable", st("not-a-version"), { switch: true }));
}

// ——— 接线（源码级）：渠道切换这条链拆在三个文件里，纯逻辑单测覆盖不到「有没有接上」———
section("渠道切换接线");
{
  const updater = noComments(readSrc("src/lib/updater.ts"));
  const dialog = noComments(readSrc("src/components/UpdateDialog.ts"));
  const views = readSrc("src/views.ts");
  const settings = noComments(slice(views, "async function settingsView", "async function logView"));
  check("抠到 settingsView 源码", settings.length > 2000, `${settings.length} 字符`);

  check("updater: 当前构建渠道由版本串判定（不额外落盘）", has(updater, "const installedChannel = buildChannel(current)"));
  check("updater: 选中渠道 ≠ 构建渠道 即切换", has(updater, "const switching = channel !== installedChannel"));
  check("updater: 判定把 switching 传进 decideUpdate", has(updater, "decideUpdate(current, channel, release, { switch: switching })"));
  check("updater: 启动自动检查不弹换渠道提醒（仅打包态弹）",
    has(updater, "opts?.auto && (r.info.skipped || (r.info.switching && !r.info.packaged))"));

  check("弹窗: 切换态换标题（正式版/Beta 用版本号、Nightly 认渠道）",
    has(dialog, "切换到 <b>Nightly</b> 构建") && has(dialog, '"正式版"} <b>') && has(dialog, '" Beta 版"'));
  check("弹窗: 渠道徽标走 channelLabel（stable/beta/nightly 三态）", re(dialog, /const channelName = channelLabel\(info\.channel\)/));
  check("弹窗: 切换态换主按钮措辞", has(dialog, 'const mainLabel = info.switching ? "立即切换" : "立即更新"'));
  check("弹窗: 切换态换跳过措辞", has(dialog, 'const skipLabel = info.switching ? "暂不切换" : "跳过此版本"'));
  check("弹窗: 回退关系单独标 is-risk", has(dialog, "目标版本比当前更低") && has(dialog, 'dangerNote ? " is-risk" : ""'));
  check("弹窗: 目标按钮标签也走 mainLabel（失败回退时别写死「立即更新」）",
    re(dialog, /setMain\(mainLabel, true, startInstall\)/) && re(dialog, /setMain\(selfInstallable \? mainLabel : "打开发布页"/));

  check("设置页: 渠道卡片选了另一个渠道就立刻按切换语义查一次",
    has(settings, "if (next !== was && next !== buildChannel(buildVer))") && re(settings, /checkAndPrompt\(next\)/));
  check("设置页: 渠道说明行（当前运行 / 已选 渠道）", has(views, 'id="upd-channel-note"') && re(settings, /const syncChannel = \(\) => \{/));
  check("设置页: 当前构建版本优先取打包态 app.getVersion()",
    re(settings, /getPlatformInfo\(\)\.then\(\(pf\) => \{[\s\S]{0,200}buildVer = pf\.version/));
}

console.log(failed ? `\n${failed} 项断言失败` : "\n全部通过");
process.exit(failed ? 1 : 0);

// 清理（放不到 finally 就手动跑；失败时保留现场也无妨）
process.on("exit", () => { try { rmSync(OUT_DIR, { recursive: true, force: true }); } catch { /* 忽略 */ } });
