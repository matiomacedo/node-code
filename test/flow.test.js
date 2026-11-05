'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// web/flow.js is a classic script for the worker; load it the same way.
const sandbox = { self: {}, Math };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/flow.js'), 'utf8'), sandbox);
const { flowAt, FLOW_PERIOD_S } = sandbox.self;

const close = (a, b) => Math.abs(a - b) < 1e-9;

test('the flow field repeats after its period, measured in seconds', () => {
  assert.ok(close(flowAt(40, 70, 0, 0.3)[0], flowAt(40, 70, FLOW_PERIOD_S, 0.3)[0]));
  assert.ok(!close(flowAt(40, 70, 0, 0.3)[0], flowAt(40, 70, FLOW_PERIOD_S / 2, 0.3)[0]));
});

test('nearby nodes get nearly the same push, so they drift together', () => {
  const [ax, ay] = flowAt(100, 100, 3, 0.2);
  const [bx, by] = flowAt(104, 103, 3, 0.2);
  assert.ok(Math.hypot(ax - bx, ay - by) < 0.05);
});

test('the push is a unit-scale direction', () => {
  for (let s = 0; s < 20; s += 0.7) {
    const [x, y] = flowAt(s * 13, s * 7, s, 0.5);
    assert.ok(Math.abs(x) <= 1 && Math.abs(y) <= 1);
  }
});
