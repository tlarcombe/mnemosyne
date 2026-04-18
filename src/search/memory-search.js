'use strict';

/**
 * memory-search.js
 *
 * Mnemosyne Phase 4 — semantic search over Tier 4 JSONL archive.
 *
 * Usage:
 *   node memory-search.js "<query>" [--limit N] [--project <name>]
 *
 *   --limit N       return top N results (default: 5)
 *   --project name  filter to a specific project name
 */

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const DEFAULT_DB_PATH = path.join(HOME, '.claude', 'lancedb');
const TABLE_NAME = 'messages';

let _embedderPromise = null;
function getEmbedder() {
  if (!_embedderPromise) {
    const { pipeline } = require('@xenova/transformers');
    _embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return _embedderPromise;
}

/**
 * Search the LanceDB messages table semantically.
 * @param {string} query
 * @param {{dbPath?: string, limit?: number, project?: string}} opts
 * @returns {Promise<Array<{text:string, role:string, project:string, project_path:string, session_id:string, file_mtime:number}>>}
 */
async function searchMessages(query, opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const limit = opts.limit || 5;
  const projectFilter = opts.project || null;

  const lancedb = require('@lancedb/lancedb');

  const embedder = await getEmbedder();
  const out = await embedder(query, { pooling: 'mean', normalize: true });
  const queryVec = Array.from(out.data);

  const db = await lancedb.connect(dbPath);
  const tables = await db.tableNames();
  if (!tables.includes(TABLE_NAME)) {
    return [];
  }

  const table = await db.openTable(TABLE_NAME);
  // Fetch extra rows when filtering so we have enough after the project filter
  const fetchLimit = projectFilter ? limit * 4 : limit;
  const raw = await table.search(queryVec).limit(fetchLimit).toArray();

  let results = raw;
  if (projectFilter) {
    results = results.filter(r => r.project === projectFilter).slice(0, limit);
  }

  return results.map(r => ({
    text: r.text,
    role: r.role,
    project: r.project,
    project_path: r.project_path,
    session_id: r.session_id,
    file_mtime: r.file_mtime,
  }));
}

/**
 * Format epoch seconds as a human-readable relative string.
 * @param {number} epochSecs
 * @returns {string}
 */
function formatDate(epochSecs) {
  const now = Date.now() / 1000;
  const diff = now - epochSecs;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return 'yesterday';
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(epochSecs * 1000).toISOString().slice(0, 10);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    process.stdout.write('Usage: memory-search.js "<query>" [--limit N] [--project <name>]\n');
    process.exit(0);
  }

  const query = args[0];
  const limit = (() => {
    const i = args.indexOf('--limit');
    return i >= 0 ? parseInt(args[i + 1], 10) : 5;
  })();
  const project = (() => {
    const i = args.indexOf('--project');
    return i >= 0 ? args[i + 1] : null;
  })();

  process.stderr.write('[memory-search] Embedding query...\n');
  const results = await searchMessages(query, { limit, project });

  if (results.length === 0) {
    process.stdout.write('No results found. Run /mnemosyne to build the index.\n');
    return;
  }

  process.stdout.write(`\nSearch results for: "${query}"\n`);
  process.stdout.write('─'.repeat(60) + '\n');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const when = formatDate(r.file_mtime);
    const preview = r.text.replace(/\s+/g, ' ').slice(0, 120);
    process.stdout.write(`\n[${i + 1}] ${r.project} · ${r.role} · ${when}\n`);
    process.stdout.write(`    ${preview}${r.text.length > 120 ? '…' : ''}\n`);
  }
  process.stdout.write('\n');
}

if (require.main === module) {
  main().catch(err => { process.stderr.write(err.stack + '\n'); process.exit(1); });
}

module.exports = { searchMessages, formatDate };
