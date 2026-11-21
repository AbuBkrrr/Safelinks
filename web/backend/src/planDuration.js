// Single source of truth for how long a plan lasts.
// Plans carry either duration_value + duration_unit, or only the legacy
// text `duration` ("daily", "weekly", "monthly", "3months", "12hours").
const UNIT_MS = {
  minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3,
  month: 30 * 86400e3, year: 365 * 86400e3,
};
const ALIAS = { daily: [1, "day"], weekly: [1, "week"], monthly: [1, "month"], yearly: [1, "year"], annually: [1, "year"], hourly: [1, "hour"] };

function unitMs(u) {
  const k = String(u || "day").toLowerCase().replace(/s$/, "").replace(/^(min|mins)$/, "minute").replace(/^(hr|hrs)$/, "hour");
  return UNIT_MS[k] || UNIT_MS.day;
}

export function planDurationMs(plan, fallbackDays = 30) {
  if (!plan) return fallbackDays * UNIT_MS.day;
  if (Number(plan.duration_value) > 0) return Number(plan.duration_value) * unitMs(plan.duration_unit);
  const t = String(plan.duration || "").trim().toLowerCase();
  if (ALIAS[t]) return ALIAS[t][0] * unitMs(ALIAS[t][1]);
  const m = t.match(/^(\d+)\s*([a-z]+)$/);
  if (m) return Number(m[1]) * unitMs(m[2]);
  return fallbackDays * UNIT_MS.day;
}

// RouterOS limit-uptime string, e.g. "1d", "7d", "12h".
export function planUptime(plan) {
  const ms = planDurationMs(plan);
  return ms % 86400e3 === 0 ? `${ms / 86400e3}d` : `${Math.max(1, Math.round(ms / 3600e3))}h`;
}
