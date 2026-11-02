// Calendar dates are resolved in an explicit IANA zone, never the server zone.
export function resolveTime({referenceTime, offsetDays = 0, timeZone = 'Asia/Shanghai'}, now = Date.now()) {
  if (!Number.isSafeInteger(referenceTime) || referenceTime <= 0 || !Number.isSafeInteger(offsetDays) || Math.abs(offsetDays) > 36600) throw Error('需要有效的毫秒时间戳及整数日期偏移');
  const format = value => {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(value);
    return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type,p.value]));
  };
  const date = value => { const p = format(value); return `${p.year}-${p.month}-${p.day}`; };
  const p = format(referenceTime);
  const target = new Date(Date.UTC(Number(p.year), Number(p.month)-1, Number(p.day)+offsetDays));
  if (!Number.isFinite(target.getTime())) throw Error('日期超出范围');
  const targetDate = target.toISOString().slice(0,10), currentDate = date(now);
  return {referenceTime, referenceDate:date(referenceTime), offsetDays, timeZone, targetDate, currentTime:now, currentDate, isToday:targetDate === currentDate, precision:'calendar-day'};
}
