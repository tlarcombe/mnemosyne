'use strict';

/**
 * dream-topology.js
 *
 * Mnemosyne Void Topology Analysis.
 *
 * Loads all vectors from the LanceDB message index, clusters them with k-means,
 * then analyses the empty space between clusters:
 *
 *   - Saddle points  : minimum-density points on inter-cluster paths
 *                      (creative hotspots where bridging associations emerge)
 *   - Void score     : how empty a saddle region is relative to global density
 *   - B₀             : number of isolated void regions (unknown unknowns)
 *   - B₁             : number of orbital voids (knowledge rings around a gap)
 *   - Bridge candidates : the real memories nearest to each saddle point
 *
 * Usage:
 *   node dream-topology.js [--k N] [--sample N] [--out <path>] [--quiet]
 *
 *   --k N        number of clusters (default: 8)
 *   --sample N   max vectors used for k-means and density estimation (default: 5000)
 *   --out path   write JSON report here (default: ~/.claude/memory/void-topology.json)
 *   --quiet      suppress progress output
 *
 * Writes:
 *   JSON report to --out path
 *   Human-readable summary to stdout
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { projectGroup } = require('./project-group.js');

const HOME       = os.homedir();
const DB_DIR     = path.join(HOME, '.claude', 'lancedb');
const TABLE_NAME = 'messages';
const REPORT_DIR  = path.join(HOME, '.claude', 'memory');
const REPORT_PATH = path.join(REPORT_DIR, 'void-topology.json');
const POINTS_PATH = path.join(REPORT_DIR, 'void-points.json');
const DIMS       = 384;

// ── Argument parsing ──────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
function argVal(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const K          = +argVal('--k',      '8');
const MAX_SAMPLE = +argVal('--sample', '5000');
const OUT_PATH   =  argVal('--out',    REPORT_PATH);
const QUIET      = args.includes('--quiet');

const log = (...a) => { if (!QUIET) process.stderr.write(a.join(' ') + '\n'); };

// ── Typed-array vector math ───────────────────────────────────────────────────
// All vectors in the index are unit-normalised (all-MiniLM-L6-v2, normalize:true).
// For unit vectors: cosine_distance = 1 − dot_product.

/** Dot product of two Float32Array slices. */
function dot(a, aOff, b, bOff) {
  let s = 0;
  for (let i = 0; i < DIMS; i++) s += a[aOff + i] * b[bOff + i];
  return s;
}

/** Cosine distance between two flat-array rows. */
function cosDist(a, aOff, b, bOff) {
  return 1 - dot(a, aOff, b, bOff);
}

/** Cosine distance between two plain JS arrays. */
function cosDistArr(a, b) {
  let s = 0;
  for (let i = 0; i < DIMS; i++) s += a[i] * b[i];
  return 1 - s;
}

/** L2-normalise a plain JS array in-place. */
function normalise(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) + 1e-10;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Linear interpolation between two plain JS arrays. */
function lerp(a, b, t) {
  const r = new Array(DIMS);
  for (let i = 0; i < DIMS; i++) r[i] = a[i] + t * (b[i] - a[i]);
  return r;
}

// ── K-means (typed array, fast) ───────────────────────────────────────────────

/**
 * K-means++ on a Float32Array matrix (n × DIMS, unit-normalised rows).
 * Returns: { assignments: Uint16Array, centroids: Float32Array (k × DIMS) }
 */
function kMeans(mat, n, k, maxIter = 60) {
  const centroids = new Float32Array(k * DIMS);

  // K-means++ seed: pick first centroid at random.
  const firstIdx = Math.floor(Math.random() * n);
  centroids.set(mat.subarray(firstIdx * DIMS, (firstIdx + 1) * DIMS), 0);

  // Pick subsequent centroids proportional to min-distance².
  const minD2 = new Float32Array(n).fill(Infinity);
  for (let ci = 1; ci < k; ci++) {
    // Update minD2 against the newly added centroid (ci−1).
    const prev = ci - 1;
    for (let vi = 0; vi < n; vi++) {
      const d = cosDist(mat, vi * DIMS, centroids, prev * DIMS);
      if (d * d < minD2[vi]) minD2[vi] = d * d;
    }
    let total = 0;
    for (let i = 0; i < n; i++) total += minD2[i];
    let r = Math.random() * total;
    for (let vi = 0; vi < n; vi++) {
      r -= minD2[vi];
      if (r <= 0) {
        centroids.set(mat.subarray(vi * DIMS, (vi + 1) * DIMS), ci * DIMS);
        break;
      }
    }
  }

  const assignments = new Uint16Array(n);
  const newC        = new Float32Array(k * DIMS);
  const counts      = new Uint32Array(k);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // Assignment step.
    for (let vi = 0; vi < n; vi++) {
      let best = 0, bestD = Infinity;
      for (let ci = 0; ci < k; ci++) {
        const d = cosDist(mat, vi * DIMS, centroids, ci * DIMS);
        if (d < bestD) { bestD = d; best = ci; }
      }
      if (assignments[vi] !== best) { assignments[vi] = best; changed = true; }
    }
    if (!changed) break;

    // Update step: recompute centroids, then normalise (so dot = cosine on next iter).
    newC.fill(0);
    counts.fill(0);
    for (let vi = 0; vi < n; vi++) {
      const ci = assignments[vi];
      counts[ci]++;
      for (let d = 0; d < DIMS; d++) newC[ci * DIMS + d] += mat[vi * DIMS + d];
    }
    for (let ci = 0; ci < k; ci++) {
      if (counts[ci] === 0) continue;
      let norm = 0;
      for (let d = 0; d < DIMS; d++) {
        newC[ci * DIMS + d] /= counts[ci];
        norm += newC[ci * DIMS + d] ** 2;
      }
      norm = Math.sqrt(norm) + 1e-10;
      for (let d = 0; d < DIMS; d++) centroids[ci * DIMS + d] = newC[ci * DIMS + d] / norm;
    }
  }

  return { assignments, centroids };
}

// ── Density estimation ────────────────────────────────────────────────────────

/**
 * Kernel density estimate at a plain-array point, given a Float32Array sample matrix.
 * Bandwidth σ in cosine-distance space.
 */
function densityAt(point, sampleMat, sampleN, sigma = 0.18) {
  const inv2sig2 = 1 / (2 * sigma * sigma);
  let d = 0;
  for (let vi = 0; vi < sampleN; vi++) {
    const cd = cosDistArr(point, Array.from(sampleMat.subarray(vi * DIMS, (vi + 1) * DIMS)));
    d += Math.exp(-cd * cd * inv2sig2);
  }
  return d / sampleN;
}

// ── Saddle point detection ────────────────────────────────────────────────────

/**
 * Sample STEPS points along the line between two centroids.
 * Return the point with minimum density (= the mountain pass = saddle point).
 */
function findSaddle(cA, cB, sampleMat, sampleN, steps = 35) {
  let minD = Infinity, best = null, bestT = 0.5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = normalise(lerp(cA, cB, t));
    const d = densityAt(p, sampleMat, sampleN);
    if (d < minD) { minD = d; best = p; bestT = t; }
  }
  return { point: best, density: minD, t: bestT };
}

// ── Void score ────────────────────────────────────────────────────────────────

/**
 * How empty is the region at `point` relative to the overall mean density?
 * Returns a value in [0,1]: 1 = completely empty, 0 = as dense as average.
 */
function voidScore(point, sampleMat, sampleN, globalDensity) {
  const local = densityAt(point, sampleMat, sampleN);  // same σ as globalDensity
  return Math.max(0, Math.min(1, 1 - local / (globalDensity + 1e-12)));
}

// ── Bridge candidates ─────────────────────────────────────────────────────────

/** Find the N stored messages nearest to `point` by cosine distance. */
function nearestMessages(point, rows, n = 4) {
  return rows
    .map(r => ({ r, d: cosDistArr(point, r.vector) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map(({ r, d }) => ({
      text:       r.text.replace(/\s+/g, ' ').trim().slice(0, 110),
      project:    r.project,
      session_id: r.session_id,
      dist:       +d.toFixed(4),
    }));
}

// ── Cluster labelling ─────────────────────────────────────────────────────────

const STOP = new Set(
  'the a an is are was were be been being have has had do does did will would could should may might can that this these those with from for and or but not it its in on at to of as by we i you they he she claude message user assistant session project memory context just also some like more get use make see know think time new work need want way good great well very much how what when where who which all any back even still such than then there too both its own'.split(' ')
);

function labelCluster(rows) {
  const freq = {};
  for (const r of rows) {
    for (const w of r.text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
      if (w.length > 3 && !STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
    }
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w).join(' · ');
}

// ── Betti approximations ──────────────────────────────────────────────────────

/**
 * B₀: count clusters that are farther than `threshold` from every other cluster.
 * These are "islands" — surrounded by empty space, no nearby neighbours.
 */
function approxB0(centroids, k, threshold = 0.50) {
  let isolated = 0;
  for (let i = 0; i < k; i++) {
    let hasNeighbour = false;
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      if (cosDist(centroids, i * DIMS, centroids, j * DIMS) < threshold) {
        hasNeighbour = true;
        break;
      }
    }
    if (!hasNeighbour) isolated++;
  }
  return isolated;
}

/**
 * B₁: count cluster triplets where all three pairwise saddle points score
 * highly as voids — a ring of knowledge that orbits an empty centre.
 */
function approxB1(saddleGrid, k, voidThreshold = 0.70) {
  let loops = 0;
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      for (let l = j + 1; l < k; l++) {
        const sij = saddleGrid[i]?.[j];
        const sjl = saddleGrid[j]?.[l];
        const sil = saddleGrid[i]?.[l];
        if (sij && sjl && sil &&
            sij.void_score > voidThreshold &&
            sjl.void_score > voidThreshold &&
            sil.void_score > voidThreshold) {
          loops++;
        }
      }
    }
  }
  return loops;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('[topology] Connecting to LanceDB...');
  const lancedb = require('@lancedb/lancedb');
  const db = await lancedb.connect(DB_DIR);
  const tables = await db.tableNames();
  if (!tables.includes(TABLE_NAME)) {
    process.stderr.write('[topology] No messages table. Run dream-index.js first.\n');
    process.exit(1);
  }

  const table  = await db.openTable(TABLE_NAME);
  const total  = await table.countRows();
  log(`[topology] Loading ${total} vectors...`);

  // Load all rows. We need text + vector for both clustering and bridge detection.
  const rawRows = await table.query().limit(200000).toArray();
  const allRows = rawRows.map(r => {
    const { group, sub } = projectGroup(r.project_path, r.project);
    return {
      vector:     Array.from(r.vector),   // plain array for bridge search
      text:       r.text,
      project:    group,
      subproject: sub,
      session_id: r.session_id,
    };
  });
  const N = allRows.length;
  log(`[topology] Loaded ${N} rows.`);

  // Build flat typed-array matrix for fast k-means.
  // For the clustering sample, pick evenly-spaced indices if N > MAX_SAMPLE.
  const sampleIdxs = N <= MAX_SAMPLE
    ? Array.from({ length: N }, (_, i) => i)
    : Array.from({ length: MAX_SAMPLE }, (_, i) => Math.floor(i * N / MAX_SAMPLE));

  const sampleN   = sampleIdxs.length;
  const sampleMat = new Float32Array(sampleN * DIMS);
  for (let si = 0; si < sampleN; si++) {
    const v = allRows[sampleIdxs[si]].vector;
    for (let d = 0; d < DIMS; d++) sampleMat[si * DIMS + d] = v[d];
  }

  log(`[topology] Running k-means (k=${K}, sample=${sampleN})...`);
  const { assignments: sampleAssign, centroids } = kMeans(sampleMat, sampleN, K);

  // Assign ALL rows to nearest centroid (single pass).
  log('[topology] Assigning all rows to clusters...');
  const allAssign = new Uint16Array(N);
  for (let vi = 0; vi < N; vi++) {
    let best = 0, bestD = Infinity;
    const v = allRows[vi].vector;
    for (let ci = 0; ci < K; ci++) {
      const d = cosDistArr(v, Array.from(centroids.subarray(ci * DIMS, (ci + 1) * DIMS)));
      if (d < bestD) { bestD = d; best = ci; }
    }
    allAssign[vi] = best;
  }

  // Build cluster row lists (keep a representative subset for labelling).
  const clusterRows = Array.from({ length: K }, () => []);
  for (let vi = 0; vi < N; vi++) clusterRows[allAssign[vi]].push(allRows[vi]);

  // Compute global density baseline using the sample matrix.
  log('[topology] Computing global density baseline...');
  const globalCentroid = Array.from({ length: DIMS }, (_, d) => {
    let s = 0;
    for (let si = 0; si < sampleN; si++) s += sampleMat[si * DIMS + d];
    return s / sampleN;
  });
  normalise(globalCentroid);
  const globalDensity = densityAt(globalCentroid, sampleMat, sampleN);

  // Extract cluster centroid plain arrays for saddle computation.
  const centroidArrays = Array.from({ length: K }, (_, ci) =>
    Array.from(centroids.subarray(ci * DIMS, (ci + 1) * DIMS))
  );

  log(`[topology] Computing saddle points (${K * (K - 1) / 2} pairs)...`);

  // saddleGrid[i][j] (i < j): saddle point data for that cluster pair.
  const saddleGrid = Array.from({ length: K }, () => ({}));
  const allSaddles = [];

  for (let i = 0; i < K; i++) {
    for (let j = i + 1; j < K; j++) {
      const { point, density, t } = findSaddle(
        centroidArrays[i], centroidArrays[j], sampleMat, sampleN
      );
      const vs      = voidScore(point, sampleMat, sampleN, globalDensity);
      const nearest = nearestMessages(point, allRows, 4);
      const interClusterDist = +cosDistArr(centroidArrays[i], centroidArrays[j]).toFixed(4);

      const sp = {
        clusters:          [i, j],
        inter_cluster_dist: interClusterDist,
        saddle_t:          +t.toFixed(3),
        saddle_density:    +density.toFixed(6),
        void_score:        +vs.toFixed(4),
        nearest_memories:  nearest,
      };
      saddleGrid[i][j] = sp;
      allSaddles.push(sp);
    }
  }

  log('[topology] Computing Betti approximations...');
  const B0 = approxB0(centroids, K, 0.50);
  const B1 = approxB1(saddleGrid, K, 0.70);

  // Sort saddle points: highest void score first (most interesting).
  const topSaddles = [...allSaddles]
    .sort((a, b) => b.void_score - a.void_score)
    .slice(0, 8);

  // Cluster summaries — label by top words.
  const clusters = clusterRows.map((rows, i) => ({
    id:                 i,
    size:               rows.length,
    label:              labelCluster(rows.slice(0, 300)),
    top_memories:       rows.slice(0, 3).map(r => r.text.replace(/\s+/g, ' ').slice(0, 120)),
    inter_cluster_dists: Object.fromEntries(
      allSaddles
        .filter(s => s.clusters[0] === i || s.clusters[1] === i)
        .map(s => {
          const other = s.clusters[0] === i ? s.clusters[1] : s.clusters[0];
          return [other, s.inter_cluster_dist];
        })
    ),
  }));

  const report = {
    generated_at:     new Date().toISOString(),
    total_vectors:    N,
    sample_size:      sampleN,
    k:                K,
    global_density:   +globalDensity.toFixed(6),
    clusters,
    saddle_points:    allSaddles.sort((a, b) => b.void_score - a.void_score),
    topology: {
      B0_isolated_voids:  B0,
      B1_orbital_voids:   B1,
      top_creative_hotspots: topSaddles.map(s => ({
        between: s.clusters,
        void_score: s.void_score,
        nearest: s.nearest_memories[0]?.text.slice(0, 80) ?? '',
      })),
    },
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  log(`[topology] Report written → ${OUT_PATH}`);

  // Write points file: cluster assignment + truncated text for each message.
  // This is used by prepare-viz.js to build the explorable viz layer.
  log('[topology] Writing points file...');
  const pointsPayload = {
    generated_at: new Date().toISOString(),
    k: K,
    points: allRows.map((r, vi) => [
      allAssign[vi],
      r.text.replace(/\s+/g, ' ').trim().slice(0, 220),
      r.project || '',
      r.subproject || '',
    ]),
  };
  fs.writeFileSync(POINTS_PATH, JSON.stringify(pointsPayload) + '\n');
  log(`[topology] Points file written → ${POINTS_PATH} (${allRows.length} msgs)`);

  // ── Human-readable summary ─────────────────────────────────────────────────
  const w = s => process.stdout.write(s + '\n');

  w('');
  w('╔══════════════════════════════════════════════════════╗');
  w('║         Mnemosyne  ·  Void Topology Report           ║');
  w('╚══════════════════════════════════════════════════════╝');
  w('');
  w(`  Vectors analysed : ${N.toLocaleString()}`);
  w(`  Clusters (k)     : ${K}`);
  w(`  Global density   : ${globalDensity.toFixed(5)}`);
  w(`  B₀  (isolated)   : ${B0}  — cluster(s) with no semantic neighbour`);
  w(`  B₁  (orbital)    : ${B1}  — topic(s) orbited but never directly addressed`);
  w('');
  w('  Semantic clusters:');
  clusters.forEach(c =>
    w(`    [${c.id}] ${String(c.size).padStart(5)} msgs  ${c.label}`)
  );
  w('');
  w('  Top creative hotspots  (saddle points, highest void score first):');
  topSaddles.forEach((sp, n) => {
    w(`    ${n + 1}.  Clusters ${sp.clusters[0]} ↔ ${sp.clusters[1]}` +
      `   void=${sp.void_score.toFixed(3)}   dist=${sp.inter_cluster_dist.toFixed(3)}`);
    if (sp.nearest_memories[0]) {
      w(`         → "${sp.nearest_memories[0].text.slice(0, 90)}"`);
    }
  });
  w('');
  w(`  Full report: ${OUT_PATH}`);
  w('');
}

if (require.main === module) {
  main().catch(err => { process.stderr.write(err.stack + '\n'); process.exit(1); });
}

module.exports = { kMeans, findSaddle, voidScore, nearestMessages, cosDistArr };
