'use strict';
// Route plan auto-assign: customer ke area ke hisaab se sabse pehla driver + din.
// Saari date/weekday calculation IST (Asia/Kolkata) me. Sunday aur holidays skip.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const IST_MS = 330 * 60000;
const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, '0');

function istParts(ms) {
  const d = new Date(ms + IST_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function ymd(utcMs) {
  const d = new Date(utcMs);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function cutoffMins(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9 * 60;
}

function upcomingDays(nowMs, { sameDayCutoff = '09:00', windowDays = 14, holidays = [] } = {}) {
  const p = istParts(nowMs);
  const base = Date.UTC(p.y, p.m, p.d, 12);
  const start = p.mins < cutoffMins(sameDayCutoff) ? 0 : 1;
  const hol = new Set(holidays || []);
  const out = [];
  for (let i = start; i <= windowDays; i++) {
    const t = base + i * DAY_MS;
    const wd = new Date(t).getUTCDay();
    if (wd === 0) continue;
    const date = ymd(t);
    if (hol.has(date)) continue;
    out.push({ date, day: DAY_KEYS[wd], month: date.slice(0, 7) });
  }
  return out;
}

// plans: { 'YYYY-MM': { agents: { agentId: { mon: [areaId], ... } } } }
// agents: [{ id, name, active, dailyCapacity }]
// leaves: ['agentId|YYYY-MM-DD'], loads: { 'agentId|YYYY-MM-DD': count }
function pickAssignment({ nowMs, areaId, plans = {}, agents = [], leaves = [], loads = {}, holidays = [],
  sameDayCutoff = '09:00', windowDays = 14, defaultCapacity = 60 } = {}) {
  if (!areaId) return { ok: false, reason: 'NO_AREA' };
  const leaveSet = new Set(leaves || []);
  const list = (agents || []).filter((a) => a && a.id && a.active !== false)
    .slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const day of upcomingDays(nowMs, { sameDayCutoff, windowDays, holidays })) {
    const plan = plans[day.month];
    if (!plan || !plan.agents) continue;
    const cands = [];
    for (const a of list) {
      const areas = (plan.agents[a.id] || {})[day.day];
      if (!Array.isArray(areas) || !areas.includes(areaId)) continue;
      if (leaveSet.has(a.id + '|' + day.date)) continue;
      const load = Number(loads[a.id + '|' + day.date] || 0);
      const cap = Number(a.dailyCapacity) > 0 ? Number(a.dailyCapacity) : defaultCapacity;
      if (load >= cap) continue;
      cands.push({ a, load });
    }
    if (cands.length) {
      cands.sort((x, y) => x.load - y.load);
      const w = cands[0];
      return { ok: true, agentId: w.a.id, agentName: w.a.name || 'Agent', date: day.date, day: day.day };
    }
  }
  return { ok: false, reason: 'NO_MATCH' };
}

module.exports = { pickAssignment, upcomingDays, DAY_KEYS };
