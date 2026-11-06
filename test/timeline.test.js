'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let heatAt, eventsBetween, indexAfter, statsFrom, trailPaths;
test.before(async () => { ({ heatAt, eventsBetween, indexAfter, statsFrom, trailPaths } = await import('../web/timeline.js')); });

const ev = (ts, extra) => ({ ts, id: `c${ts}`, session: 's1', agent: undefined, pulses: [], touched: [], ...extra });
const events = [
  ev(10, { pulses: [{ path: 'a.ts', status: 'reading' }], touched: ['a.ts'] }),
  ev(20, { pulses: [{ path: 'a.ts', status: 'editing' }, { path: 'b.ts', status: 'reading' }], touched: ['a.ts'] }),
  ev(30, { session: 's2', agent: 'helper', pulses: [{ path: 'b.ts', status: 'failed' }], touched: ['b.ts'] }),
  ev(30, { session: 's2', pulses: [{ path: 'c.ts', status: 'created' }], touched: ['c.ts'] }),
];

test('heatAt counts touched paths up to and including t', () => {
  assert.deepEqual([...heatAt(events, 5)], []);
  assert.deepEqual([...heatAt(events, 20)], [['a.ts', 2]]);
  assert.deepEqual([...heatAt(events, 99)], [['a.ts', 2], ['b.ts', 1], ['c.ts', 1]]);
});

test('eventsBetween excludes t0 and includes t1', () => {
  assert.deepEqual(eventsBetween(events, 10, 30).map((e) => e.ts), [20, 30, 30]);
  assert.deepEqual(eventsBetween(events, 0, 10).map((e) => e.ts), [10]);
  assert.deepEqual(eventsBetween(events, 30, 10), []);
  assert.equal(indexAfter(events, 30), 4);
  assert.equal(indexAfter([], 30), 0);
});

test('statsFrom counts only touched paths, by session and agent', () => {
  const all = statsFrom(events);
  assert.deepEqual(all.get('a.ts'), { reads: 1, edits: 1, fails: 0 });
  assert.equal(all.has('b.ts'), true, 'touched by the failed call');
  assert.deepEqual(all.get('b.ts'), { reads: 0, edits: 0, fails: 1 }, 'the untouched read pulse is not counted');
  assert.deepEqual([...statsFrom(events, { session: 's2' }).keys()], ['b.ts', 'c.ts']);
  assert.deepEqual([...statsFrom(events, { agent: 'helper' }).keys()], ['b.ts']);
});

test('trailPaths keeps the latest distinct files, oldest first', () => {
  const entries = [
    { paths: ['a.ts'] },
    { paths: ['b.ts', 'gone.ts'] },
    { paths: ['a.ts'] },
    { paths: [] },
    { paths: ['c.ts', 'd.ts'] },
  ];
  const isFile = (p) => p !== 'gone.ts';
  assert.deepEqual(trailPaths(entries, isFile), ['b.ts', 'a.ts', 'c.ts', 'd.ts']);
  assert.deepEqual(trailPaths(entries, isFile, 2), ['c.ts', 'd.ts']);
});
