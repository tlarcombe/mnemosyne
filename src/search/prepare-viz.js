'use strict';

/**
 * prepare-viz.js
 *
 * Reads void-topology.json + void-points.json, strips all raw memory content
 * (nearest_memories, top_memories), truncates point text to 150 chars, and
 * writes sanitized mnemosyne-topology.json + mnemosyne-points.json suitable
 * for serving publicly on the tailnet viz server.
 *
 * Usage:
 *   node prepare-viz.js [--out /path/to/mnemosyne-topology.json]
 *   (points file is written to same dir, replacing "topology" with "points")
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const args      = process.argv.slice(2);
const outIdx    = args.indexOf('--out');
const OUT       = outIdx >= 0 ? args[outIdx + 1] : path.join('/tmp', 'mnemosyne-topology.json');
const OUT_PTS   = OUT.replace('topology', 'points');
const MEM_DIR   = path.join(os.homedir(), '.claude', 'memory');
const SRC       = path.join(MEM_DIR, 'void-topology.json');
const SRC_PTS   = path.join(MEM_DIR, 'void-points.json');

if (!fs.existsSync(SRC)) {
  process.stderr.write(`[prepare-viz] void-topology.json not found at ${SRC}\n`);
  process.stderr.write('[prepare-viz] Run dream-topology.js first.\n');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const safe = {
  generated_at:  data.generated_at,
  total_vectors: data.total_vectors,
  sample_size:   data.sample_size,
  k:             data.k,
  global_density: data.global_density,
  topology:      data.topology,

  clusters: data.clusters.map(c => ({
    id:                  c.id,
    size:                c.size,
    label:               c.label,
    inter_cluster_dists: c.inter_cluster_dists,
    // top_memories: intentionally stripped
  })),

  saddle_points: data.saddle_points.map(s => ({
    clusters:           s.clusters,
    inter_cluster_dist: s.inter_cluster_dist,
    saddle_t:           s.saddle_t,
    saddle_density:     s.saddle_density,
    void_score:         s.void_score,
    // nearest_memories: intentionally stripped
  })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(safe) + '\n');
process.stdout.write(`[prepare-viz] Sanitized topology → ${OUT}\n`);
process.stdout.write(`[prepare-viz] ${safe.clusters.length} clusters, ${safe.saddle_points.length} saddle points\n`);

// Points file — truncate text to 150 chars, keep cluster id and project
if (fs.existsSync(SRC_PTS)) {
  const pts = JSON.parse(fs.readFileSync(SRC_PTS, 'utf8'));
  const safePts = {
    generated_at: pts.generated_at,
    k:            pts.k,
    points: pts.points.map(([ci, text, project, subproject]) => [
      ci,
      (text || '').slice(0, 150),
      project || '',
      subproject || '',
    ]),
  };
  fs.writeFileSync(OUT_PTS, JSON.stringify(safePts) + '\n');
  process.stdout.write(`[prepare-viz] Sanitized points  → ${OUT_PTS}\n`);
  process.stdout.write(`[prepare-viz] ${safePts.points.length} message points\n`);
} else {
  process.stderr.write(`[prepare-viz] void-points.json not found — skipping points file (run dream-topology.js first)\n`);
}
