import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pickAssignment } = require('../api/_lib/route.js');

const PLAN = { agents: {
  drvA: { mon: ['patna'], tue: ['boring_road'], wed: ['raza_bazar'], thu: ['gola_road'], fri: ['exhibition_road'], sat: ['patna_city'] },
  drvB: { mon: ['gola_road'], tue: ['boring_road'], wed: ['patna'], thu: ['raza_bazar'], fri: ['exhibition_road', 'patna_city'], sat: ['exhibition_road'] },
} };
const plans = { '2026-10': PLAN, '2026-11': PLAN };
const agents = [{ id: 'drvA', name: 'Driver A' }, { id: 'drvB', name: 'Driver B' }];
const ist = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - 330 * 60000;
const SUN = ist(2026, 11, 1, 10, 0);
const run = (o) => pickAssignment({ plans, agents, nowMs: SUN, ...o });

test('route: Patna City, Sunday booking -> Driver B Friday', () => {
  const r = run({ areaId: 'patna_city' });
  assert.equal(r.ok, true); assert.equal(r.agentId, 'drvB'); assert.equal(r.date, '2026-11-06'); assert.equal(r.day, 'fri');
});
test('route: Patna (not Patna City) -> Driver A Monday', () => {
  const r = run({ areaId: 'patna' });
  assert.equal(r.agentId, 'drvA'); assert.equal(r.date, '2026-11-02');
});
test('route: same day 2 drivers -> kam load wala, barabar ho to id order', () => {
  assert.equal(run({ areaId: 'boring_road', loads: { 'drvA|2026-11-03': 5, 'drvB|2026-11-03': 2 } }).agentId, 'drvB');
  assert.equal(run({ areaId: 'boring_road' }).agentId, 'drvA');
});
test('route: cutoff se pehle same day, baad me agla match', () => {
  assert.equal(run({ areaId: 'patna', nowMs: ist(2026, 11, 2, 8, 0) }).date, '2026-11-02');
  const r = run({ areaId: 'patna', nowMs: ist(2026, 11, 2, 10, 0) });
  assert.equal(r.agentId, 'drvB'); assert.equal(r.date, '2026-11-04');
});
test('route: holiday skip', () => {
  const r = run({ areaId: 'patna_city', holidays: ['2026-11-06'] });
  assert.equal(r.agentId, 'drvA'); assert.equal(r.date, '2026-11-07');
});
test('route: month boundary, agla plan missing -> NO_MATCH', () => {
  const now = ist(2026, 10, 31, 10, 0);
  assert.equal(pickAssignment({ plans: { '2026-10': PLAN }, agents, nowMs: now, areaId: 'patna_city' }).reason, 'NO_MATCH');
  assert.equal(pickAssignment({ plans, agents, nowMs: now, areaId: 'patna_city' }).date, '2026-11-06');
});
test('route: leave aur inactive driver skip', () => {
  assert.equal(run({ areaId: 'patna_city', leaves: ['drvB|2026-11-06'] }).date, '2026-11-07');
  const r = run({ areaId: 'patna', agents: [{ id: 'drvA', active: false }, { id: 'drvB', name: 'Driver B' }] });
  assert.equal(r.agentId, 'drvB'); assert.equal(r.date, '2026-11-04');
});
test('route: capacity full -> agla option', () => {
  const r = run({ areaId: 'patna_city', agents: [{ id: 'drvA' }, { id: 'drvB', dailyCapacity: 3 }], loads: { 'drvB|2026-11-06': 3 } });
  assert.equal(r.agentId, 'drvA'); assert.equal(r.date, '2026-11-07');
});
test('route: IST cutoff (UTC 04:00 = IST 09:30, same day nahi)', () => {
  const r = run({ areaId: 'patna', nowMs: Date.UTC(2026, 10, 2, 4, 0) });
  assert.equal(r.agentId, 'drvB'); assert.equal(r.date, '2026-11-04');
});
test('route: area missing ya unknown', () => {
  assert.equal(run({ areaId: '' }).reason, 'NO_AREA');
  assert.equal(run({ areaId: 'xyz' }).reason, 'NO_MATCH');
});
