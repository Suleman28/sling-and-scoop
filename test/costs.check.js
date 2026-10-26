import assert from 'node:assert/strict';
import { fuelBill, netOf, newCareer, recordShift } from '../src/career.js';

const c = newCareer();
// Fuel scales with amount and airframe.
assert.equal(fuelBill(c, 'utility', 1), 2 * fuelBill(c, 'utility', 0.5));
assert.ok(fuelBill(c, 'scout', 1) < fuelBill(c, 'utility', 1) && fuelBill(c, 'utility', 1) < fuelBill(c, 'heavy', 1) && fuelBill(c, 'heavy', 1) <= fuelBill(c, 'bomber', 1));
// The net is banked (and may dip below zero); best shift tracks net.
const st = { earned: 2000, fuel: 520.6, losses: 150 };
assert.equal(netOf(st), 1329);
assert.equal(recordShift(c, st.earned, st.earned - netOf(st)), true);
assert.equal(c.bank, 1329);
assert.equal(c.best, 1329);
assert.equal(recordShift(c, 500, 900), false);
assert.equal(c.bank, 929);
assert.equal(c.best, 1329);
recordShift(c, 0, 1000);
assert.equal(c.bank, -71);
console.log('costs ok');
