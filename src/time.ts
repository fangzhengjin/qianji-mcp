import { AppError } from "./errors.ts";

export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 按 IANA 时区名读取指定时刻的当地日历字段 */
export function zoneCalendarParts(epochSeconds: number, timeZone = DEFAULT_TIME_ZONE): CalendarParts {
  return calendarParts(epochSeconds, timeZone);
}
/** 计算 IANA 时区名下指定时刻的当地日历字段，供内部换算使用 */
function calendarParts(epochSeconds: number, timeZone: string): CalendarParts {
  const parts = zoneFormatter(timeZone).formatToParts(epochSeconds * 1000);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  return {
    year: map.year ?? 1970,
    month: map.month ?? 1,
    day: map.day ?? 1,
    hour: map.hour ?? 0,
    minute: map.minute ?? 0,
    second: map.second ?? 0,
  };
}

/** 解析带时区偏移的 ISO 8601 时刻为 Unix 秒 */
export function parseIsoTime(value: string, field: string): number {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new AppError("INVALID_TIME", `${field} 必须是带时区偏移的 ISO 8601 时刻，例如 2026-07-26T23:43:38+08:00`);
  }
  const epochSeconds = Math.floor(Date.parse(value) / 1000);
  if (epochSeconds < 0) {
    throw new AppError("INVALID_TIME", `${field} 不能早于 1970-01-01T00:00:00Z`);
  }
  return epochSeconds;
}

/** 计算指定时刻在目标时区的偏移秒数，夏令时按该时刻实际生效值 */
export function zoneOffsetSeconds(timeZone: string, epochSeconds: number): number {
  const parts = calendarParts(epochSeconds, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000;
  return asUtc - epochSeconds;
}

/** 将 Unix 秒格式化为目标时区偏移的 ISO 8601 时刻 */
export function formatIsoTime(epochSeconds: number, timeZone = DEFAULT_TIME_ZONE): string {
  const parts = calendarParts(epochSeconds, timeZone);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const local = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  const offset = zoneOffsetSeconds(timeZone, epochSeconds);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${local}${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
}

/** 返回指定时刻在目标时区所属自然日的零点 Unix 秒 */
export function zoneDayStart(epochSeconds: number, timeZone = DEFAULT_TIME_ZONE): number {
  const parts = calendarParts(epochSeconds, timeZone);
  return zoneDayEpoch(parts.year, parts.month, parts.day, timeZone);
}

/** 返回目标时区指定日历日的零点 Unix 秒，用前一日中午的偏移规避夏令时凌晨切换边界 */
export function zoneDayEpoch(year: number, month: number, day: number, timeZone = DEFAULT_TIME_ZONE): number {
  const previousNoon = Date.UTC(year, month - 1, day - 1, 12) / 1000;
  const offset = zoneOffsetSeconds(timeZone, previousNoon);
  return Date.UTC(year, month - 1, day) / 1000 - offset;
}

/** 返回指定时刻在目标时区的自然日字符串（YYYY-MM-DD） */
export function zoneDateKey(epochSeconds: number, timeZone = DEFAULT_TIME_ZONE): string {
  const parts = calendarParts(epochSeconds, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** 返回指定时刻在目标时区的年月或年月日分桶键 */
export function zonePeriodKey(epochSeconds: number, unit: "year" | "month" | "day", timeZone = DEFAULT_TIME_ZONE): string {
  const parts = calendarParts(epochSeconds, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = String(parts.year).padStart(4, "0");
  if (unit === "year") return year;
  if (unit === "month") return `${year}-${pad(parts.month)}`;
  return `${year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** 校验 IANA 时区名是否可用 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}
