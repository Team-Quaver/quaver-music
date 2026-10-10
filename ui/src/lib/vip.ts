// Quaver — 会员（VIP）展示口径：/user/vip 的原样数据 → 界面上的到期时间与档位明细
//
// 数据源：Go /user/vip 的稳定契约，来自官方 SRFVipQuery_V2。
// 旧 vip_login_base.svip 是绿豪，不能直接消费；Go 已按实际权益分别映射。
// 超会 svip_start/end，绿豪 identity.huge_vip_start/end，绿钻 identity.vip_start/end。
// 不跨权益借用时间，不从历史时间记录推断开通状态。
//
// 两条硬口径：
//
// 1. **到期时间是「北京时间墙钟」，不带时区标记**：上游给的格式还不统一 —— 实测同一份响应里
//    huge_vip_end = "2026-09-25 18:40:17"（带时分秒）、eight_end = "2026-09-26"（只有日期）。
//    直接 new Date(s) 按本机时区解析，在非 UTC+8 的机器上会整体偏一天 → 「已过期」假阳性。
//    故解析统一按 +08:00，展示仍用上游那串墙钟（与 QQ 音乐客户端里看到的一致），不做时区换算。
//
// 2. **只看不买**：上游同时给了 identity.purchase_url / userinfo.buy_url / userinfo.my_vip_url，
//    这里一律不渲染。续费/订阅只指路 QQ 音乐官方客户端（VIP_RENEW_HINT），本项目不做支付入口。
import { escHtml } from "./html.ts";

/** 上游墙钟时区（北京时间）与常用时长 */
const SH_MS = 8 * 3600_000;
const DAY_MS = 86400_000;

/** 三个独立权益，顺序只用于最高有效会员徽章与卡片主标题。 */
export interface VipTierDef {
  label: string;
  where: "identity" | "root";
  flag: string;
  start: string;
  end: string;
  yearFlag: string;
}

export const VIP_TIERS: VipTierDef[] = [
  { label: "超级会员", where: "root", flag: "svip", start: "svip_start", end: "svip_end", yearFlag: "svip_year_flag" },
  { label: "豪华绿钻", where: "identity", flag: "huge_vip", start: "huge_vip_start", end: "huge_vip_end", yearFlag: "huge_year_flag" },
  { label: "绿钻", where: "identity", flag: "vip", start: "vip_start", end: "vip_end", yearFlag: "year_flag" },
];

/** 续费/订阅指路文案：不做内购，只提醒去官方客户端 */
export const VIP_RENEW_HINT = "如需续费/订阅，请前往 QQ 音乐官方客户端";

const pad = (n: number) => String(n).padStart(2, "0");

/** 上游墙钟串 → 毫秒时间戳（按 +08:00 解析）。空串 / "0" / 不可识别 / 越界脏值 → null。
 *
 *  `edge` 只影响**只有日期**的串（实测上游 eight_end 就是 "2026-09-26" 这种，本卡片虽不展示它，
 *  但上游哪天把豪华绿钻的时间段也砍掉就得靠这条兜住）：
 *  `start` = 当天 00:00，`end` = 当天 23:59:59。到期日按 00:00 算的话，会员在到期日零点就
 *  显示「已过期」——早了一整天（QQ 音乐里的「到期日」指那一天仍然有效）。展示串不吃这个偏移，
 *  仍用上游原样（见 vipOverview 里 fmtVipTime 与 parseVipTime 分开取）。
 *
 *  **必须回读校验**：`Date.parse("2026-02-31T00:00:00+08:00")` 在 V8 里不报错，而是静默进位成
 *  03-03（实测 1772467200000）—— 少了这一步，"2026-02-31" 这种脏值会被当成一个合法的到期日
 *  显示出来。回读墙钟三段（年/月/日，含时分秒）与原串逐项对齐，对不上就是脏值。 */
export function parseVipTime(s: unknown, edge: "start" | "end" = "start"): number | null {
  const raw = String(s ?? "").trim().replace("T", " ");
  if (!raw || raw === "0") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, hh = "00", mi = "00", ss = "00"] = m;
  if (Number(y) < 2000 || Number(y) > 2100) return null; // "0000-00-00" 这类脏值挡在门外
  const ms = Date.parse(`${y}-${mo}-${d}T${hh}:${mi}:${ss}+08:00`);
  if (Number.isNaN(ms)) return null;
  const back = new Date(ms + SH_MS); // 回读墙钟，与输入逐项对齐（防进位）
  const same =
    back.getUTCFullYear() === Number(y) && back.getUTCMonth() + 1 === Number(mo) && back.getUTCDate() === Number(d) &&
    back.getUTCHours() === Number(hh) && back.getUTCMinutes() === Number(mi) && back.getUTCSeconds() === Number(ss);
  if (!same) return null;
  // 只有日期（上游没给时分秒）且是「到期」语义 → 收到当天 23:59:59
  return edge === "end" && m[4] === undefined ? ms + DAY_MS - 1000 : ms;
}

/** 毫秒时间戳 → 上游墙钟展示形态（+08:00 口径）。秒截掉；时分全 0 时只给日期。 */
export function fmtVipWall(ms: number): string {
  const d = new Date(ms + SH_MS);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return time === "00:00" ? date : `${date} ${time}`;
}

/** 上游墙钟串 → 展示形态；解析不出来给空串 */
export const fmtVipTime = (s: unknown): string => {
  const ms = parseVipTime(s);
  return ms === null ? "" : fmtVipWall(ms);
};

/** 自然日差（+08:00 日历日）：到期日 − 今天。0 = 今天到期，负数 = 已过期几天 */
export function vipDaysLeft(endMs: number, now: number): number {
  const day = (ms: number) => Math.floor((ms + SH_MS) / DAY_MS);
  return day(endMs) - day(now);
}

/** 到期状态：未过期「6 天后到期」/「今天到期」，已过期「已过期 3 天」 */
export function vipExpiryState(endMs: number, now: number): { expired: boolean; text: string } {
  const d = vipDaysLeft(endMs, now);
  if (endMs <= now) return { expired: true, text: d < 0 ? `已过期 ${-d} 天` : "今天已过期" };
  return { expired: false, text: d === 0 ? "今天到期" : `${d} 天后到期` };
}

export interface VipRow {
  label: string;
  /** 年费形态（huge_year_flag 之类） */
  year: boolean;
  expired: boolean;
  active: boolean;
  /** 到期时间展示串（空 = 该档上游只给了标志位、没给时间） */
  end: string;
  /** 生效时间展示串（只在 title 里提示） */
  start: string;
  /** 到期状态文案（无时间则为空） */
  state: string;
}

export interface VipOverview {
  /** 超级会员（顶层 svip；与 identity 里的豪华绿钻不是一回事） */
  svip: boolean;
  /** 会员等级（identity.level，0 = 上游没给） */
  level: number;
  /** 最高有效权益自己的到期时间；无有效权益时显示最高历史记录。 */
  until: { label: string; text: string; ms: number; expired: boolean; state: string } | null;
  rows: VipRow[];
  /** 完全没有任何会员记录 */
  empty: boolean;
}

const tierSource = (vip: any, t: VipTierDef): any => t.where === "root" ? vip ?? {} : vip?.identity ?? {};

/** 日期未给时信标志；已给但无效、尚未生效或已到期时绝不显示徽章。 */
export function vipTierActive(vip: any, t: VipTierDef, now: number = Date.now()): boolean {
  const src = tierSource(vip, t);
  if (Number(src[t.flag]) !== 1) return false;
  for (const [key, edge] of [[t.start, "start"], [t.end, "end"]] as const) {
    const raw = String(src[key] ?? "").trim();
    if (!raw || raw === "0") continue;
    const ms = parseVipTime(raw, edge);
    if (ms === null || (edge === "start" ? now < ms : now >= ms)) return false;
  }
  return true;
}

/** 侧栏/我的页共用，仅显示最高有效会员；音乐人徽章由调用方独立处理。 */
export function vipBadgeHtml(vip: any, now: number = Date.now()): string {
  const tier = VIP_TIERS.find((t) => vipTierActive(vip, t, now));
  return tier ? `<i class="badge ${tier.flag === "svip" ? "orange" : "green"}">${escHtml(tier.label)}</i>` : "";
}

/** 页面保持打开时也在权益边界更新；每分钟校时，并在窗口恢复时立即重算。 */
export function watchVip(vip: any, render: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const refresh = () => {
    clearTimeout(timer);
    render();
    const now = Date.now();
    const edges = VIP_TIERS.flatMap((t) => {
      const src = tierSource(vip, t);
      return [parseVipTime(src[t.start]), parseVipTime(src[t.end], "end")];
    }).filter((ms): ms is number => ms !== null && ms > now);
    timer = setTimeout(refresh, Math.min(60_000, ...edges.map((ms) => ms - now)));
  };
  refresh();
  document.addEventListener("visibilitychange", refresh);
  return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); };
}

/** 一份 /user/vip 响应 → 权益卡数据（纯函数，now 可注入）。 */
export function vipOverview(vip: any, now: number = Date.now()): VipOverview {
  const records = VIP_TIERS.flatMap((t) => {
    const src = tierSource(vip, t);
    const startMs = parseVipTime(src[t.start]);
    const endMs = parseVipTime(src[t.end], "end");
    if (Number(src[t.flag] ?? 0) !== 1 && startMs === null && endMs === null) return [];
    const active = vipTierActive(vip, t, now);
    const st = endMs === null ? null : vipExpiryState(endMs, now);
    const row: VipRow = {
      label: t.label, year: Number(src[t.yearFlag] ?? 0) === 1,
      active, expired: st?.expired ?? false,
      start: startMs === null ? "" : fmtVipTime(src[t.start]),
      end: endMs === null ? "" : fmtVipTime(src[t.end]),
      state: st?.expired ? st.text : startMs !== null && now < startMs ? "尚未生效" : active ? st?.text ?? "已开通" : "未开通",
    };
    return [{ row, endMs }];
  });
  // 主时间始终属于主权益，不取 max，也不从 userinfo.expire/音乐包借时间。
  const primary = records.find((r) => r.row.active) ?? records[0];
  return {
    svip: vipTierActive(vip, VIP_TIERS[0]!, now),
    level: Number(vip?.identity?.level ?? 0),
    until: primary && primary.endMs !== null
      ? { label: primary.row.label, text: primary.row.end, ms: primary.endMs, expired: primary.row.expired, state: primary.row.state }
      : null,
    rows: records.map((r) => r.row), empty: records.length === 0,
  };
}

/**
 * 会员权益卡（/user 页）。数据不可用（vip === null，上游没响应）时不假装有数据，只说读不到。
 * 注意：**只读展示** —— 上游的 purchase_url / buy_url / my_vip_url 一律不用（见文件头第 2 条）。
 */
export function vipCardHtml(vip: any, now: number = Date.now()): string {
  const hint = `<p class="vip-note">${escHtml(VIP_RENEW_HINT)}</p>`;
  if (!vip) {
    return `<section class="vip-card"><div class="vip-head"><span class="vip-title">会员权益</span></div>
      <p class="vip-empty">会员信息暂时读不到（上游没响应），稍后再进本页看看。</p>${hint}</section>`;
  }

  const ov = vipOverview(vip, now);
  const head = `<div class="vip-head"><span class="vip-title">会员权益</span>${
    ov.level ? `<span class="vip-lv">VIP ${ov.level} 级</span>` : ""}</div>`;

  const bad = " is-expired";
  const main = ov.until
    ? `<div class="vip-main"><span>${escHtml(ov.until.label)}有效至</span><b class="vip-until${ov.until.expired ? bad : ""}">${escHtml(ov.until.text)}</b>
        <span class="vip-state${ov.until.expired ? bad : ""}">${escHtml(ov.until.state)}</span></div>`
    : ov.rows.some((r) => r.active)
      ? `<div class="vip-main"><span class="vip-empty">${escHtml(ov.rows.find((r) => r.active)!.label)}已开通，上游未返回该权益的到期时间。</span></div>`
      : `<div class="vip-main"><span class="vip-empty">当前账号没有会员订阅记录。</span></div>`;

  const rows = ov.rows.length
    ? `<ul class="vip-rows">${ov.rows
        .map(
          (r) => `<li class="vip-row${r.expired ? " expired" : ""}">
        <span class="vip-name">${escHtml(r.label)}${r.year ? `<i class="vip-tag">年费</i>` : ""}</span>
        <span class="vip-dt"${r.start ? ` title="${escHtml(r.start)} 起"` : ""}>${r.end ? `至 ${escHtml(r.end)}` : r.active ? "已开通" : "未开通"}</span>${r.state
            ? `<span class="vip-state${r.expired ? bad : ""}">${escHtml(r.state)}</span>`
            : ""}</li>`,
        )
        .join("")}</ul>`
    : "";

  return `<section class="vip-card${ov.until?.expired ? " expired" : ""}">${head}${main}${rows}${hint}</section>`;
}
