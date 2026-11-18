/** Calendar dates are evaluated in Jakarta; database tgl_system is YYYY-MM-DD. */
export function weeklyRestockPeriod(requestedMonth?: string, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const parts = Object.fromEntries(today.map(part => [part.type, part.value]));
  const todayIso = `${parts.year}-${parts.month}-${parts.day}`;
  const currentMonth = todayIso.slice(0, 7), month = requestedMonth ?? currentMonth;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900 || month > currentMonth) throw new Error('Bulan analisis harus YYYY-MM, bulan berjalan atau lampau.');
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const selectedThrough = month === currentMonth ? todayIso : monthEnd;
  const selectedEnd = new Date(`${selectedThrough}T00:00:00Z`);
  const start = new Date(selectedEnd); start.setUTCDate(start.getUTCDate() - 6);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const previousMonthDate = (date: Date) => {
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)).getUTCDate();
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, Math.min(date.getUTCDate(), lastDay)));
  };
  const forecastStart = new Date(selectedEnd); forecastStart.setUTCDate(forecastStart.getUTCDate() + 1);
  const forecastEnd = new Date(selectedEnd); forecastEnd.setUTCDate(forecastEnd.getUTCDate() + 7);
  const comparisonStart = previousMonthDate(start), comparisonEnd = previousMonthDate(selectedEnd);
  const comparisonElapsedDays = Math.round((comparisonEnd.getTime() - comparisonStart.getTime()) / 86400000) + 1;
  return { month, selectedFrom: iso(start), selectedThrough, projectionAsOf: selectedThrough,
    comparisonMonth: iso(comparisonEnd).slice(0, 7), comparisonFrom: iso(comparisonStart), comparisonThrough: iso(comparisonEnd),
    comparisonElapsedDays, comparisonDaysInMonth: new Date(Date.UTC(comparisonEnd.getUTCFullYear(), comparisonEnd.getUTCMonth() + 1, 0)).getUTCDate(),
    elapsedDays: 7, remainingDays: 7, daysInMonth, monthEnd, isCurrentMonth: month === currentMonth,
    forecastFrom: iso(forecastStart), forecastThrough: iso(forecastEnd), windowDays: 7, forecastDays: 7, comparisonMode: 'previous-month-same-dates' as const };
}
