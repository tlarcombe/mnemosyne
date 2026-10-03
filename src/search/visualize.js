#!/usr/bin/env node
// Mnemosyne vector space visualizer — 3D interactive (Plotly engine)
// Reads LanceDB, runs UMAP 384D→3D, computes k-NN edges, writes self-contained HTML

'use strict';

const lancedb = require('@lancedb/lancedb');
const { UMAP } = require('umap-js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { projectGroup } = require('./project-group.js');

const DB_PATH = path.join(os.homedir(), '.claude/lancedb');
const OUT_PATH = path.join(os.homedir(), 'Documents/mnemosyne-viz.html');
const N_EPOCHS = 300;
const K_NEIGHBORS = 5;

async function main() {
  console.log('Connecting to LanceDB...');
  const db = await lancedb.connect(DB_PATH);
  const tbl = await db.openTable('messages');

  console.log('Loading vectors...');
  const rows = await tbl.query()
    .select(['vector', 'text', 'role', 'project', 'project_path', 'session_id', 'msg_index'])
    .toArray();
  console.log(`Loaded ${rows.length} messages from ${countProjects(rows)} projects`);

  const vectors = rows.map(r => Array.from(r.vector));
  const meta = rows.map(r => {
    const { group, sub } = projectGroup(r.project_path, r.project);
    return {
      t: truncate(r.text, 400),
      r: r.role,
      p: group,
      u: sub,
      s: r.session_id ? r.session_id.slice(0, 8) : '',
      i: r.msg_index,
    };
  });

  console.log(`Running UMAP 3D (${N_EPOCHS} epochs, ~1-2 min)...`);
  const umap = new UMAP({ nComponents: 3, nNeighbors: 15, minDist: 0.1, nEpochs: N_EPOCHS });
  let last = -1;
  const embedding = await umap.fitAsync(vectors, epoch => {
    const pct = Math.floor((epoch / N_EPOCHS) * 100);
    if (pct !== last && pct % 20 === 0) { process.stdout.write(`  ${pct}%\r`); last = pct; }
  });
  console.log('  100%                    ');

  console.log(`Computing k=${K_NEIGHBORS} nearest-neighbour edges...`);
  const edges = computeKNN(embedding, K_NEIGHBORS);
  console.log(`  ${edges.length} edges`);

  const points = embedding.map(([x, y, z], i) => ({ x, y, z, ...meta[i] }));

  console.log('Writing HTML...');
  fs.writeFileSync(OUT_PATH, buildHTML(points, edges));
  console.log(`\nDone: ${OUT_PATH}`);
  console.log(`Open: xdg-open "${OUT_PATH}"`);
}

function countProjects(rows) {
  return new Set(rows.map(r => r.project)).size;
}

function truncate(s, n) {
  if (!s) return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function computeKNN(coords, k) {
  const n = coords.length;
  const edgeSet = new Set();
  const bestD = new Float64Array(k);
  const bestJ = new Int32Array(k);

  for (let i = 0; i < n; i++) {
    const xi = coords[i][0], yi = coords[i][1], zi = coords[i][2];
    bestD.fill(Infinity); bestJ.fill(-1);
    let worstD = Infinity, worstIdx = 0, filled = 0;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = xi - coords[j][0], dy = yi - coords[j][1], dz = zi - coords[j][2];
      const d2 = dx*dx + dy*dy + dz*dz;
      if (filled < k) {
        bestD[filled] = d2; bestJ[filled] = j; filled++;
        if (filled === k) {
          worstD = bestD[0]; worstIdx = 0;
          for (let m = 1; m < k; m++) if (bestD[m] > worstD) { worstD = bestD[m]; worstIdx = m; }
        }
      } else if (d2 < worstD) {
        bestD[worstIdx] = d2; bestJ[worstIdx] = j;
        worstD = bestD[0]; worstIdx = 0;
        for (let m = 1; m < k; m++) if (bestD[m] > worstD) { worstD = bestD[m]; worstIdx = m; }
      }
    }

    for (let m = 0; m < k; m++) {
      if (bestJ[m] >= 0) {
        const a = Math.min(i, bestJ[m]), b = Math.max(i, bestJ[m]);
        edgeSet.add(a * n + b);
      }
    }
    if (i % 500 === 0) process.stdout.write(`  ${Math.floor(i / n * 100)}%\r`);
  }
  console.log('  100%                    ');
  return [...edgeSet].map(key => [Math.floor(key / n), key % n]);
}

function buildHTML(points, edges) {
  // Use Unicode escape for < to prevent the HTML parser terminating the <script>
  // block when message text contains </script> or similar closing tags.
  // < is completely safe in both HTML and JS (no V8 "unexpected token" risk).
  const dataJson  = JSON.stringify(points).replace(/</g, '\\u003c');
  const edgesJson = JSON.stringify(edges).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mnemosyne — Vector Space 3D</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #020408; color: #e6edf3; font-family: 'Segoe UI', system-ui, sans-serif; overflow: hidden; height: 100vh; }
#plot { width: 100vw; height: 100vh; }

#controls {
  position: fixed; top: 14px; left: 14px; display: flex; gap: 8px;
  z-index: 100; align-items: center;
}
#search {
  background: rgba(22,27,34,0.92); border: 1px solid #30363d; color: #e6edf3;
  padding: 7px 14px; border-radius: 20px; font-size: 13px; width: 230px; outline: none;
  backdrop-filter: blur(8px);
}
#search:focus { border-color: #58a6ff; }
.ctrl-btn {
  background: rgba(22,27,34,0.92); border: 1px solid #30363d; color: #8b949e;
  padding: 7px 12px; border-radius: 20px; font-size: 12px; cursor: pointer;
  backdrop-filter: blur(8px); white-space: nowrap;
}
.ctrl-btn:hover { border-color: #58a6ff; color: #e6edf3; }

#panel {
  position: fixed; right: 0; top: 0; bottom: 0; width: 360px;
  background: rgba(13,17,23,0.97); border-left: 1px solid #30363d;
  z-index: 200; transform: translateX(100%); transition: transform 0.25s ease;
  display: flex; flex-direction: column;
}
#panel.open { transform: translateX(0); }
#panel-header {
  padding: 16px 18px 12px; border-bottom: 1px solid #21262d;
  display: flex; justify-content: space-between; align-items: flex-start; flex-shrink: 0;
}
#panel-project { font-size: 12px; color: #58a6ff; font-weight: 600; margin-bottom: 4px; }
#panel-meta { font-size: 11px; color: #6e7681; }
#panel-close { background: none; border: none; color: #6e7681; cursor: pointer; font-size: 20px; line-height: 1; padding: 2px; }
#panel-close:hover { color: #fff; }
#panel-nav {
  padding: 8px 18px; border-bottom: 1px solid #21262d;
  display: flex; gap: 8px; align-items: center; flex-shrink: 0;
}
#panel-nav button {
  background: #21262d; border: 1px solid #30363d; color: #8b949e;
  padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer;
}
#panel-nav button:hover:not(:disabled) { border-color: #58a6ff; color: #e6edf3; }
#panel-nav button:disabled { opacity: 0.35; cursor: default; }
#panel-nav-info { font-size: 11px; color: #6e7681; margin-left: auto; }
#panel-role { font-size: 10px; padding: 2px 8px; border-radius: 10px; display: inline-block; margin-bottom: 10px; }
#panel-role.user { background: #1f3a54; color: #79c0ff; }
#panel-role.assistant { background: #1a3a2a; color: #56d364; }
#panel-body { padding: 16px 18px; overflow-y: auto; flex: 1; }
#panel-text { font-size: 13px; line-height: 1.65; color: #c9d1d9; white-space: pre-wrap; word-break: break-word; }

#stats { position: fixed; bottom: 14px; left: 14px; font-size: 11px; color: #484f58; z-index: 100; pointer-events: none; }
</style>
</head>
<body>

<div id="plot"></div>

<div id="controls">
  <input id="search" type="text" placeholder="🔍 Filter project or text…" autocomplete="off">
  <button class="ctrl-btn" id="btn-clear">Clear selection</button>
</div>

<div id="panel">
  <div id="panel-header">
    <div>
      <div id="panel-project"></div>
      <div id="panel-meta"></div>
    </div>
    <button id="panel-close">×</button>
  </div>
  <div id="panel-nav">
    <button id="btn-prev">← Prev</button>
    <button id="btn-next">Next →</button>
    <span id="panel-nav-info"></span>
  </div>
  <div id="panel-body">
    <span id="panel-role"></span>
    <div id="panel-text"></div>
  </div>
</div>

<div id="stats"></div>

<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<script>
'use strict';
const DATA  = ${dataJson};
const EDGES = ${edgesJson};
const N = DATA.length;

// ── Palette ───────────────────────────────────────────────────────────────────
const PALETTE = [
  '#58a6ff','#3fb950','#d2a8ff','#ffa657','#ff7b72',
  '#79c0ff','#56d364','#bc8cff','#ffb673','#ff9492',
  '#1f6feb','#238636','#8957e5','#d29922','#da3633',
  '#388bfd','#2ea043','#a371f7','#e3b341','#f85149',
];
const projectList = [...new Set(DATA.map(d => d.p))].sort();
const colorOf = {};
projectList.forEach((p, i) => colorOf[p] = PALETTE[i % PALETTE.length]);

// ── Normalise coords ──────────────────────────────────────────────────────────
function norm(arr) {
  let mn = Infinity, mx = -Infinity;
  arr.forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; });
  const r = mx - mn || 1;
  return arr.map(v => ((v - mn) / r - 0.5) * 10);
}
const XS = norm(DATA.map(d => d.x));
const YS = norm(DATA.map(d => d.y));
const ZS = norm(DATA.map(d => d.z));

// ── Group points by project ───────────────────────────────────────────────────
// Each group stores arrays for Plotly + original DATA indices for the panel
const groups = {};
projectList.forEach(p => {
  groups[p] = { x: [], y: [], z: [], hover: [], idx: [] };
});
DATA.forEach((d, i) => {
  const g = groups[d.p];
  g.x.push(XS[i]); g.y.push(YS[i]); g.z.push(ZS[i]);
  g.hover.push((d.u ? '[' + d.u + '] ' : '') + d.t.slice(0, 150) + (d.t.length > 150 ? '…' : ''));
  g.idx.push(i);
});

// ── Edge trace — null-separated segments, single draw call ───────────────────
const ex = [], ey = [], ez = [];
EDGES.forEach(([i, j]) => {
  ex.push(XS[i], XS[j], null);
  ey.push(YS[i], YS[j], null);
  ez.push(ZS[i], ZS[j], null);
});

// ── Build Plotly traces ───────────────────────────────────────────────────────
const traces = [];

// Edge trace (behind everything)
traces.push({
  type: 'scatter3d', mode: 'lines',
  x: ex, y: ey, z: ez,
  line: { color: 'rgba(120,140,170,0.25)', width: 1.5 },
  hoverinfo: 'none', showlegend: false, name: '_edges',
});

// One point trace per project
projectList.forEach(p => {
  const g = groups[p];
  traces.push({
    type: 'scatter3d', mode: 'markers',
    name: p,
    x: g.x, y: g.y, z: g.z,
    text: g.hover,
    customdata: g.idx,
    marker: {
      size: 4,
      color: colorOf[p],
      opacity: 0.9,
      line: { width: 0 },
    },
    hovertemplate:
      '<b>' + p + '</b><br>' +
      '%{text}' +
      '<extra></extra>',
  });
});

// ── Layout ────────────────────────────────────────────────────────────────────
const layout = {
  paper_bgcolor: '#020408',
  scene: {
    bgcolor: '#020408',
    xaxis: { visible: false, showgrid: false, zeroline: false, showticklabels: false, showspikes: false },
    yaxis: { visible: false, showgrid: false, zeroline: false, showticklabels: false, showspikes: false },
    zaxis: { visible: false, showgrid: false, zeroline: false, showticklabels: false, showspikes: false },
    camera: { eye: { x: 1.4, y: 1.4, z: 1.4 } },
    aspectmode: 'cube',
  },
  legend: {
    bgcolor: 'rgba(22,27,34,0.92)',
    bordercolor: '#30363d',
    borderwidth: 1,
    font: { color: '#c9d1d9', size: 11, family: 'Segoe UI, system-ui, sans-serif' },
    x: 1, xanchor: 'right', y: 1, yanchor: 'top',
    itemclick: 'toggle',
    itemdoubleclick: 'toggleothers',
    tracegroupgap: 2,
  },
  margin: { l: 0, r: 0, t: 0, b: 0 },
  hovermode: 'closest',
};

const config = {
  displaylogo: false,
  displayModeBar: 'hover',
  modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
  scrollZoom: true,
};

Plotly.newPlot('plot', traces, layout, config);

// ── Stats ─────────────────────────────────────────────────────────────────────
document.getElementById('stats').textContent =
  N.toLocaleString() + ' messages · ' + projectList.length + ' projects · ' +
  EDGES.length.toLocaleString() + ' connections  ·  drag to rotate · scroll to zoom';

// ── Search / filter ───────────────────────────────────────────────────────────
// traceOffset: trace 0 = edges, traces 1..N = project traces
const TRACE_OFFSET = 1;

document.getElementById('search').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    // Restore full opacity
    const update = { 'marker.opacity': projectList.map(() => 0.9) };
    const indices = projectList.map((_, i) => i + TRACE_OFFSET);
    Plotly.restyle('plot', update, indices);
    return;
  }
  const opacities = projectList.map((p, pi) => {
    const g = groups[p];
    return g.idx.map(i => {
      const d = DATA[i];
      return (d.p.toLowerCase().includes(q) || d.t.toLowerCase().includes(q)) ? 0.9 : 0.04;
    });
  });
  const indices = projectList.map((_, i) => i + TRACE_OFFSET);
  Plotly.restyle('plot', { 'marker.opacity': opacities }, indices);
});

// ── Detail panel ──────────────────────────────────────────────────────────────
const panel      = document.getElementById('panel');
let sessionPoints = [], sessionIdx = 0;

function openPanel(dataIdx) {
  const sid = DATA[dataIdx].s;
  sessionPoints = DATA
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.s === sid)
    .sort((a, b) => a.d.i - b.d.i);
  sessionIdx = Math.max(0, sessionPoints.findIndex(({ i }) => i === dataIdx));
  renderPanel();
  panel.classList.add('open');
}

function renderPanel() {
  const { d } = sessionPoints[sessionIdx];
  document.getElementById('panel-project').textContent = d.u ? d.p + ' / ' + d.u : d.p;
  document.getElementById('panel-meta').textContent = 'Session ' + d.s + ' · msg ' + d.i;
  const pr = document.getElementById('panel-role');
  pr.textContent = d.r; pr.className = d.r;
  document.getElementById('panel-text').textContent = d.t;
  document.getElementById('panel-nav-info').textContent =
    (sessionIdx + 1) + ' / ' + sessionPoints.length;
  document.getElementById('btn-prev').disabled = sessionIdx === 0;
  document.getElementById('btn-next').disabled = sessionIdx === sessionPoints.length - 1;
}

function closePanel() { panel.classList.remove('open'); }

document.getElementById('btn-prev').addEventListener('click', () => {
  if (sessionIdx > 0) { sessionIdx--; renderPanel(); }
});
document.getElementById('btn-next').addEventListener('click', () => {
  if (sessionIdx < sessionPoints.length - 1) { sessionIdx++; renderPanel(); }
});
document.getElementById('panel-close').addEventListener('click', closePanel);
document.getElementById('btn-clear').addEventListener('click', closePanel);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

// ── Click → open panel ────────────────────────────────────────────────────────
document.getElementById('plot').on('plotly_click', data => {
  const pt = data.points[0];
  if (pt.data.name === '_edges') return;
  const dataIdx = pt.customdata;
  openPanel(dataIdx);
});
</script>
</body>
</html>`;
}

main().catch(err => { console.error(err); process.exit(1); });
