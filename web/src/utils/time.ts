// 全站时间统一按 +8 东八区（北京时间 / Asia/Shanghai）渲染。
//
// 后端绝大多数时间戳是 UTC（ISO 8601 带 Z 后缀，或 unix 秒/毫秒）。直接
// `new Date(s).toLocaleString()` 会随浏览器所在时区漂移，所以这里统一在
// 一个文件里锁死 timeZone: 'Asia/Shanghai'，UI 任何位置渲染人类可读的日期/
// 时间都走这里，不再随地 `new Date` + `toLocale*`。
//
// 数字千分位（`(123).toLocaleString()`）不属于日期范畴，不在此处理。

const TZ = 'Asia/Shanghai';
const LOCALE = 'zh-CN';

type TimeInput = string | number | Date | null | undefined;

function toDate(input: TimeInput): Date | null {
  if (input === null || input === undefined || input === '') return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parts(d: Date, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, hour12: false, ...opts }).formatToParts(d)) {
    out[p.type] = p.value;
  }
  return out;
}

/** `YYYY-MM-DD HH:mm:ss`（东八区）。无效输入返回 fallback。 */
export function fmtDateTime(input: TimeInput, fallback = '—'): string {
  const d = toDate(input);
  if (!d) return fallback;
  const p = parts(d, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** `YYYY-MM-DD`（东八区）。 */
export function fmtDate(input: TimeInput, fallback = '—'): string {
  const d = toDate(input);
  if (!d) return fallback;
  const p = parts(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/** `HH:mm:ss`（东八区）。 */
export function fmtTime(input: TimeInput, fallback = '—'): string {
  const d = toDate(input);
  if (!d) return fallback;
  const p = parts(d, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** `HH:mm`（图表 X 轴用，东八区）。 */
export function fmtHourMinute(input: TimeInput, fallback = '—'): string {
  const d = toDate(input);
  if (!d) return fallback;
  const p = parts(d, { hour: '2-digit', minute: '2-digit' });
  return `${p.hour}:${p.minute}`;
}
