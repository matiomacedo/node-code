// The ambient flow field, shared by sim.worker.js (via importScripts) and tests.
// A smooth function of position and wall-clock time, so nearby nodes are pushed
// alike and the speed does not depend on how often the layout ticks.
(function (root) {
  const PERIOD_S = 9; // One full swing of the current.
  const SCALE = 0.0065; // How quickly the field changes across space.
  root.FLOW_PERIOD_S = PERIOD_S;
  root.flowAt = function flowAt(x, y, seconds, seed) {
    const phase = (seconds * 2 * Math.PI) / PERIOD_S;
    return [Math.sin(phase + y * SCALE + seed), Math.cos(phase * 0.83 + x * SCALE + seed * 1.3)];
  };
})(self);
