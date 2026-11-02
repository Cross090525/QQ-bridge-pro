import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveTime} from '../src/core/time-reference.mjs';
test('yesterday saying tomorrow resolves to today in Shanghai', () => {
 const r=resolveTime({referenceTime:Date.parse('2026-11-01T23:30:00+08:00'),offsetDays:1},Date.parse('2026-11-02T10:00:00+08:00'));
 assert.equal(r.targetDate,'2026-11-02');assert.equal(r.isToday,true);
});
test('calendar arithmetic crosses year, leap day and DST boundaries', () => {
 for (const [time,zone,expected] of [['2024-02-28T12:00:00Z','UTC','2024-02-29'],['2026-12-31T12:00:00Z','UTC','2027-01-01'],['2026-03-08T04:30:00Z','America/New_York','2026-03-08']]) assert.equal(resolveTime({referenceTime:Date.parse(time),offsetDays:1,timeZone:zone}).targetDate,expected);
 assert.throws(()=>resolveTime({referenceTime:0}));assert.throws(()=>resolveTime({referenceTime:1,timeZone:'invalid'}));
});
