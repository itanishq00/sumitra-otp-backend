'use strict';
// Route plan actions (ops.js ke andar). Firestore (sirf admin SDK, rules me koi access nahi):
// routeSettings/{agencyId}, routePlans/{agencyId}__{YYYY-MM}, agentLeaves/{agencyId}__{agentId}__{date}
const { pickAssignment, upcomingDays, DAY_KEYS } = require('./route');

const WORK_DAYS = DAY_KEYS.slice(1);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CUT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULTS = { sameDayCutoff: '09:00', defaultCapacity: 60, windowDays: 14 };
const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (ymd) => { const d = new Date(ymd + 'T12:00:00Z'); return W[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + M[d.getUTCMonth()]; };
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 60);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'area';
const CLOSED_S = ['Rejected', 'Delivered', 'Cancelled'];
const CLOSED_O = ['DELIVERED', 'CANCELLED'];

module.exports = function makeRoute({ db, FV, HttpError, ownerAgency, sendToUsers, ownerUids, audit, safe }) {
  // Test me time fix karne ke liye nowMs sirf emulator par maana jata hai.
  const nowOf = (b) => (process.env.FIRESTORE_EMULATOR_HOST && Number(b && b.nowMs) > 0 ? Number(b.nowMs) : Date.now());

  async function whoIs(dec) {
    try { return { role: 'owner', agencyId: await ownerAgency(dec) }; } catch (e) { if (!(e instanceof HttpError)) throw e; }
    if (dec.role === 'delivery_agent' && dec.agencyId && dec.agentId) return { role: 'agent', agencyId: dec.agencyId, agentId: String(dec.agentId) };
    const c = await db().doc(`customers/${dec.uid}`).get();
    if (c.exists && c.get('agencyId')) return { role: 'customer', agencyId: c.get('agencyId'), customer: c };
    throw new HttpError(403, 'Access nahi hai.');
  }

  async function settingsOf(agencyId) {
    const s = await db().doc(`routeSettings/${agencyId}`).get();
    const d = s.exists ? s.data() : {};
    return {
      areas: Array.isArray(d.areas) ? d.areas : [],
      holidays: Array.isArray(d.holidays) ? d.holidays : [],
      sameDayCutoff: CUT_RE.test(String(d.sameDayCutoff || '')) ? d.sameDayCutoff : DEFAULTS.sameDayCutoff,
      defaultCapacity: Number(d.defaultCapacity) > 0 ? Number(d.defaultCapacity) : DEFAULTS.defaultCapacity,
      windowDays: DEFAULTS.windowDays,
    };
  }
  async function agentsOf(agencyId) {
    const s = await db().collection('deliveryAgents').where('agencyId', '==', agencyId).get();
    return s.docs.map((d) => ({ id: d.id, name: d.get('name') || 'Agent', status: d.get('status') || '', active: d.get('status') === 'ACTIVE', dailyCapacity: d.get('dailyCapacity') }));
  }
  async function planOf(agencyId, month) {
    const p = await db().doc(`routePlans/${agencyId}__${month}`).get();
    return p.exists ? p.data() : null;
  }

  async function computeFor(agencyId, areaId, nowMs, skipId) {
    if (!areaId) return { ok: false, reason: 'NO_AREA' };
    const st = await settingsOf(agencyId);
    if (!st.areas.some((a) => a.id === areaId && a.active !== false)) return { ok: false, reason: 'NO_AREA' };
    const days = upcomingDays(nowMs, st);
    if (!days.length) return { ok: false, reason: 'NO_MATCH' };
    const plans = {};
    for (const m of [...new Set(days.map((d) => d.month))]) { const p = await planOf(agencyId, m); if (p && p.publishedAt) plans[m] = p; }
    if (!Object.keys(plans).length) return { ok: false, reason: 'NO_MATCH' };
    const dates = days.map((d) => d.date).slice(0, 30);
    const [agents, lv, bk] = await Promise.all([
      agentsOf(agencyId),
      db().collection('agentLeaves').where('agencyId', '==', agencyId).where('date', 'in', dates).get(),
      db().collection('bookings').where('agencyId', '==', agencyId).where('expectedDeliveryDate', 'in', dates).get(),
    ]);
    const leaves = lv.docs.map((d) => `${d.get('agentId')}|${d.get('date')}`);
    const loads = {};
    for (const d of bk.docs) {
      if (d.id === skipId || d.get('routeStatus') !== 'PLANNED') continue;
      if (['Rejected', 'Cancelled'].includes(String(d.get('status') || '')) || d.get('orderStatus') === 'CANCELLED') continue;
      const k = `${d.get('routeAgentId')}|${d.get('expectedDeliveryDate')}`;
      loads[k] = (loads[k] || 0) + 1;
    }
    return pickAssignment({ nowMs, areaId, plans, agents, leaves, loads, holidays: st.holidays,
      sameDayCutoff: st.sameDayCutoff, windowDays: st.windowDays, defaultCapacity: st.defaultCapacity });
  }

  const routeOf = (b) => (b.routeStatus === 'PLANNED'
    ? { status: 'PLANNED', agentId: b.routeAgentId, agentName: b.routeAgentName, date: b.expectedDeliveryDate }
    : { status: b.routeStatus || 'NONE' });

  async function assignRoute(bookingId, { force = false, nowMs = Date.now() } = {}) {
    const ref = db().doc(`bookings/${bookingId}`);
    const s = await ref.get();
    if (!s.exists) throw new HttpError(404, 'Booking nahi mili.');
    const b = s.data();
    if (CLOSED_S.includes(String(b.status || '')) || CLOSED_O.includes(String(b.orderStatus || ''))) throw new HttpError(409, 'Ye booking band ho chuki hai.');
    if (b.routeStatus === 'PLANNED' && !force) return { route: routeOf(b) };
    const c = await db().doc(`customers/${b.customerId}`).get();
    const areaId = c.exists ? String(c.get('areaId') || '') : '';
    const r = await computeFor(b.agencyId, areaId, nowMs, bookingId);
    const TS = FV().serverTimestamp();
    if (r.ok) {
      await ref.update({ routeStatus: 'PLANNED', routeAgentId: r.agentId, routeAgentName: r.agentName, expectedDeliveryDate: r.date, routeAreaId: areaId, routeAt: TS, updatedAt: TS });
      await safe(() => sendToUsers([b.customerId], { type: 'ROUTE_PLANNED', agencyId: b.agencyId, bookingId, dedupeKey: `ROUTE_${bookingId}_${r.date}_${r.agentId}`,
        title: 'Delivery date tay ho gayi', body: `Aapka cylinder ${niceDate(r.date)} ko aayega. Delivery partner: ${r.agentName}` }));
      return { route: { status: 'PLANNED', agentId: r.agentId, agentName: r.agentName, date: r.date, day: r.day } };
    }
    await ref.update({ routeStatus: r.reason, routeAgentId: FV().delete(), routeAgentName: FV().delete(), expectedDeliveryDate: FV().delete(),
      routeAreaId: areaId || null, routeAt: TS, updatedAt: TS });
    if (r.reason === 'NO_MATCH') await safe(async () => sendToUsers(await ownerUids(b.agencyId), { type: 'ROUTE_NO_MATCH', agencyId: b.agencyId, bookingId,
      dedupeKey: `ROUTE_NO_MATCH_${bookingId}`, title: 'Driver nahi mila', body: `${b.customerName || 'Customer'}: agle 2 hafte is area me koi driver nahi. Manually assign karo.` }));
    return { route: { status: r.reason } };
  }

  async function settingsGet(dec) {
    const w = await whoIs(dec);
    const st = await settingsOf(w.agencyId);
    if (w.role === 'owner') return { areas: st.areas, holidays: st.holidays, sameDayCutoff: st.sameDayCutoff, defaultCapacity: st.defaultCapacity };
    const out = { areas: st.areas.filter((a) => a.active !== false).map((a) => ({ id: a.id, name: a.name, nameHi: a.nameHi || '' })) };
    if (w.role === 'customer') out.myAreaId = String(w.customer.get('areaId') || '');
    return out;
  }

  async function settingsSave(dec, b) {
    const agencyId = await ownerAgency(dec);
    if (!Array.isArray(b.areas) || b.areas.length > 200) throw new HttpError(400, 'Areas list galat hai.');
    const old = await settingsOf(agencyId);
    const oldIds = new Set(old.areas.map((a) => a.id));
    const seen = new Set(); const names = new Set(); const areas = [];
    for (const a of b.areas) {
      const name = str(a && a.name);
      if (!name) throw new HttpError(400, 'Area ka naam khaali nahi ho sakta.');
      const key = name.toLowerCase();
      if (names.has(key)) throw new HttpError(400, `"${name}" do baar likha hai.`);
      names.add(key);
      let id = str(a.id, 40);
      if (!id || !oldIds.has(id)) id = slug(name) + '_' + Math.random().toString(36).slice(2, 6);
      if (seen.has(id)) throw new HttpError(400, 'Ek area do baar hai.');
      seen.add(id);
      areas.push({ id, name, nameHi: str(a.nameHi), active: a.active !== false });
    }
    // Purane area delete nahi hote, band (inactive) ho jate hain, taaki purani bookings ka id na toote.
    for (const a of old.areas) if (!seen.has(a.id)) areas.push({ ...a, active: false });
    const holidays = Array.isArray(b.holidays)
      ? [...new Set(b.holidays.map((x) => String(x)).filter((x) => DATE_RE.test(x)))].sort().slice(-100) : old.holidays;
    const sameDayCutoff = b.sameDayCutoff !== undefined ? (CUT_RE.test(String(b.sameDayCutoff)) ? String(b.sameDayCutoff) : null) : old.sameDayCutoff;
    if (!sameDayCutoff) throw new HttpError(400, 'Cutoff time HH:MM format me do (jaise 09:00).');
    const cap = b.defaultCapacity !== undefined ? Math.round(Number(b.defaultCapacity)) : old.defaultCapacity;
    if (!(cap >= 1 && cap <= 500)) throw new HttpError(400, 'Capacity 1 se 500 ke beech honi chahiye.');
    await db().doc(`routeSettings/${agencyId}`).set({ agencyId, areas, holidays, sameDayCutoff, defaultCapacity: cap, updatedAt: FV().serverTimestamp(), updatedBy: dec.uid });
    await audit(agencyId, dec.uid, 'owner', 'ROUTE_SETTINGS_SAVED', 'routeSettings', agencyId, { areas: areas.length, holidays: holidays.length });
    return { message: 'Areas save ho gaye.', areas, holidays, sameDayCutoff, defaultCapacity: cap };
  }

  function cleanPlan(input, agentIds, areaIds) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Plan galat hai.');
    const out = {};
    for (const [agentId, days] of Object.entries(input)) {
      if (!agentIds.has(agentId)) throw new HttpError(400, 'Plan me aisa agent hai jo aapki agency ka nahi.');
      if (!days || typeof days !== 'object' || Array.isArray(days)) throw new HttpError(400, 'Plan galat hai.');
      const row = {};
      for (const [day, list] of Object.entries(days)) {
        if (!WORK_DAYS.includes(day)) throw new HttpError(400, 'Din sirf mon se sat tak.');
        if (!Array.isArray(list) || list.length > 20) throw new HttpError(400, 'Areas list galat hai.');
        const ids = [...new Set(list.map((x) => String(x)))];
        for (const id of ids) if (!areaIds.has(id)) throw new HttpError(400, 'Plan me anjaan ya band area hai.');
        if (ids.length) row[day] = ids;
      }
      if (Object.keys(row).length) out[agentId] = row;
    }
    return out;
  }

  async function planGet(dec, b) {
    const agencyId = await ownerAgency(dec);
    const month = String(b.month || '');
    if (!MONTH_RE.test(month)) throw new HttpError(400, 'Month YYYY-MM format me do.');
    const [p, agents, st] = await Promise.all([planOf(agencyId, month), agentsOf(agencyId), settingsOf(agencyId)]);
    const pub = p && p.publishedAt && typeof p.publishedAt.toMillis === 'function' ? p.publishedAt.toMillis() : 0;
    return { month, agents: agents.map(({ id, name, status }) => ({ id, name, status })), areas: st.areas,
      plan: { agents: (p && p.agents) || {}, publishedAtMs: pub } };
  }

  async function planSave(dec, b) {
    const agencyId = await ownerAgency(dec);
    const month = String(b.month || '');
    if (!MONTH_RE.test(month)) throw new HttpError(400, 'Month YYYY-MM format me do.');
    const [agents, st, old] = await Promise.all([agentsOf(agencyId), settingsOf(agencyId), planOf(agencyId, month)]);
    const active = st.areas.filter((a) => a.active !== false);
    const plan = cleanPlan(b.agents, new Set(agents.map((a) => a.id)), new Set(active.map((a) => a.id)));
    const publish = b.publish === true;
    const doc = { agencyId, month, agents: plan, updatedAt: FV().serverTimestamp(), updatedBy: dec.uid };
    if (publish) { doc.publishedAt = FV().serverTimestamp(); doc.publishedBy = dec.uid; }
    else if (old && old.publishedAt) { doc.publishedAt = old.publishedAt; doc.publishedBy = old.publishedBy || null; }
    await db().doc(`routePlans/${agencyId}__${month}`).set(doc);
    const covered = new Set();
    for (const row of Object.values(plan)) for (const l of Object.values(row)) l.forEach((x) => covered.add(x));
    const uncovered = active.filter((a) => !covered.has(a.id)).map((a) => a.name);
    await audit(agencyId, dec.uid, 'owner', publish ? 'ROUTE_PLAN_PUBLISHED' : 'ROUTE_PLAN_SAVED', 'routePlan', `${agencyId}__${month}`, { month, agents: Object.keys(plan).length });
    const live = !!doc.publishedAt;
    return { message: publish ? 'Plan publish ho gaya.' : (live ? 'Plan update ho gaya (live hai).' : 'Plan save ho gaya (draft, abhi live nahi).'), uncovered, published: live };
  }

  async function leave(dec, b) {
    const agencyId = await ownerAgency(dec);
    const agentId = str(b.agentId, 128); const date = String(b.date || '');
    if (!DATE_RE.test(date)) throw new HttpError(400, 'Date YYYY-MM-DD format me do.');
    if (!ID_RE.test(agentId)) throw new HttpError(404, 'Agent aapki agency me nahi mila.');
    const a = await db().doc(`deliveryAgents/${agentId}`).get();
    if (!a.exists || a.get('agencyId') !== agencyId) throw new HttpError(404, 'Agent aapki agency me nahi mila.');
    const ref = db().doc(`agentLeaves/${agencyId}__${agentId}__${date}`);
    const off = b.on === false;
    if (off) await ref.delete();
    else await ref.set({ agencyId, agentId, agentName: a.get('name') || 'Agent', date, createdAt: FV().serverTimestamp(), createdBy: dec.uid });
    await audit(agencyId, dec.uid, 'owner', off ? 'AGENT_LEAVE_REMOVED' : 'AGENT_LEAVE_SET', 'deliveryAgent', agentId, { date });
    return { message: off ? 'Chhutti hata di.' : 'Chhutti lag gayi. Is din naye orders is driver ko nahi milenge.' };
  }

  async function setArea(dec, b) {
    const w = await whoIs(dec);
    let cref; let c;
    if (w.role === 'owner') {
      const cid = str(b.customerId, 128);
      if (!ID_RE.test(cid)) throw new HttpError(404, 'Customer aapki agency me nahi mila.');
      cref = db().doc(`customers/${cid}`); c = await cref.get();
      if (!c.exists || c.get('agencyId') !== w.agencyId) throw new HttpError(404, 'Customer aapki agency me nahi mila.');
    } else if (w.role === 'customer') { c = w.customer; cref = c.ref; }
    else throw new HttpError(403, 'Access nahi hai.');
    if (c.get('verificationStatus') !== 'verified') throw new HttpError(409, 'Pehle customer verify hona chahiye.');
    const areaId = str(b.areaId, 40);
    const st = await settingsOf(w.agencyId);
    const area = st.areas.find((a) => a.id === areaId && a.active !== false);
    if (!area) throw new HttpError(400, 'Ye area list me nahi hai.');
    await cref.update({ areaId, areaName: area.name, updatedAt: FV().serverTimestamp() });
    if (w.role === 'owner') await audit(w.agencyId, dec.uid, 'owner', 'CUSTOMER_AREA_SET', 'customer', cref.id, { areaId });
    return { message: `Area set: ${area.name}`, areaId, areaName: area.name };
  }

  async function assign(dec, b) {
    const w = await whoIs(dec);
    if (w.role === 'agent') throw new HttpError(403, 'Access nahi hai.');
    const id = str(b.bookingId, 128);
    if (!ID_RE.test(id)) throw new HttpError(404, 'Booking nahi mili.');
    const s = await db().doc(`bookings/${id}`).get();
    if (!s.exists) throw new HttpError(404, 'Booking nahi mili.');
    if (w.role === 'customer' && s.get('customerId') !== dec.uid) throw new HttpError(404, 'Booking nahi mili.');
    if (w.role === 'owner' && s.get('agencyId') !== w.agencyId) throw new HttpError(404, 'Booking nahi mili.');
    return assignRoute(id, { force: w.role === 'owner' && b.force === true, nowMs: nowOf(b) });
  }

  async function myRoute(dec, b) {
    const w = await whoIs(dec);
    if (w.role !== 'agent') throw new HttpError(403, 'Sirf delivery agent ke liye.');
    const st = await settingsOf(w.agencyId);
    const names = new Map(st.areas.map((a) => [a.id, a.name]));
    const days = upcomingDays(nowOf(b), { sameDayCutoff: '23:59', windowDays: 6, holidays: st.holidays });
    const cache = {}; const out = [];
    for (const d of days) {
      if (!(d.month in cache)) { const p = await planOf(w.agencyId, d.month); cache[d.month] = p && p.publishedAt ? p : null; }
      const p = cache[d.month];
      const ids = (p && p.agents && p.agents[w.agentId] && p.agents[w.agentId][d.day]) || [];
      const lv = await db().doc(`agentLeaves/${w.agencyId}__${w.agentId}__${d.date}`).get();
      out.push({ date: d.date, day: d.day, label: niceDate(d.date), areaIds: ids, areas: ids.map((x) => names.get(x) || x), leave: lv.exists });
    }
    return { days: out };
  }

  return {
    assignRoute,
    actions: { 'route-settings-get': settingsGet, 'route-settings-save': settingsSave, 'route-plan-get': planGet,
      'route-plan-save': planSave, 'route-leave': leave, 'set-area': setArea, 'route-assign': assign, 'my-route': myRoute },
  };
};
