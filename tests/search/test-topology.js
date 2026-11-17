'use strict';
const assert = require('assert');

const { findSaddle, centerVectors } = require('../../src/search/dream-topology.js');

const DIMS = 384;

// Deterministic PRNG so the test is stable.
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function unit(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}

// Sentence embeddings share a large common direction (mean-vector norm 0.34
// on the real index). Model it as a strong e0 component on every vector, plus
// a cluster direction and isotropic noise.
function point(clusterDim) {
  const v = new Array(DIMS).fill(0);
  v[0] += 1.0;               // shared component
  v[clusterDim] += 0.5;      // cluster identity
  for (let d = 0; d < DIMS; d++) v[d] += (rand() - 0.5) * 0.12;
  return unit(v);
}

function build(dims, perCluster) {
  const vs = [];
  for (const c of dims) for (let i = 0; i < perCluster; i++) vs.push(point(c));
  return vs;
}

function toMat(vs) {
  const m = new Float32Array(vs.length * DIMS);
  vs.forEach((v, i) => m.set(v, i * DIMS));
  return m;
}

function mean(vs) {
  const m = new Array(DIMS).fill(0);
  for (const v of vs) for (let d = 0; d < DIMS; d++) m[d] += v[d];
  return unit(m);
}

// Three clusters; the third is denser so paths have a preferred direction,
// as on the real data where densities differ by cluster.
const raw = [...build([1], 60), ...build([2], 60), ...build([3], 120)];
const idx = { a: [0, 60], b: [60, 120] };
const slice = (vs, [s, e]) => vs.slice(s, e);

// centerVectors: returns new unit vectors, does not mutate input, and removes
// the shared direction.
{
  const before = raw[0].slice();
  const { vectors, mean: mu } = centerVectors(raw);
  assert.deepStrictEqual(raw[0], before, 'input must not be mutated');
  assert.strictEqual(vectors.length, raw.length);
  const n = Math.hypot(...vectors[0]);
  assert.ok(Math.abs(n - 1) < 1e-9, `centred vectors must be unit length, got ${n}`);
  assert.ok(mu[0] > 0.5, 'mean should capture the shared e0 component');
  const residual = Math.hypot(...centerVectors(vectors).mean);
  assert.ok(residual < 0.15, `centred data should have a small mean, got ${residual}`);
}

// With the shared component, the density minimum between two clusters is not
// inside the path. After centring, it is.
{
  const sat = vs => {
    const mat = toMat(vs);
    return findSaddle(mean(slice(vs, idx.a)), mean(slice(vs, idx.b)), mat, vs.length).t;
  };
  const tRaw = sat(raw);
  assert.ok(tRaw === 0 || tRaw === 1, `fixture should reproduce the bug (endpoint saddle), got t=${tRaw}`);
  const tCentred = sat(centerVectors(raw).vectors);
  assert.ok(tCentred > 0 && tCentred < 1, `centred saddle must be interior, got t=${tCentred}`);
}

// typicalDensity: the median density at real points. It must be positive on
// centred data, where the old baseline (density at the normalised mean) is
// taken at an arbitrary direction because the mean is ~0.
{
  const { typicalDensity, densityAt } = require('../../src/search/dream-topology.js');
  const vs = centerVectors(raw).vectors;
  const mat = toMat(vs);
  const typical = typicalDensity(mat, vs.length);
  assert.ok(typical > 0, `typical density must be positive, got ${typical}`);
  const atPoint = densityAt(vs[0], mat, vs.length);
  assert.ok(atPoint > typical / 10, 'a real point should be near typical density');
}

// approxB0: a cluster is isolated only when every saddle touching it is a void.
{
  const { approxB0 } = require('../../src/search/dream-topology.js');
  const s = v => ({ void_score: v });
  // 0-1 connected (low void), 2 separated from both by voids.
  const grid = [{ 1: s(0.1), 2: s(0.9) }, { 2: s(0.95) }, {}];
  assert.strictEqual(approxB0(grid, 3, 0.70), 1, 'only cluster 2 is isolated');
  const allLinked = [{ 1: s(0.1), 2: s(0.2) }, { 2: s(0.3) }, {}];
  assert.strictEqual(approxB0(allLinked, 3, 0.70), 0);
}

console.log('test-topology.js: all assertions passed');
