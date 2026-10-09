// Quaver — 应用自更新：纯逻辑层。
//
// 版本解析/比较、安装包匹配（平台 × 架构）、GitHub release notes 的安全迷你渲染。
// 不依赖 DOM 与 Electron 桥 —— ui/scripts/verify-update.ts 直接打包本文件跑单测，
// 改比较规则先改这里再补用例。
//
// 口径（与 CI 对齐，见 .github/workflows/build.yml + resolve-version action）：
//   - 产物名 Quaver-<version>-<arch>.<ext>；nightly 版本 = <package.json 版本>-<短sha>-nightly
//   - Stable 渠道 = latest release（v* tag，draft/prerelease 自动排除）
//   - Beta 渠道 = tag 含「beta」且 prerelease=true 的 v* tag（v1.5.0-beta.1），列表里取 semver 最大者
//   - Nightly 渠道 = 滚动 Release「nightly」（prerelease），版本号从产物名解析
//
// 判定分两种意图，别混（decideUpdate 的 opts.switch）：
//   1. 同渠道升级 —— 目标必须**比当前新**才提示；同版号/回退一律安静。
//   2. 渠道切换 —— 设置里选的渠道 ≠ 当前构建所属渠道（buildChannel）。此时用户要的是
//      「换上那个渠道的构建」，与谁新谁旧无关：同版号（nightly 1.2.3-abc → stable v1.2.3）
//      乃至回退（1.3.0-abc-nightly → v1.2.3）都要提示，否则一旦切到 nightly 就再也切不回
//      stable —— 正式版不会为了「某份 nightly」抬高版本号。
//   三个渠道两两之间同理（Stable / Beta / Nightly 可以互相更换）。
//   两条路的去重键也分开（`stable:` / `beta:` / `nightly:` vs `switch:` 前缀），互相不吞提醒。

export const GITHUB_REPO = "team-quaver/quaver-music";

/** 更新渠道 = 用户意图；与「当前构建所属渠道」（buildChannel）是两码事。 */
export type UpdateChannel = "stable" | "nightly" | "beta";

export function channelLabel(c: UpdateChannel): string {
  return c === "nightly" ? "Nightly" : c === "beta" ? "Beta" : "Stable";
}

// ——— 版本解析 ———

export interface ParsedVersion {
  semver: [number, number, number];
  /** prerelease 段（小写，不含前导 `-`）：stable 为 ""；nightly 形如 `abc1234-nightly`；beta 形如 `beta.2`。 */
  pre: string;
  /** nightly 构建的短 commit id（stable / beta / 本地 dev 为空） */
  sha: string;
  nightly: boolean;
  /** beta 构建（tag 里含 beta，见 CI 的 v*-beta* 发布） */
  beta: boolean;
}

/** 展示用规范化：`git describe` 态的 __APP_VERSION__ 可能带 v 前缀（v1.2.2），展示统一再补 v。 */
export function normalizeVersion(s: string): string {
  return (s ?? "").trim().replace(/^v/i, "");
}

/**
 * 解析版本串。认识的三种形态：
 *   - `1.2.3` / `v1.2.3`                    → stable（无 prerelease）
 *   - `1.2.3-abc1234` / `1.2.3-abc1234-nightly` → nightly（短 commit id 在 prerelease 段）
 *   - `1.2.3-beta.1` / `v1.2.3-Beta`        → beta（prerelease 段含 beta）
 * 其余带未知 prerelease 的串保守返回 null（与原行为一致，别把 rc/rc1 之类误判成 stable）。
 */
export function parseVersion(s: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec((s ?? "").trim());
  if (!m) return null;
  const semver: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = (m[4] ?? "").toLowerCase();
  if (!pre) return { semver, pre: "", sha: "", nightly: false, beta: false };
  const nm = /^([0-9a-f]{7,10})(?:-nightly)?$/.exec(pre);
  if (nm) return { semver, pre, sha: nm[1], nightly: true, beta: false };
  if (pre.includes("beta")) return { semver, pre, sha: "", nightly: false, beta: true };
  return null;
}

export function cmpSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/** semver §11 的 prerelease 段比较：数字标识按数值、数字 < 字母数字、逐段比较、短者（前缀）更小。
 *  空 prerelease = 正式版，大于任何 prerelease（1.2.3 > 1.2.3-beta.2）。 */
export function cmpPre(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** semver 完整比较（含 prerelease 段）：beta 渠道靠它区分同版号的 beta.1 / beta.2。 */
export function cmpVersion(a: ParsedVersion, b: ParsedVersion): number {
  const c = cmpSemver(a.semver, b.semver);
  return c !== 0 ? c : cmpPre(a.pre, b.pre);
}

/** nightly 产物名 → 版本：Quaver-1.2.3-abc1234-x86_64.AppImage（deb 的 arch 段多词也认）。 */
export function versionFromAssetName(name: string): ParsedVersion | null {
  return parseVersion(/(\d+\.\d+\.\d+-[0-9a-f]{7,10})/i.exec(name ?? "")?.[1] ?? "");
}

function parsedChannel(p: ParsedVersion): UpdateChannel {
  return p.nightly ? "nightly" : p.beta ? "beta" : "stable";
}

/**
 * 一个版本串属于哪个渠道 —— **构建身份**，与设置里「选中的渠道」是两码事。
 * stable 构建的版本串是纯 semver（v1.2.3 / 1.2.3）；nightly 带短 sha（1.2.3-abc1234-nightly）；
 * beta 的 prerelease 段含 beta（1.2.3-beta.1）。解析不出来（dev 的脏串）保守按 stable 算。
 */
export function buildChannel(version: string): UpdateChannel {
  const p = parseVersion(version);
  return p ? parsedChannel(p) : "stable";
}

/** 构建的展示描述（渠道 + 版本，nightly 带短 sha、beta 带 prerelease）—— 设置页状态行与更新弹窗共用。 */
export function describeBuild(version: string): string {
  const p = parseVersion(version);
  if (!p) return normalizeVersion(version);
  const v = p.semver.join(".");
  if (p.nightly) return `Nightly ${v}-${p.sha}`;
  if (p.beta) return `Beta v${v}-${p.pre}`;
  return `Stable v${v}`;
}

// ——— GitHub Release 归一化 ———

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  prerelease: boolean;
  publishedAt: string;
  body: string;
  assets: ReleaseAsset[];
}

/** GitHub API 的 release JSON → 内部结构（主进程代理与浏览器 dev 直连两条路共用）。 */
export function normalizeRelease(raw: any): ReleaseInfo {
  return {
    tag: String(raw?.tag_name ?? ""),
    name: String(raw?.name ?? ""),
    prerelease: !!raw?.prerelease,
    publishedAt: String(raw?.published_at ?? ""),
    body: String(raw?.body ?? ""),
    assets: (Array.isArray(raw?.assets) ? raw.assets : [])
      .filter((a: any) => a?.browser_download_url)
      .map((a: any) => ({ name: String(a.name ?? ""), size: Number(a.size) || 0, url: String(a.browser_download_url) })),
  };
}

/**
 * beta 渠道：GitHub 没有「latest prerelease」这种接口，取 releases 列表后自己挑 ——
 * 只认 tag 含「beta」（不区分大小写）**且** prerelease=true 的，按完整 semver（含 prerelease 段）
 * 取最大者（beta.2 > beta.1；高的次版本优先）。返回归一化后的 ReleaseInfo；没有符合的返回 null。
 */
export function pickBetaRelease(raws: unknown): ReleaseInfo | null {
  let best: { rel: ReleaseInfo; v: ParsedVersion } | null = null;
  for (const raw of Array.isArray(raws) ? raws : []) {
    const rel = normalizeRelease(raw);
    if (!rel.prerelease || !/beta/i.test(rel.tag)) continue;
    const v = parseVersion(rel.tag);
    if (!v?.beta) continue;
    if (!best || cmpVersion(v, best.v) > 0) best = { rel, v };
  }
  return best?.rel ?? null;
}

// ——— 更新判定 ———

export interface UpdateDecision {
  available: boolean;
  /**
   * 展示用标签：Stable = `v1.2.3`、Beta = `v1.2.3-beta.1`（版本号）；
   * Nightly = `Nightly`（滚动构建没有「版本号」，构建时间走 latestDate，UI 组合成「发现新的 Nightly 构建」）。
   */
  latestDisplay: string;
  /** 「跳过此版本」/ 去重键：`渠道:版本标识`（切换走 `switch:` 前缀，与升级互不吞提醒） */
  key: string;
  /** 构建/发布时间（beta / nightly 渠道；ISO 字符串，来自 release published_at） */
  latestDate?: string;
  /** 本次判定是「换渠道」而不是同渠道升级（opts.switch=true 时为 true） */
  switching: boolean;
  /** 目标构建相对当前构建：更新 / 同版号 / 回退（切换渠道时三种都要给出，UI 据此措辞） */
  relation: UpdateRelation;
  /** 目标构建的精确标识（stable=`v1.2.3`，beta=`v1.2.3-beta.1`，nightly=`1.2.3-abc1234`） */
  targetLabel: string;
}

/** 目标构建与当前构建的先后关系。 */
export type UpdateRelation = "upgrade" | "same" | "downgrade";

function relationFromCmp(c: number): UpdateRelation {
  return c > 0 ? "upgrade" : c < 0 ? "downgrade" : "same";
}

function relationOf(a: [number, number, number], b: [number, number, number]): UpdateRelation {
  return relationFromCmp(cmpSemver(a, b));
}

/**
 * 渠道判定。current 传当前构建的版本串（__APP_VERSION__ 或打包态的 app.getVersion()，容忍 v 前缀）。
 *
 * opts.switch=true = 「用户要换到 channel 这个渠道」，可用性判据换成「目标构建 ≠ 当前构建」，
 * 不再要求更新（见文件头注）。同一份构建（stable 同版号 / beta 同 tag / nightly 同版号 + 同 sha）才判不可用。
 *
 * 不带 opts（默认，同渠道升级）：
 * - stable：latest tag 的 semver > 当前 semver 才算更新（nightly/beta 构建切回 stable 时，
 *   版本号更高的正式版同样会提示）。
 * - beta：latest tag 的完整 semver（含 prerelease 段）> 当前才算更新（beta.2 > beta.1；正式版 > 同版号 beta）。
 * - nightly：同 semver 但 sha 不同也算更新（滚动构建）；semver 更低视为回滚，不提示。
 *   当前是 stable/beta 构建（无 sha）跑 nightly 渠道时，同版号 nightly 也提示。
 */
export function decideUpdate(
  current: string,
  channel: UpdateChannel,
  release: ReleaseInfo,
  opts?: { switch?: boolean },
): UpdateDecision | { error: string } {
  const cur = parseVersion(current);
  if (!cur) return { error: `无法解析当前版本号「${current}」` };
  const from = parsedChannel(cur);
  const switching = !!opts?.switch;
  // 换渠道：目标是别的渠道 → 同版号乃至回退都要提示（否则切进来 / 切回去都无路可走）。
  // 同一渠道不算换渠道 —— 那条路仍要求「目标比当前新」。
  const crossChannel = switching && from !== channel;

  if (channel === "stable") {
    const latest = parseVersion(release.tag);
    if (!latest || latest.nightly || latest.beta) return { error: `无法解析发布版本号「${release.tag}」` };
    const rel = relationOf(latest.semver, cur.semver);
    const label = `v${latest.semver.join(".")}`;
    return {
      available: crossChannel || rel === "upgrade",
      latestDisplay: label,
      key: `${switching ? "switch" : "stable"}:${release.tag}`,
      switching,
      relation: rel,
      targetLabel: label,
    };
  }

  if (channel === "beta") {
    // beta：Release 是打了 prerelease 的 v* tag（tag 里含 beta），身份与版本号都在 tag 里
    const latest = parseVersion(release.tag);
    if (!latest) return { error: `无法解析 Beta 版本号「${release.tag}」` };
    if (!latest.beta || !release.prerelease) return { error: "Beta 渠道只接受 tag 含 beta 的预发布版本" };
    const rel = relationFromCmp(cmpVersion(latest, cur));
    const label = `v${latest.semver.join(".")}-${latest.pre}`;
    // 同一份 beta = 同一份 release（换渠道时当前不是 beta → 恒不同）
    const sameBuild = from === "beta" && rel === "same";
    return {
      available: crossChannel ? !sameBuild : rel === "upgrade",
      latestDisplay: label,
      latestDate: release.publishedAt,
      key: `${switching ? "switch" : "beta"}:${release.tag}`,
      switching,
      relation: rel,
      targetLabel: label,
    };
  }

  // nightly：Release 名是恒定的「nightly」，构建身份（pkg 版本 + 短 sha）埋在产物名里
  const latest = release.assets.map((a) => versionFromAssetName(a.name)).find(Boolean) ?? null;
  if (!latest) return { error: "未能从 Nightly 产物文件名解析出构建标识" };
  const rel = relationOf(latest.semver, cur.semver);
  // 同一份 nightly 构建 = 版号与短 sha 都相同（换渠道时当前非 nightly、没有 sha → 恒不同）
  const sameBuild = from === "nightly" && rel === "same" && !!latest.sha && latest.sha === cur.sha;
  const newer = rel === "upgrade" || (rel === "same" && !!latest.sha && latest.sha !== cur.sha);
  const id = `${latest.semver.join(".")}-${latest.sha}`;
  return {
    available: crossChannel ? !sameBuild : newer,
    latestDisplay: "Nightly",
    latestDate: release.publishedAt,
    key: `${switching ? "switch" : "nightly"}:${id}`,
    switching,
    relation: rel,
    targetLabel: id,
  };
}

// ——— 安装包匹配（平台 × 架构） ———

export type AssetKind = "appimage" | "exe" | "dmg" | "deb";

/** 各运行架构对应的产物名写法（CI：AppImage=x86_64/aarch64，NSIS=x64/arm64，dmg=arm64）。 */
const ARCH_WORDS: Record<string, RegExp> = {
  x64: /(?:\bx64\b|x86_64|amd64)/,
  arm64: /(?:\barm64\b|aarch64)/,
  loong64: /(?:\bloong64\b|loongarch64)/,
};

/**
 * 从 release assets 里挑出当前平台/架构的安装包。
 * Linux 优先 AppImage（可原位替换更新）；deb 仅在 AppImage 缺位时兜底（loong64 场景）。
 * 找不到（如 x86 mac —— 构建已裁撤）返回 null，调用方应引导去发布页。
 */
export function pickAsset(platform: string, arch: string, assets: ReleaseAsset[]): { asset: ReleaseAsset; kind: AssetKind } | null {
  const re = ARCH_WORDS[arch];
  if (!re) return null;
  const kinds: Array<{ ext: string; kind: AssetKind; platform: string }> = [
    { ext: ".AppImage", kind: "appimage", platform: "linux" },
    { ext: ".exe", kind: "exe", platform: "win32" },
    { ext: ".dmg", kind: "dmg", platform: "darwin" },
    { ext: ".deb", kind: "deb", platform: "linux" },
  ];
  for (const k of kinds) {
    if (k.platform !== platform) continue;
    const hit = assets.find((a) => a.name.endsWith(k.ext) && re.test(a.name));
    if (hit) return { asset: hit, kind: k.kind };
  }
  return null;
}

// ——— 更新日志迷你渲染 ———
// GitHub release body 的常用子集：标题 / 列表 / 段落 / 围栏代码块 / 行内代码 / 粗体 / 链接。
// 先整体 HTML 转义再按白名单拼标记，链接只放行 http(s) —— release body 是第三方内容，
// 这里渲染进主界面，绝不能有注入面。

const escHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** 从 HTML 属性串里取属性值（GitHub release 手写 <img> 常见形态）。 */
const pickAttr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
};

/** <img> 宽高白名单：纯数字或百分比，其余（表达式/外带字符）直接不要。 */
const safeSize = (v: string | null): string | null => (v && /^\d{1,4}%?$/.test(v) ? v : null);

function inlineMd(raw: string): string {
  const tokens: string[] = [];
  const keep = (html: string) => `\u0000${tokens.push(html) - 1}\u0000`;
  // 白名单 HTML 图片（在整体转义**之前**抽取）：GitHub release 的截图常以
  // <img src="…" width="…"> 形态出现，markdown 语法覆盖不到。src 只认 https 白名单
  // 字符集，宽高只认数字/百分比，其余属性（onerror 等）一律丢弃。
  let s = raw.replace(/<img\s([^>]*?)\/?>/gi, (_m, attrs: string) => {
    const src = pickAttr(attrs, "src") ?? "";
    if (!/^https:\/\/[\w.\-/?:=&%+#~,']+$/.test(src)) return "";
    const out = [`src="${src}"`, 'loading="lazy"'];
    const alt = pickAttr(attrs, "alt");
    if (alt) out.push(`alt="${alt.replace(/["<>]/g, "")}"`);
    const w = safeSize(pickAttr(attrs, "width"));
    if (w) out.push(`width="${w}"`);
    const hgt = safeSize(pickAttr(attrs, "height"));
    if (hgt) out.push(`height="${hgt}"`);
    return keep(`<img ${out.join(" ")} />`);
  });
  // 整体转义后再按白名单拼标记；链接只放行 http(s) —— release body 是第三方内容，
  // 这里渲染进主界面，绝不能有注入面。
  s = escHtml(s);
  // 行内代码先抽走，里面的 * 和 url 不再参与后续规则
  s = s.replace(/`([^`]+)`/g, (_m, c) => keep(`<code>${c}</code>`));
  // 图片 ![alt](https://…)（先于链接：语法重叠）；URL 只放行 http(s)
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, alt, u) =>
    keep(`<img src="${u}" alt="${alt}" loading="lazy" />`));
  // 显式链接 [text](https://…)（url 已被转义，&amp; 放进 href 是合法且等价的）
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) =>
    keep(`<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`));
  // 裸链接（在显式链接之后，剩下的都是纯文本）
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_m, p, u) =>
    `${p}${keep(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)}`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => tokens[Number(i)]);
}

export function renderNotes(md: string): string {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let para: string[] = [];
  let list: string[] | null = null;
  let quote: string[] | null = null;
  let fence: string[] | null = null;
  const flushPara = () => {
    if (para.length) html += `<p>${inlineMd(para.join(" "))}</p>`;
    para = [];
  };
  const flushList = () => {
    if (list) html += `<ul>${list.map((li) => `<li>${inlineMd(li)}</li>`).join("")}</ul>`;
    list = null;
  };
  const flushQuote = () => {
    if (quote) html += `<blockquote>${quote.map((q) => `<p>${inlineMd(q)}</p>`).join("")}</blockquote>`;
    quote = null;
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of lines) {
    if (fence !== null) {
      if (/^```\s*$/.test(line)) {
        html += `<pre><code>${escHtml(fence.join("\n"))}</code></pre>`;
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushAll(); fence = []; continue; }
    if (/^\s*$/.test(line)) { flushAll(); continue; }
    const qm = /^\s*>\s?(.*)$/.exec(line);
    if (qm) { flushPara(); flushList(); (quote ??= []).push(qm[1]); continue; }
    const hm = /^#{1,6}\s+(.*)$/.exec(line);
    if (hm) { flushAll(); html += `<h4>${inlineMd(hm[1])}</h4>`; continue; }
    const lm = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (lm) { flushPara(); flushQuote(); (list ??= []).push(lm[1]); continue; }
    flushList(); flushQuote();
    para.push(line.trim());
  }
  if (fence) html += `<pre><code>${escHtml(fence.join("\n"))}</code></pre>`;
  flushAll();
  return html || "<p><span class=\"muted\">（本次发布没有填写更新说明）</span></p>";
}
