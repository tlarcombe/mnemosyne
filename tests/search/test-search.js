'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// These imports will fail until memory-search.js exists — that's expected.
const { searchMessages } = require('../../src/search/memory-search.js');
const lancedb = require('../../src/search/node_modules/@lancedb/lancedb');
const { pipeline } = require('../../src/search/node_modules/@xenova/transformers');

async function run() {
  const tmpDb = path.join(os.tmpdir(), `mnem-search-test-${Date.now()}`);
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  const texts = [
    { text: 'How do I configure a rate limit retry in bash scripts?', role: 'user', project: 'ProjectA', project_path: '/p/A', session_id: 'sess1', file_path: '/f1', msg_index: 0, file_mtime: 1 },
    { text: 'The dream cycle consolidates memories every 24 hours.', role: 'assistant', project: 'Mnemosyne', project_path: '/p/M', session_id: 'sess2', file_path: '/f2', msg_index: 0, file_mtime: 2 },
    { text: 'Use fzf to build an interactive picker for projects.', role: 'user', project: 'chloe', project_path: '/p/C', session_id: 'sess3', file_path: '/f3', msg_index: 0, file_mtime: 3 },
  ];

  const db = await lancedb.connect(tmpDb);
  const rows = [];
  for (const row of texts) {
    const out = await embedder(row.text, { pooling: 'mean', normalize: true });
    rows.push({ vector: Array.from(out.data), ...row });
  }
  await db.createTable('messages', rows);

  try {
    // Query 1: should surface the memory/dream row
    const results1 = await searchMessages('memory consolidation dream', { dbPath: tmpDb, limit: 1 });
    assert.strictEqual(results1.length, 1, 'Should return 1 result');
    assert.strictEqual(results1[0].project, 'Mnemosyne', `Expected Mnemosyne, got ${results1[0].project}`);

    // Query 2: should surface the fzf/picker row
    const results2 = await searchMessages('fzf project picker', { dbPath: tmpDb, limit: 1 });
    assert.ok(results2.length >= 1, 'Should return at least 1 result');
    assert.strictEqual(results2[0].project, 'chloe', `Expected chloe, got ${results2[0].project}`);

    // Query 3: project filter — only return ProjectA results
    const results3 = await searchMessages('bash retry', { dbPath: tmpDb, limit: 3, project: 'ProjectA' });
    assert.ok(results3.length >= 1, 'Should have at least one result');
    assert.ok(results3.every(r => r.project === 'ProjectA'), 'All results should be from ProjectA');

    console.log('test-search.js: all assertions passed');
  } finally {
    fs.rmSync(tmpDb, { recursive: true, force: true });
  }
}

run().catch(err => { console.error(err); process.exit(1); });
