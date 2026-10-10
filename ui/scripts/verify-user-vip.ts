// 我的页（/user）会员信息与进出场动效的校验
//
// 直接 import 纯 TS 模块，验证三类会员独立身份/时间、到期徽章消失与展示。
// Go 的原始字段映射与真实 HTTP 链路在后端测试中验证。
//
// 用法：node scripts/verify-user-vip.ts
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const EASE = "cubic-bezier(.22,.61,.36,1)"; // 全站唯一一套缓动，新增动效必须用它

// 稳定接口契约样例：超会与绿豪的结束时间不同，不能互相借用。
const FIXTURE = {
  svip: 0, svip_start: "", svip_end: "", svip_year_flag: 0,
  identity: { vip: 1, vip_start: "2026-01-01", vip_end: "2026-12-31", year_flag: 0,
    huge_vip: 1, huge_vip_start: "2026-07-25 18:40:17", huge_vip_end: "2026-09-25 18:40:17",
    huge_year_flag: 0, level: 6, eight: 1, eight_end: "2027-01-01" },
  userinfo: { expire: 1790000000, buy_url: "https://example.com/buy", my_vip_url: "https://example.com/vip" },
};
const vipUrl = pathToFileURL(join(root, "src/lib/vip.ts")).href;
const vip = await import(vipUrl);
const views = read("src/views.ts");
const css = read("src/style.css");

let checks = 0, fails = 0;
const ok = (name, cond, note = "") => {
  checks++;
  if (cond) console.log(`PASS ${name}${note ? " — " + note : ""}`);
  else { fails++; console.log(`FAIL ${name}${note ? " — " + note : ""}`); }
};
const re = (h, rx) => rx.test(h);
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const section = (t) => console.log(`\n=== ${t} ===`);
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** 自然日差（UTC 日历日算，与本模块的 +08:00 口径实现无关 = 独立参照） */
const calDays = (a, b) => Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400_000);

// ============ 1. 上游字段口径（对照抓包响应） ============
section("接口契约（会员独立字段）");
const src = read("src/lib/vip.ts");
const tableSrc = src.slice(src.indexOf("export const VIP_TIERS"), src.indexOf("];", src.indexOf("export const VIP_TIERS")));
const tiers = tableSrc.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{ label:"))
  .map((l) => ({
    label: (/"label":/.test(l) ? /"label":\s*"([^"]+)"/ : /label:\s*"([^"]+)"/).exec(l)?.[1] ?? "",
    where: /where:\s*"([^"]+)"/.exec(l)?.[1] ?? "",
    flag: /flag:\s*"([^"]+)"/.exec(l)?.[1] ?? "",
    start: /start:\s*"([^"]+)"/.exec(l)?.[1] ?? "",
    end: /end:\s*"([^"]+)"/.exec(l)?.[1] ?? "",
    year: /yearFlag:\s*"([^"]+)"/.exec(l)?.[1] ?? "",
  }));
ok("能从源码里解出档位表", tiers.length === vip.VIP_TIERS.length && tiers.length === 3, `${tiers.length} 档`);
eq("档位表就三行：超级会员 / 豪华绿钻 / 绿钻",
  vip.VIP_TIERS.map((t) => t.label), ["超级会员", "豪华绿钻", "绿钻"]);
ok("档位表字段名与模块导出一致",
  JSON.stringify(tiers.map((t) => [t.label, t.where, t.flag, t.start, t.end]).flat())
  === JSON.stringify(vip.VIP_TIERS.map((t) => [t.label, t.where, t.flag, t.start ?? "", t.end ?? ""]).flat()));

// 上游响应的字段按层取键：identity = FIXTURE.identity，root = 响应顶层
const layerKeys = (where) => new Set(Object.keys(where === "identity" ? FIXTURE.identity : FIXTURE));

const missing = [], wrongLayer = [];
for (const t of tiers) {
  const own = layerKeys(t.where), other = layerKeys(t.where === "identity" ? "root" : "identity");
  for (const f of [t.flag, t.start, t.end, t.year].filter(Boolean)) {
    if (!own.has(f)) missing.push(`${t.label}.${f}@${t.where}`);
    else if (other.has(f)) wrongLayer.push(`${t.label}.${f}`);
  }
}
ok("档位字段名全部存在于所指的那一层", missing.length === 0, missing.join(", ") || `${tiers.length} 档字段全中`);
ok("档位没有挂错层（huge_vip 只属于 identity，svip 只属于顶层）", wrongLayer.length === 0, wrongLayer.join(", "));

// ============ 2. 时间口径 ============
section("时间口径（+08:00 墙钟 / 脏值）");
const P = vip.parseVipTime;
eq("带时分秒的上游串", P("2026-09-25 18:40:17"), Date.parse("2026-09-25T18:40:17+08:00"));
eq("只有日期的上游串", P("2026-09-26"), Date.parse("2026-09-26T00:00:00+08:00"));
eq("空 / 零 / 脏值一律 null",
  ["", "   ", "0", "0000-00-00", "2026-13-01", "2026-02-31", "2026-09-25 99:99", "yesterday", null, undefined, 0].map(P),
  [null, null, null, null, null, null, null, null, null, null, null]);
ok("V8 会静默进位，我们必须拒掉（不是靠 Date.parse 自己报错）",
  P("2026-02-31") === null && !Number.isNaN(Date.parse("2026-02-31T00:00:00+08:00")));
eq("展示形态：秒截掉、时分全 0 只给日期", [vip.fmtVipTime("2026-09-25 18:40:17"), vip.fmtVipTime("2026-09-26"), vip.fmtVipTime("")],
  ["2026-09-25 18:40", "2026-09-26", ""]);
eq("只有日期的到期串收到当天 23:59:59（否则到期日零点就喊已过期）；带时分秒的不动",
  [P("2026-09-26", "end") - P("2026-09-26"), P("2026-09-25 18:40:17", "end") - P("2026-09-25 18:40:17")],
  [86_400_000 - 1000, 0]);

// 换时区必须得到同一个瞬时 —— 这是「按 +08:00 解析」的意义所在（本地时区解析会整体偏一天）
const probe = (tz) => {
  const code = `const m = await import(${JSON.stringify(vipUrl)});` +
    `const ms = m.parseVipTime("2026-09-25 18:40:17");` +
    `console.log(JSON.stringify([ms, m.fmtVipWall(ms), m.parseVipTime("2026-09-26")]));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ: tz }, encoding: "utf8" }).trim());
};
const inUtc = probe("UTC"), inNY = probe("America/New_York");
eq("TZ=UTC 与 TZ=America/New_York 解析结果一致", inUtc, inNY);
eq("墙钟展示不随时区漂（上游那串是什么就显示什么）", [inUtc[1], inNY[1]], ["2026-09-25 18:40", "2026-09-25 18:40"]);

// ============ 3. 展示口径 ============
section("展示口径（到期/过期/只读不买）");
// 输入 = 顶部那份抓包 FIXTURE（2026-09-19 本机 sidecar :3200 /user/vip）
const NOW = Date.parse("2026-09-19T13:56:11+08:00");
const ov = vip.vipOverview(FIXTURE, NOW);
eq("三种权益各自展示，不用上级标记吞掉下级记录", ov.rows.map((r) => r.label), ["豪华绿钻", "绿钻"]);
eq("绿豪不会变成超会", [ov.svip, vip.vipBadgeHtml(FIXTURE, NOW)], [false, '<i class="badge green">豪华绿钻</i>']);
eq("主到期时间属于当前最高有效权益，不取更晚的绿钻/音乐包/通用 expire",
  [ov.until.label, ov.until.text], ["豪华绿钻", "2026-09-25 18:40"]);
eq("等级", [ov.level, ov.empty], [6, false]);
const BOTH = { ...FIXTURE, svip: 1, svip_start: "2026-08-01", svip_end: "2026-09-20" };
const both = vip.vipOverview(BOTH, NOW);
eq("超会、绿豪、绿钻各用自己的时间", both.rows.map((r) => r.end), ["2026-09-20", "2026-09-25 18:40", "2026-12-31"]);
eq("超会不能显示成绿豪的到期时间", [both.until.label, both.until.text], ["超级会员", "2026-09-20"]);
const afterSuper = Date.parse("2026-09-21T12:00:00+08:00");
eq("超会已过期但绿豪有效时降级徽章", vip.vipBadgeHtml(BOTH, afterSuper), '<i class="badge green">豪华绿钻</i>');
eq("过期超会保留历史时间但不再开通", [vip.vipOverview(BOTH, afterSuper).svip, vip.vipOverview(BOTH, afterSuper).rows[0].active], [false, false]);
eq("绿豪过期但绿钻有效时显示绿钻", vip.vipBadgeHtml(FIXTURE, Date.parse("2026-10-10T12:00:00+08:00")), '<i class="badge green">绿钻</i>');
eq("三档全部过期即没有会员徽章", vip.vipBadgeHtml(BOTH, Date.parse("2027-01-02T00:00:00+08:00")), "");
const EXPIRE_END = "2025-01-01 00:00:00";
const expired = { svip: 1, svip_end: EXPIRE_END, identity: { vip: 1, vip_end: EXPIRE_END, huge_vip: 1, huge_vip_end: EXPIRE_END } };
eq("过期标志位仍为 1 也无徽章", vip.vipBadgeHtml(expired, NOW), "");
eq("字符串零不是有效会员", vip.vipBadgeHtml({ svip: "0", identity: { vip: "0", huge_vip: "0" } }, NOW), "");
eq("有未来时间但标志关闭，不凭时间捏造会员", vip.vipBadgeHtml({ svip: 0, svip_end: "2027-01-01" }, NOW), "");
eq("未来才生效不显示会员", vip.vipBadgeHtml({ svip: 1, svip_start: "2027-01-01", svip_end: "2028-01-01" }, NOW), "");
eq("无效日期不给会员标志", vip.vipBadgeHtml({ svip: 1, svip_end: "2026-02-31" }, NOW), "");
eq("精确到期时刻即无会员标志", vip.vipBadgeHtml({ svip: 1, svip_end: "2026-09-19 13:56:11" }, NOW), "");
ok("只有日期的到期当天仍有效", vip.vipBadgeHtml({ identity: { huge_vip: 1, huge_vip_end: "2026-09-19" } }, NOW).includes("豪华绿钻"));
eq("空响应无记录", [vip.vipOverview(null, NOW).empty, vip.vipOverview({}, NOW).until], [true, null]);
eq("userinfo.expire 不分配给任何会员类型", vip.vipOverview({ userinfo: { expire: 1790000000 } }, NOW).until, null);
const unknownDate = { svip: 1, identity: { huge_vip: 1, huge_vip_end: "2027-01-01" } };
eq("超会缺时间不能借绿豪时间", vip.vipOverview(unknownDate, NOW).until, null);
const card = vip.vipCardHtml(FIXTURE, NOW);
ok("卡片明确展示绿豪的有效期", card.includes("豪华绿钻有效至") && card.includes("2026-09-25 18:40"));
ok("卡片不出现不存在的超级会员", !card.includes("超级会员"));
ok("未知到期时间明确说明", vip.vipCardHtml(unknownDate, NOW).includes("超级会员已开通，上游未返回该权益的到期时间"));
ok("卡片不渲染购买链接", !card.includes("example.com"));
ok("续费只引导官方客户端", card.includes(vip.VIP_RENEW_HINT));
const cardOld = vip.vipCardHtml(expired, NOW);
ok("历史权益保留过期态", cardOld.includes("已过期") && cardOld.includes("vip-card expired"));
ok("无响应有明确提示", vip.vipCardHtml(null).includes("会员信息暂时读不到"));
ok("徽章接线使用相同的有效期判定", read("src/lib/api.ts").includes("badges.push(vipBadgeHtml(vip))"));

// 页面停留跨越到期时刻：即使接口没有重新请求，也要移除徽章。
const originalNow = Date.now, originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
const originalDocument = globalThis.document;
let clock = NOW, scheduled, scheduledDelay, painted = "", visibleRefresh;
Date.now = () => clock;
globalThis.setTimeout = (cb, ms) => { scheduled = cb; scheduledDelay = ms; return 1; };
globalThis.clearTimeout = () => { scheduled = undefined; };
globalThis.document = {
  addEventListener(_, cb) { visibleRefresh = cb; },
  removeEventListener() { visibleRefresh = undefined; },
};
try {
  const brief = { svip: 1, svip_end: "2026-09-19 13:56:12" };
  const stop = vip.watchVip(brief, () => { painted = vip.vipBadgeHtml(brief); });
  ok("页面打开时安排精确到期刷新", painted.includes("超级会员") && scheduledDelay === 1000);
  clock += 1000;
  scheduled();
  eq("无需重进页面，到期立即移除标志", painted, "");
  stop();
  ok("离页清理会员计时器和恢复监听", scheduled === undefined && visibleRefresh === undefined);
} finally {
  Date.now = originalNow; globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear;
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
}

// ============ 4. 动效与接线 ============
section("动效接线（进场分级 / 离场跳转）");
const vCode = noComments(views);
const fnBody = (name) => {
  const i = vCode.indexOf(`function ${name}(`);
  if (i < 0) return "";
  const rest = vCode.slice(i + 1);
  const j = rest.search(/\n(async )?function |\nexport /);
  return j < 0 ? rest : rest.slice(0, j);
};
const uv = fnBody("userView");
const ex = fnBody("exitMe");
ok("userView 把 /user/vip 的结果交给了会员卡",
  re(uv, /api<(?:any|unknown)>\("\/user\/vip"\)/) && uv.includes("vipCardHtml(vip)"));
ok("退出登录：先播离场、再跳登录页（顺序不能反）",
  re(uv, /await Promise\.all\(\[exitMe\(wrap\), settleIn\(api\("\/login\/logout"/) &&
  uv.indexOf('location.href = "/login.html"') > uv.indexOf("exitMe(wrap)"));
ok("登录态变化仍走整页跳转（重置侧栏）", uv.includes('location.href = "/login.html"'));
ok("连点只开一趟登出 + 按钮进禁用态", re(uv, /if \(leaving\) return;/) && re(uv, /btn\.disabled = true;/));
ok("离场动画有超时兜底（动画事件丢了也要跳转）", re(ex, /setTimeout\(fin, ME_OUT_MS \+ 120\)/) && ex.includes("addEventListener(\"animationend\", fin, { once: true })"));
ok("离场加 .leaving（动画类）", ex.includes('classList.add("leaving")'));
ok("尊重系统减弱动效",
  re(vCode, /const reduceMotion = \(\) =>[\s\S]{0,220}prefers-reduced-motion: reduce/) &&
  re(ex, /if \(reduceMotion\(\)\) return Promise\.resolve\(\);/));
ok("登出请求不许拖住跳转", re(vCode, /settleIn = \(p: Promise<unknown>, ms: number\)/));

const cssBlock = (sel) =>
  new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

ok("进场：.me 的子元素分级淡入（全站缓动 + 短时长 + 起始态可过渡）",
  ["me-in", EASE, "both"].every((k) => cssBlock(".me > *").includes(k)));
ok("分级延迟逐级递增（头像→昵称→徽章→UID→卡片→按钮）",
  [".me > *:nth-child(2)", ".me > *:nth-child(3)", ".me > *:nth-child(4)", ".me > *:nth-child(n+5)"]
    .every((s) => cssBlock(s).includes("animation-delay")));
ok("整块动画给 .me 让位（写在选择器上，不靠权重打架）",
  // 5c6a848 起 entering 挂在 route 的子宿主上（.route > .entering），断言跟着新机制走
  css.includes(".route > .entering > *:not(.me)") && !/\.route > \.entering > \* \{/.test(css));
ok("头像那一拍用 scale 收束（.94→1）",
  cssBlock(".me > .avatar-big").includes("me-pop") && /@keyframes me-pop \{[\s\S]*?scale\(\.94\)/.test(css));
ok("keyframes: 进场是 opacity + translateY 微位移",
  /@keyframes me-in \{[\s\S]*?opacity: 0; transform: translateY\(8px\);[\s\S]*?opacity: 1; transform: none;/.test(css));
ok("离场：整页淡出上移 + 挡住连点",
  cssBlock(".me.leaving").includes("me-out") && cssBlock(".me.leaving").includes("pointer-events: none"));
ok("keyframes: 离场 1→0 淡出、上移 -6px",
  /@keyframes me-out \{[\s\S]*?opacity: 0; transform: translateY\(-6px\)/.test(css));
ok("减弱动效时进出场都不播",
  /@media \(prefers-reduced-motion: reduce\) \{\s*\.me > \*, \.me\.leaving \{ animation: none; \}/.test(css));
ok("会员卡与「我的」页都不用 display:none 切显隐（用了就没动画）",
  !/\.(me|vip-card|vip-rows)[^{]*\{[^}]*display:\s*none/.test(css));

const meBlock = css.slice(css.indexOf("===================== 我的 ==="), css.indexOf("设置视图"));
const easings = [...meBlock.matchAll(/cubic-bezier\([^)]*\)/g)].map((m) => m[0]);
ok("我的页动效只用全站那一套缓动",
  easings.length >= 3 && easings.every((e) => e === EASE), `${easings.length} 处：${[...new Set(easings)].join(" / ")}`);
ok("会员卡样式齐备（到期时间/明细/提醒/过期色 + 深色变体）",
  [".vip-card", ".vip-until", ".vip-rows", ".vip-note", ".vip-card .is-expired"].every((s) => cssBlock(s).length > 0) &&
  css.includes('html[data-theme="dark"] .vip-card .is-expired'));
ok("过期时提醒不被灰色淹没", cssBlock(".vip-card.expired .vip-note").includes("color: var(--ink)"));

console.log(`\n${checks - fails}/${checks} passed${fails ? ` — ${fails} FAILED` : ""}`);
process.exit(fails ? 1 : 0);
