// 我的页（/user）会员信息与进出场动效的校验
//
// 这是本项目第一个**直接 import TS 模块**的校验脚本：Node ≥22.18 默认开启类型剥离
// （更早的版本加 `--experimental-strip-types`），src/lib/vip.ts 是纯函数、零依赖，可以直接
// 拿来做真单测 —— 日期解析这种事，对着源码写正则断言等于没测。
//
// 覆盖四块：
//   1. **上游字段口径**：档位表里的字段名必须在 vendor/QQMusicApi 的模型里真实存在，且挂在正确的
//      层（star/ystar 在顶层 UserVipInfoResponse，不在 identity 里 —— 写错不报错，只少一行）。
//   2. **时间口径**：+08:00 解析（换 TZ 结果必须一致，否则非 UTC+8 机器上「已过期」会假阳性）、
//      脏值（"2026-02-31" 会被 V8 静默进位成 03-03，实测）必须拒掉、上游两种格式都能读。
//   3. **展示口径**：过期/未过期文案、到期取最晚一档、**只读不买**（purchase_url/buy_url/
//      my_vip_url 一律不进 DOM）、续费只留一句指路官方客户端。
//   4. **动效接线**：进场分级淡入 + 退出离场早于跳转（且跳转不许被动画或请求卡住）。
//
// 用法：node scripts/verify-user-vip.mjs
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const EASE = "cubic-bezier(.22,.61,.36,1)"; // 全站唯一一套缓动，新增动效必须用它

let vip;
try {
  vip = await import(pathToFileURL(join(root, "src/lib/vip.ts")).href);
} catch (e) {
  console.log(`❌ 加载不了 src/lib/vip.ts（本脚本靠 Node 的类型剥离跑真单测）\n   ${e.message}\n` +
    "   提示：Node ≥22.18 默认开启类型剥离；更早的版本请加 --experimental-strip-types 再跑。");
  process.exit(1);
}
const views = read("src/views.ts");
const css = read("src/style.css");
const model = read("../vendor/QQMusicApi/qqmusic_api/models/user.py");

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

// ============ 1. 上游字段口径（跨源核对） ============
section("上游字段口径（对照 vendored 模型）");
const classBody = (name) => {
  const i = model.indexOf(`class ${name}(`);
  if (i < 0) return "";
  const rest = model.slice(i + 1);
  const j = rest.indexOf("\nclass ");
  return j < 0 ? rest : rest.slice(0, j);
};
const IDENTITY = classBody("VipIdentity");
const ROOTCLS = classBody("UserVipInfoResponse");
ok("vendored 模型里能定位 VipIdentity / UserVipInfoResponse", IDENTITY.length > 200 && ROOTCLS.length > 200);

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
eq("档位表就三行：超级会员 / 豪华绿钻 / 绿钻（后者兜底）",
  vip.VIP_TIERS.map((t) => t.label), ["超级会员", "豪华绿钻", "绿钻"]);
ok("档位表字段名与模块导出一致",
  JSON.stringify(tiers.map((t) => [t.label, t.where, t.flag, t.start, t.end]).flat())
  === JSON.stringify(vip.VIP_TIERS.map((t) => [t.label, t.where, t.flag, t.start ?? "", t.end ?? ""]).flat()));

const missing = [], wrongLayer = [];
for (const t of tiers) {
  const own = t.where === "identity" ? IDENTITY : ROOTCLS;
  const other = t.where === "identity" ? ROOTCLS : IDENTITY;
  for (const f of [t.flag, t.start, t.end, t.year].filter(Boolean)) {
    if (!re(own, new RegExp(`\\b${f}\\s*:`))) missing.push(`${t.label}.${f}@${t.where}`);
    else if (re(other, new RegExp(`\\b${f}\\s*:`))) wrongLayer.push(`${t.label}.${f}`);
  }
}
ok("档位字段名全部存在于所指的那一层", missing.length === 0, missing.join(", ") || `${tiers.length} 档字段全中`);
ok("档位没有挂错层（star/ystar 只属于顶层，不属 identity）", wrongLayer.length === 0, wrongLayer.join(", "));
ok("星级会员两档确实挂在顶层（防后人「顺手」挪进 identity）",
  tiers.filter((t) => t.flag === "star" || t.flag === "ystar").every((t) => t.where === "root"));

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
  const code = `const m = await import(${JSON.stringify(pathToFileURL(join(root, "src/lib/vip.ts")).href)});` +
    `const ms = m.parseVipTime("2026-09-25 18:40:17");` +
    `console.log(JSON.stringify([ms, m.fmtVipWall(ms), m.parseVipTime("2026-09-26")]));`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ: tz }, encoding: "utf8" }).trim());
};
const inUtc = probe("UTC"), inNY = probe("America/New_York");
eq("TZ=UTC 与 TZ=America/New_York 解析结果一致", inUtc, inNY);
eq("墙钟展示不随时区漂（上游那串是什么就显示什么）", [inUtc[1], inNY[1]], ["2026-09-25 18:40", "2026-09-25 18:40"]);

// ============ 3. 展示口径 ============
section("展示口径（到期/过期/只读不买）");
// 真实抓包（2026-09-19 本机 sidecar :3200 /user/vip，压缩后原样保存）
const FIXTURE = JSON.parse(`{"auto_down":0,"can_renew":1,"max_dir_num":2000,"max_song_num":1000000,"song_limit_msg":"","svip":1,"star":0,"star_start":"","star_end":"","ystar":0,"ystar_start":"","ystar_end":"","identity":{"vip":1,"huge_vip":1,"huge_vip_start":"2026-07-25 18:40:17","huge_vip_end":"2026-09-25 18:40:17","year_flag":0,"huge_year_flag":0,"twelve":0,"twelve_start":"","twelve_end":"","child_vip":0,"exp_vip":0,"group_vip_flag":0,"group_vip_start":"","group_vip_end":"","cp_lover_flag":0,"cp_lover_start":"","cp_lover_end":"","ad_vip_flag":0,"eight":1,"eight_start":"2026-05-25","eight_end":"2026-09-26","level":6,"next_level":7,"icon":"http://y.gtimg.cn/mediastyle/global/vip_icon/lv_6.png","purchase_url":"http://y.qq.com/m/client/mall/myvip.html?"},"userinfo":{"buy_url":"https://y.qq.com/n2/m/myservice/index.html?_scrollhide=1&_hidehd=1&entry=1&tab1=svip&tab2=eight","my_vip_url":"https://y.qq.com/n2/m/myservice/index.html?_scrollhide=1&_hidehd=1&entry=1","score":20426,"expire":0,"music_level":10}}`);
const NOW = Date.parse("2026-09-19T13:56:11+08:00");
const ov = vip.vipOverview(FIXTURE, NOW);
ok("只列身份徽章那一套：超级会员 + 豪华绿钻（绿钻被 hideIf 顶掉）",
  ov.rows.map((r) => r.label).join(" / ") === "超级会员 / 豪华绿钻", ov.rows.map((r) => r.label).join(" / "));
ok("八平台/十二平台/星级/家庭组… 协议档位不再出现",
  !/八平台|十二平台|星级|家庭组|情侣|儿童|体验|广告/.test(ov.rows.map((r) => r.label).join("")));
eq("顺序 = 身份高低（超级会员在前），不按到期日重排", ov.rows.map((r) => r.label), ["超级会员", "豪华绿钻"]);
eq("超级会员按上游原样显示（上游没给它的到期字段，不编）", [ov.rows[0].end, ov.rows[0].state], ["", ""]);
eq("豪华绿钻的到期时间与剩余天数",
  [ov.rows[1].end, ov.rows[1].state, ov.rows[1].expired], ["2026-09-25 18:40", `${calDays([2026, 9, 25], [2026, 9, 19])} 天后到期`, false]);
eq("「会员有效至」只认展示档位（八平台的 09-26 不再把它带跑偏）",
  [ov.until.text, ov.until.state, ov.until.expired], ["2026-09-25 18:40", `${calDays([2026, 9, 25], [2026, 9, 19])} 天后到期`, false]);
eq("超级会员 / 等级", [ov.svip, ov.level, ov.empty], [true, 6, false]);
eq("只有绿钻的账号照样显示绿钻（hideIf 只在豪华绿钻在场时让位，卡片不许说谎）",
  [vip.vipOverview({ identity: { vip: 1 } }, NOW).rows.map((r) => r.label),
   vip.vipOverview({ identity: { vip: 1, huge_vip: 1 } }, NOW).rows.map((r) => r.label)],
  [["绿钻"], ["豪华绿钻"]]);

// 过期：flag 仍在、end 已过去 —— 这正是「过期会员时间显示」的主场景
const EXPIRE_END = "2025-01-01 00:00:00";
const old = vip.vipOverview({ identity: { vip: 1, huge_vip: 1, huge_vip_end: EXPIRE_END } }, NOW);
eq("已过期的档位标出来且给天数", [old.rows[0].expired, old.rows[0].state], [true, `已过期 ${-calDays([2025, 1, 1], [2026, 9, 19])} 天`]);
eq("有效至落在一个过去的时间上 → 整体过期", [old.until.expired, old.until.text], [true, "2025-01-01"]);
const today = vip.vipOverview({ identity: { huge_vip: 1, huge_vip_end: "2026-09-19" } }, NOW);
eq("到期日就是今天（时刻还没到）：算「今天到期」不算过期", [today.until.expired, today.until.state], [false, "今天到期"]);
const empty = vip.vipOverview({}, NOW);
eq("没有任何会员记录", [empty.empty, empty.until, empty.rows.length], [true, null, 0]);
eq("响应是 null（上游没答）也不炸", (() => { const o = vip.vipOverview(null, NOW); return [o.empty, o.until, o.rows.length]; })(), [true, null, 0]);
eq("userinfo.expire 兜底（秒）", vip.vipOverview({ userinfo: { expire: 1790000000 } }, NOW).until.ms, 1790000000 * 1000);
eq("userinfo.expire 兜底（毫秒量级也能认）", vip.vipOverview({ userinfo: { expire: 1790000000000 } }, NOW).until.ms, 1790000000000);
eq("expire=0 / 明显越界的一律当没给", [vip.vipOverview({ userinfo: { expire: 0 } }, NOW).until, vip.vipOverview({ userinfo: { expire: 12345 } }, NOW).until], [null, null]);

const card = vip.vipCardHtml(FIXTURE, NOW);
ok("卡片渲染到期时间", card.includes("会员有效至") && card.includes("2026-09-25 18:40"));
ok("卡片渲染档位明细（超级会员 + 豪华绿钻，八平台不露面）",
  card.includes("超级会员") && card.includes("豪华绿钻") && !card.includes("八平台") && !card.includes("十二平台"));
ok("续费提醒原文（去官方客户端）", card.includes(vip.VIP_RENEW_HINT) && vip.VIP_RENEW_HINT === "如需续费/订阅，请前往 QQ 音乐官方客户端");
ok("只读不买：上游购买入口一个都不进 DOM",
  !/myvip\.html|myservice|purchaseUrl|buy_url|my_vip_url/.test(card), "fixture 里那三个 URL 都没露头");
ok("未过期时不吓人（不出现「已过期」）", !card.includes("已过期"));
const cardOld = vip.vipCardHtml({ identity: { huge_vip: 1, huge_vip_end: EXPIRE_END }, svip: 1 }, NOW);
ok("过期时卡片与文案带过期态", cardOld.includes("已过期") && cardOld.includes("vip-card expired") && cardOld.includes("is-expired"));
ok("上游没响应时说实话，不假装有数据",
  vip.vipCardHtml(null).includes("会员信息暂时读不到") && !vip.vipCardHtml(null).includes("会员有效至"));
ok("vip.ts 里没有任何购买入口字段被消费（注释里提到不算）",
  !/purchase_url|buy_url|my_vip_url/.test(noComments(src)));

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
ok("userView 把 /user/vip 的结果交给了会员卡", uv.includes('api<any>("/user/vip")') && uv.includes("vipCardHtml(vip)"));
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
  css.includes(".route.entering > *:not(.me)") && !/\.route\.entering > \* \{/.test(css));
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
