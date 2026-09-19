// Quaver — 会员（VIP）展示口径：/user/vip 的原样数据 → 界面上的到期时间与档位明细
//
// 数据源：/user/vip → 上游 `VipLogin.VipLoginInter` / `vip_login_base`，模型见
// vendor/QQMusicApi/qqmusic_api/models/user.py 的 UserVipInfoResponse / VipIdentity / VipUserInfo
// （即 https://l-1124.github.io/QQMusicApi/reference/model/user/#models.user.VipIdentity）。
// 档位字段名一律以那份模型为准 —— 字段挂在哪一层、叫什么，写错了不会报错，只会静静地少一行。
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
const escHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 上游墙钟时区（北京时间）与常用时长 */
const SH_MS = 8 * 3600_000;
const DAY_MS = 86400_000;

/**
 * 会员档位表。flag = 生效标志字段，start/end = 起止时间字段。
 * `where` 指出字段挂在哪一层：identity = UserVipInfoResponse.identity（VipIdentity）；
 * root = UserVipInfoResponse 顶层（超级会员 `svip` 与星级那两档都在顶层，不在 identity 里 —— 别想当然）。
 *
 * **只列身份徽章那一套**（超级会员 / 豪华绿钻，绿钻兜底）—— 上游还有八平台/十二平台/星级/
 * 家庭组/情侣/儿童/体验/广告会员一堆协议档位，但客户端里用户看到的就是这两枚徽章；
 * 全摊出来只会让人以为买了别的套餐，而且「会员有效至」会被某个更晚的附属权益带跑偏
 * （实测：eight_end=2026-09-26 比 huge_vip_end=2026-09-25 晚一天，有效期就显示成 09-26 了）。
 * 顺序即展示优先级（高 → 低），卡片按表序出，不再按到期日重排。
 */
export interface VipTierDef {
  label: string;
  where: "identity" | "root";
  flag: string;
  start?: string;
  end?: string;
  /** 「年费」标志字段：不是独立档位，是同一档的计费形态（corner 小标用） */
  yearFlag?: string;
  /** 该标志非 0 时本档让位（绿钻是豪华绿钻的降级形态，两个都在就只显示后者 —— 与 identityBadges 同一套口径） */
  hideIf?: string;
}

export const VIP_TIERS: VipTierDef[] = [
  { label: "超级会员", where: "root", flag: "svip" },
  { label: "豪华绿钻", where: "identity", flag: "huge_vip", start: "huge_vip_start", end: "huge_vip_end", yearFlag: "huge_year_flag" },
  { label: "绿钻", where: "identity", flag: "vip", hideIf: "huge_vip" },
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
  /** 所有档位里最晚的到期时间 = 「会员有效至」；一个到期时间都没有 → null */
  until: { text: string; ms: number; expired: boolean; state: string } | null;
  rows: VipRow[];
  /** 完全没有任何会员记录 */
  empty: boolean;
}

/** 一份 /user/vip 响应 → 权益卡数据（纯函数，`now` 可注入便于测试） */
export function vipOverview(vip: any, now: number = Date.now()): VipOverview {
  const at = (where: "identity" | "root") => (where === "identity" ? vip?.identity ?? {} : vip ?? {});
  const rows: VipRow[] = [];
  let untilMs: number | null = null;
  let untilText = ""; // 展示串单独留：不能拿收过边的毫秒去格式化（见 parseVipTime 的 edge 说明）

  for (const t of VIP_TIERS) {
    const src = at(t.where);
    // hideIf：被更高一档「吃掉」的降级形态（绿钻 vs 豪华绿钻）整档让位，不占行
    if (t.hideIf && Number(src?.[t.hideIf] ?? 0) !== 0) continue;
    const flag = Number(src?.[t.flag] ?? 0);
    const startRaw = t.start ? src?.[t.start] : undefined;
    const endRaw = t.end ? src?.[t.end] : undefined;
    // 到期用 "end" 语义解析（只有日期的串收到当天 23:59:59），展示串则按上游原样格式化 ——
    // 别拿收边后的毫秒去格式化，否则 "2026-09-26" 会显示成 "2026-09-26 23:59"。
    const startMs = t.start ? parseVipTime(startRaw, "start") : null;
    const endMs = t.end ? parseVipTime(endRaw, "end") : null;
    if (!flag && startMs === null && endMs === null) continue; // 没这一档，不占一行
    const st = endMs === null ? null : vipExpiryState(endMs, now);
    rows.push({
      label: t.label,
      year: t.yearFlag ? Number(src?.[t.yearFlag] ?? 0) !== 0 : false,
      expired: st?.expired ?? false,
      end: endMs === null ? "" : fmtVipTime(endRaw),
      start: startMs === null ? "" : fmtVipTime(startRaw),
      state: st?.text ?? "",
    });
    if (endMs !== null && (untilMs === null || endMs > untilMs)) {
      untilMs = endMs;
      untilText = fmtVipTime(endRaw);
    }
  }

  // 兜底：所有档位都没给到期时间时用 userinfo.expire（实测常见 0 = 上游没填）。
  // 单位不稳（秒 / 毫秒都见过），按量级判；越界（<2000 年或 >2100 年）当没给。
  if (untilMs === null) {
    const exp = Number(vip?.userinfo?.expire ?? 0);
    const ms = exp > 1e11 ? exp : exp * 1000; // 1e11 ms ≈ 1973 年：超过它当毫秒
    if (Number.isFinite(ms) && ms > 946684800000 && ms < 4102444800000) {
      untilMs = ms;
      untilText = fmtVipWall(ms);
    }
  }

  // 顺序 = 档位表顺序（超级会员 → 豪华绿钻 → 绿钻），不按到期日重排：
  // 就这两三行，身份高低比「谁先到期」更该决定先后。
  const st = untilMs === null ? null : vipExpiryState(untilMs, now);
  return {
    svip: Number(vip?.svip ?? 0) !== 0,
    level: Number(vip?.identity?.level ?? 0),
    until: untilMs === null || st === null ? null : { text: untilText, ms: untilMs, expired: st.expired, state: st.text },
    rows,
    empty: rows.length === 0 && Number(vip?.svip ?? 0) === 0,
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
    ? `<div class="vip-main"><span>会员有效至</span><b class="vip-until${ov.until.expired ? bad : ""}">${escHtml(ov.until.text)}</b>
        <span class="vip-state${ov.until.expired ? bad : ""}">${escHtml(ov.until.state)}</span></div>`
    : ov.svip
      ? `<div class="vip-main"><span class="vip-empty">会员已开通，上游未返回到期时间。</span></div>`
      : `<div class="vip-main"><span class="vip-empty">当前账号没有会员订阅记录。</span></div>`;

  const rows = ov.rows.length
    ? `<ul class="vip-rows">${ov.rows
        .map(
          (r) => `<li class="vip-row${r.expired ? " expired" : ""}">
        <span class="vip-name">${escHtml(r.label)}${r.year ? `<i class="vip-tag">年费</i>` : ""}</span>
        <span class="vip-dt"${r.start ? ` title="${escHtml(r.start)} 起"` : ""}>${r.end ? `至 ${escHtml(r.end)}` : "已开通"}</span>${r.state
            ? `<span class="vip-state${r.expired ? bad : ""}">${escHtml(r.state)}</span>`
            : ""}</li>`,
        )
        .join("")}</ul>`
    : "";

  return `<section class="vip-card${ov.until?.expired ? " expired" : ""}">${head}${main}${rows}${hint}</section>`;
}
