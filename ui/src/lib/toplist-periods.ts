// Quaver — 榜单期次（近三个月）
// 周榜：YYYY_W（ISO 周）；日榜：YYYY-MM-DD；实时榜：YYYYMMDDHH。
// 上游只保证当前期，历史周次靠 category.history 给出；日/实时榜按日期回查。

export interface ChartPeriod {
  value: string;
  label: string;
  /** 排序/分组用的月份键，如 2026-10。 */
  month: string;
}

interface ToplistHistoryLike { year?: number[]; sub_period?: number[][] }
interface ToplistPeriodMeta {
  update_type?: number;
  period?: string;
  history?: ToplistHistoryLike;
}

const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const cloneDay = (d: Date) => new Date(d.getTime());
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const compactYmd = (d: Date) => ymd(d).replaceAll("-", "");
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;

function parseYmd(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function mondayOf(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(d, -day);
}

function isoWeekStart(year: number, week: number): Date {
  const jan4 = utcDay(year, 0, 4);
  return addDays(mondayOf(jan4), (week - 1) * 7);
}

function isoWeekOf(d: Date): { year: number; week: number } {
  const thursday = addDays(d, 3 - ((d.getUTCDay() + 6) % 7));
  const year = thursday.getUTCFullYear();
  const firstThursday = addDays(mondayOf(utcDay(year, 0, 4)), 3);
  const week = Math.floor((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS)) + 1;
  return { year, week };
}

function subtractMonths(d: Date, months: number): Date {
  const out = cloneDay(d);
  out.setUTCMonth(out.getUTCMonth() - months);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function dayLabel(d: Date, today: Date): string {
  const base = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  if (sameDay(d, today)) return `${base} · 今天`;
  if (sameDay(d, addDays(today, -1))) return `${base} · 昨天`;
  return base;
}

function weekLabel(start: Date): string {
  const end = addDays(start, 6);
  return `${start.getUTCMonth() + 1}月${start.getUTCDate()}日–${end.getUTCMonth() + 1}月${end.getUTCDate()}日`;
}

function inferUpdateType(meta: ToplistPeriodMeta): number {
  if (typeof meta.update_type === "number") return meta.update_type;
  const p = String(meta.period ?? "");
  if (/^\d{4}_\d{1,2}$/.test(p)) return 0;
  if (/^\d{10}$/.test(p)) return 2;
  return 1;
}

function weeklyPeriods(meta: ToplistPeriodMeta, today: Date, cutoff: Date): ChartPeriod[] {
  const rows = new Map<string, Date>();
  const years = meta.history?.year ?? [];
  const weeks = meta.history?.sub_period ?? [];
  for (let i = 0; i < Math.min(years.length, weeks.length); i++) {
    for (const week of weeks[i] ?? []) {
      const start = isoWeekStart(Number(years[i]), Number(week));
      if (addDays(start, 6) < cutoff || start > addDays(today, 7)) continue;
      rows.set(`${years[i]}_${week}`, start);
    }
  }

  // history 为空（部分日更/实时榜）时，仍给周更榜一份可用的近三个月周次。
  if (!rows.size) {
    for (let start = mondayOf(today); start >= cutoff; start = addDays(start, -7)) {
      const { year, week } = isoWeekOf(start);
      rows.set(`${year}_${week}`, start);
    }
  }
  return [...rows.entries()]
    .sort((a, b) => b[1].getTime() - a[1].getTime())
    .map(([value, start]) => ({ value, label: weekLabel(start), month: monthKey(start) }));
}

function dailyPeriods(meta: ToplistPeriodMeta, today: Date, cutoff: Date, realtime: boolean, now: Date): ChartPeriod[] {
  const latest = parseYmd(String(meta.period ?? ""));
  const latestHour = /^(\d{8})(\d{2})$/.exec(String(meta.period ?? ""));
  const out: ChartPeriod[] = [];
  for (let d = cloneDay(today); d >= cutoff; d = addDays(d, -1)) {
    if (realtime) {
      const isLatest = sameDay(d, today)
        && latestHour
        && latestHour[1] === compactYmd(d);
      const fallbackNow = `${compactYmd(d)}${pad2(now.getHours())}`;
      const value = isLatest
        ? String(meta.period)
        : (sameDay(d, today) ? fallbackNow : `${compactYmd(d)}23`);
      out.push({ value, label: dayLabel(d, today), month: monthKey(d) });
    } else {
      const value = ymd(d);
      out.push({ value, label: dayLabel(d, today), month: monthKey(d) });
    }
  }
  // 当前期若比客户端日期还新（或上游切日更早），补上，别让默认项落到空响应。
  if (latest && !out.some((x) => x.value === ymd(latest))) {
    out.unshift({ value: ymd(latest), label: dayLabel(latest, today), month: monthKey(latest) });
  }
  return out;
}

/** 生成榜单可查询的近期期次：严格截止到三个月前，最新一期在前。 */
export function recentTopPeriods(meta: ToplistPeriodMeta, now = new Date()): ChartPeriod[] {
  const today = utcDay(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoff = subtractMonths(today, 3);
  const type = inferUpdateType(meta);
  if (type === 0) return weeklyPeriods(meta, today, cutoff);
  return dailyPeriods(meta, today, cutoff, type === 2, now);
}

/** 卡片/信息头里的一行期次文案（不依赖列表，供当前期显示）。 */
export function periodCaption(period?: string): string {
  const p = String(period ?? "").trim();
  if (!p) return "";
  const date = parseYmd(p);
  if (date) return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  const week = /^(\d{4})_(\d{1,2})$/.exec(p);
  if (week) return `${week[1]} 年第 ${Number(week[2])} 周`;
  const hour = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(p);
  if (hour) return `${Number(hour[2])}月${Number(hour[3])}日 ${Number(hour[4])} 时`;
  return p;
}
