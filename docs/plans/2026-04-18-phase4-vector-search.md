# Phase 4: Vector Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic search over the Tier 4 JSONL session archive via LanceDB, exposing it as a `/memory-search` slash command.

**Architecture:** LanceDB (embedded, no server) stores message vectors at `~/.claude/lancedb/`. An incremental indexer (`dream-index.js`) runs during the dream cycle and can also be called standalone. A CLI search tool (`memory-search.js`) embeds a query and returns ranked results. Both use `@xenova/transformers` with `all-MiniLM-L6-v2` (384-dim, cached locally, no API key needed). npm deps are isolated in `~/.claude/skills/mnemosyne/search/node_modules/`.

**Tech Stack:** Node.js (CJS), `@lancedb/lancedb@0.27.2`, `@xenova/transformers@3.x`, Node.js built-in `assert` for tests.

**Spike validated (2026-04-18):** 16ms/message sequential embed+write, 5–24ms query latency, 513 messages indexed in 8.3s across 20 sessions. Batching (32/batch) expected to cut embed time ~4×.

---

## File Structure

```
src/search/
  package.json          ← npm deps: @lancedb/lancedb, @xenova/transformers
  dream-index.js        ← batch indexer: JSONL → embed → LanceDB
  memory-search.js      ← CLI search tool: query → embed → ranked results
  search-skill.md       ← /memory-search slash command

tests/search/
  test-extract.js       ← unit tests for extractMessages(), getProjectName()
  test-search.js        ← integration test: index 3 synthetic messages, query them

install.sh              ← add step [10/10]: deploy search/, npm install, command
src/dream/SKILL.md      ← add Phase 6 INDEX_VECTORS after INDEX
README.md               ← update installer table (10 steps) + Phase 4 status
```

**Deployed to:**
```
~/.claude/skills/mnemosyne/search/
  dream-index.js
  memory-search.js
  package.json
  node_modules/          ← installed by install.sh

~/.claude/commands/
  memory-search.md       ← the /memory-search slash command

~/.claude/lancedb/
  messages.lance/        ← LanceDB table (created on first index run)
  indexed.json           ← manifest: {filePath: {mtime, count}}
```

---

## Task 1: Package setup and test harness

**Files:**
- Create: `src/search/package.json`
- Create: `tests/search/test-extract.js`

- [ ] **Step 1: Create `src/search/package.json`**

```json
{
  "name": "mnemosyne-search",
  "version": "1.0.0",
  "description": "Mnemosyne Phase 4 — semantic search over Tier 4 JSONL archive",
  "main": "dream-index.js",
  "scripts": {
    "test": "node ../../tests/search/test-extract.js && node ../../tests/search/test-search.js"
  },
  "dependencies": {
    "@lancedb/lancedb": "0.27.2",
    "@xenova/transformers": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `tests/search/test-extract.js`**

This tests the two pure functions we'll export from `dream-index.js`. Write it first so we know exactly what those functions must do.

```javascript
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// We're testing extractMessages and getProjectName.
// These will be exported from src/search/dream-index.js.
// For now write the test; the imports will fail until Task 2.
const { extractMessages, getProjectName } = require('../../src/search/dream-index.js');

// ── getProjectName ────────────────────────────────────────────────────────────

{
  // Standard project path: use basename of original path
  const result = getProjectName('/home/tlarcombe/projects/Mnemosyne');
  assert.strictEqual(result, 'Mnemosyne', `Expected 'Mnemosyne', got '${result}'`);
}

{
  // Hyphenated project name stays intact
  const result = getProjectName('/home/tlarcombe/projects/my-cool-app');
  assert.strictEqual(result, 'my-cool-app', `Expected 'my-cool-app', got '${result}'`);
}

{
  // Home dir itself
  const result = getProjectName('/home/tlarcombe');
  assert.strictEqual(result, 'tlarcombe', `Expected 'tlarcombe', got '${result}'`);
}

// ── extractMessages ───────────────────────────────────────────────────────────

{
  // Write a minimal synthetic JSONL file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnem-test-'));
  const filePath = path.join(tmpDir, 'abc123.jsonl');

  const lines = [
    JSON.stringify({ type: 'custom-title', customTitle: 'Test', sessionId: 'abc123' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'How do I set up a git hook?' }, sessionId: 'abc123' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'You can add a pre-commit hook by creating .git/hooks/pre-commit' }, sessionId: 'abc123' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'What about post-commit?' }] }, sessionId: 'abc123' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' }, sessionId: 'abc123' }), // too short — should be skipped
  ].join('\n');

  fs.writeFileSync(filePath, lines);

  const msgs = extractMessages(filePath, 'abc123', 'TestProject', '/home/user/projects/TestProject');

  assert.strictEqual(msgs.length, 3, `Expected 3 messages (1 user + 1 assistant + 1 list-content user), got ${msgs.length}`);

  // First message: plain string content
  assert.strictEqual(msgs[0].role, 'user');
  assert.ok(msgs[0].text.includes('git hook'), `First msg should mention git hook: ${msgs[0].text}`);
  assert.strictEqual(msgs[0].project, 'TestProject');
  assert.strictEqual(msgs[0].session_id, 'abc123');

  // Second message: assistant
  assert.strictEqual(msgs[1].role, 'assistant');
  assert.ok(msgs[1].text.includes('pre-commit'), `Second msg should mention pre-commit: ${msgs[1].text}`);

  // Third message: list content (array with {type:'text',text:'...'})
  assert.strictEqual(msgs[2].role, 'user');
  assert.ok(msgs[2].text.includes('post-commit'), `Third msg should mention post-commit: ${msgs[2].text}`);

  // msg_index values must be sequential and unique within file
  assert.deepStrictEqual(msgs.map(m => m.msg_index), [0, 1, 2]);

  fs.rmSync(tmpDir, { recursive: true });
}

console.log('test-extract.js: all assertions passed');
```

- [ ] **Step 3: Run test to confirm it fails (import error expected)**

```bash
node tests/search/test-extract.js
```

Expected: `Error: Cannot find module '../../src/search/dream-index.js'`

- [ ] **Step 4: Create `tests/search/` directory if missing**

```bash
mkdir -p tests/search
```

---

## Task 2: dream-index.js — JSONL extractor and LanceDB indexer

**Files:**
- Create: `src/search/dream-index.js`

- [ ] **Step 1: Write `src/search/dream-index.js`**

```javascript
'use strict';

/**
 * dream-index.js
 *
 * Mnemosyne Phase 4 — incremental JSONL → LanceDB indexer.
 *
 * Scans ~/.claude/projects/ for JSONL session files, embeds user and assistant
 * messages using all-MiniLM-L6-v2 (local, no API key), and writes them to a
 * LanceDB table at ~/.claude/lancedb/messages.lance/.
 *
 * Incremental: skips files whose mtime hasn't changed since last index run.
 * Manifest stored at ~/.claude/lancedb/indexed.json.
 *
 * Usage:
 *   node dream-index.js [--days N] [--all] [--dry-run]
 *
 *   --days N    only index files modified in last N days (default: 30)
 *   --all       ignore manifest, re-index everything
 *   --dry-run   report what would be indexed, don't write
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const DB_DIR = path.join(HOME, '.claude', 'lancedb');
const MANIFEST_PATH = path.join(DB_DIR, 'indexed.json');
const TABLE_NAME = 'messages';
const BATCH_SIZE = 32;
const MAX_TEXT_LEN = 800;
const MIN_TEXT_LEN = 20;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the human-readable project name from a filesystem path.
 * Uses path.basename() so '/home/user/projects/my-app' → 'my-app'.
 * @param {string} originalPath
 * @returns {string}
 */
function getProjectName(originalPath) {
  return path.basename(originalPath);
}

/**
 * Extracts text from a Claude message content field.
 * Content is either a plain string or an array of content blocks.
 * @param {unknown} content
 * @returns {string}
 */
function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(b => b && typeof b === 'object' && b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * Resolves the original project path from a Claude project directory.
 * Tries sessions-index.json first, then reads cwd from JSONL lines 1–5.
 * @param {string} projectDir  absolute path to ~/.claude/projects/<encoded>/
 * @returns {string|null}
 */
function resolveProjectPath(projectDir) {
  const indexFile = path.join(projectDir, 'sessions-index.json');
  if (fs.existsSync(indexFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (d.originalPath) return d.originalPath;
    } catch {}
  }
  // Fallback: read cwd from first few lines of any JSONL
  const jsonlFiles = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(projectDir, f));
  for (const file of jsonlFiles) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 10);
      for (const line of lines) {
        if (!line.trim()) continue;
        const d = JSON.parse(line);
        if (d.cwd) return d.cwd;
      }
    } catch {}
  }
  return null;
}

/**
 * Extracts indexable messages from a single JSONL session file.
 * Returns rows ready to be embedded (text, metadata — no vector yet).
 * @param {string} filePath
 * @param {string} sessionId
 * @param {string} projectName
 * @param {string} projectPath
 * @returns {Array<{text:string, role:string, project:string, project_path:string, session_id:string, file_path:string, msg_index:number, file_mtime:number}>}
 */
function extractMessages(filePath, sessionId, projectName, projectPath) {
  const mtime = Math.floor(fs.statSync(filePath).mtimeMs / 1000);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const results = [];
  let msgIndex = 0;

  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      const role = d.message && d.message.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractText(d.message.content);
      if (!text || text.length < MIN_TEXT_LEN) continue;
      results.push({
        text: text.slice(0, MAX_TEXT_LEN),
        role,
        project: projectName,
        project_path: projectPath || '',
        session_id: sessionId,
        file_path: filePath,
        msg_index: msgIndex++,
        file_mtime: mtime,
      });
    } catch {}
  }
  return results;
}

// ── Manifest ─────────────────────────────────────────────────────────────────

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function loadEmbedder() {
  const { pipeline } = require('@xenova/transformers');
  return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
}

/**
 * Embeds a batch of texts. Returns array of float32 arrays (384-dim).
 * @param {Function} embedder
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedBatch(embedder, texts) {
  const out = await embedder(texts, { pooling: 'mean', normalize: true });
  // out.data is flat Float32Array of shape [batchSize * 384]
  const dims = 384;
  const results = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(Array.from(out.data.slice(i * dims, (i + 1) * dims)));
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const days = (() => {
    const i = args.indexOf('--days');
    return i >= 0 ? parseInt(args[i + 1], 10) : 30;
  })();
  const reindexAll = args.includes('--all');
  const dryRun = args.includes('--dry-run');

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const manifest = reindexAll ? {} : loadManifest();

  // Collect JSONL files to index
  const toIndex = [];
  const projectDirs = fs.readdirSync(PROJECTS_DIR);

  for (const dir of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const projectPath = resolveProjectPath(dirPath);
    const projectName = projectPath ? getProjectName(projectPath) : dir.split('-').pop();

    const jsonlFiles = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dirPath, f));

    for (const file of jsonlFiles) {
      const stat = fs.statSync(file);
      if (stat.mtimeMs < cutoff) continue;

      const mtime = Math.floor(stat.mtimeMs / 1000);
      const prev = manifest[file];
      if (prev && prev.mtime === mtime) continue; // already indexed at this mtime

      const sessionId = path.basename(file, '.jsonl');
      toIndex.push({ file, sessionId, projectName, projectPath: projectPath || '' });
    }
  }

  if (dryRun) {
    process.stdout.write(`[dream-index] dry-run: ${toIndex.length} files to index\n`);
    for (const item of toIndex) {
      process.stdout.write(`  ${item.projectName} — ${path.basename(item.file)}\n`);
    }
    return;
  }

  if (toIndex.length === 0) {
    process.stderr.write('[dream-index] Nothing to index.\n');
    return;
  }

  process.stderr.write(`[dream-index] Loading embedding model...\n`);
  const embedder = await loadEmbedder();

  process.stderr.write(`[dream-index] Indexing ${toIndex.length} sessions...\n`);

  const lancedb = require('@lancedb/lancedb');
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = await lancedb.connect(DB_DIR);
  const existingTables = await db.tableNames();
  let table = existingTables.includes(TABLE_NAME)
    ? await db.openTable(TABLE_NAME)
    : null;

  let totalMessages = 0;
  let totalSessions = 0;

  for (const { file, sessionId, projectName, projectPath } of toIndex) {
    const rows = extractMessages(file, sessionId, projectName, projectPath);
    if (rows.length === 0) {
      manifest[file] = { mtime: Math.floor(fs.statSync(file).mtimeMs / 1000), count: 0 };
      continue;
    }

    // Embed in batches
    const vectors = [];
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const batchVecs = await embedBatch(embedder, batch.map(r => r.text));
      vectors.push(...batchVecs);
    }

    const lanceRows = rows.map((r, i) => ({ vector: vectors[i], ...r }));

    if (table === null) {
      table = await db.createTable(TABLE_NAME, lanceRows);
    } else {
      await table.add(lanceRows);
    }

    manifest[file] = { mtime: Math.floor(fs.statSync(file).mtimeMs / 1000), count: rows.length };
    totalMessages += rows.length;
    totalSessions++;
    process.stderr.write(`  [${totalSessions}/${toIndex.length}] ${projectName}: ${rows.length} messages\n`);
  }

  saveManifest(manifest);
  process.stderr.write(`[dream-index] Done: ${totalMessages} messages from ${totalSessions} sessions.\n`);
}

// Export pure functions for testing; run main() only when called directly.
if (require.main === module) {
  main().catch(err => { process.stderr.write(err.stack + '\n'); process.exit(1); });
}

module.exports = { extractMessages, getProjectName, extractText };
```

- [ ] **Step 2: Run unit tests — should pass now**

```bash
node tests/search/test-extract.js
```

Expected output: `test-extract.js: all assertions passed`

- [ ] **Step 3: Smoke-test the indexer dry-run (no DB writes)**

```bash
node src/search/dream-index.js --dry-run --days 7
```

Expected: lists sessions modified in last 7 days. No DB files created.

- [ ] **Step 4: Install deps and run a real index of 7 days**

From `src/search/`:

```bash
cd src/search && npm install && cd ../..
node src/search/dream-index.js --days 7 2>&1 | tail -5
```

Expected (stderr):
```
[dream-index] Loading embedding model...
[dream-index] Indexing N sessions...
  [1/N] ProjectName: X messages
  ...
[dream-index] Done: X messages from N sessions.
```

`~/.claude/lancedb/` should now exist with `messages.lance/` and `indexed.json`.

- [ ] **Step 5: Verify DB and manifest**

```bash
ls ~/.claude/lancedb/
python3 -c "import json; d=json.load(open('$HOME/.claude/lancedb/indexed.json')); print(f'{len(d)} files indexed, {sum(v[\"count\"] for v in d.values())} messages total')"
```

Expected: indexed.json shows N files with non-zero counts.

- [ ] **Step 6: Commit**

```bash
git add src/search/package.json src/search/dream-index.js tests/search/test-extract.js
git commit -m "feat: add dream-index.js — incremental LanceDB indexer for Tier 4 JSONL"
```

---

## Task 3: memory-search.js — CLI search tool

**Files:**
- Create: `src/search/memory-search.js`
- Create: `tests/search/test-search.js`

- [ ] **Step 1: Write `tests/search/test-search.js`**

This integration test indexes 3 synthetic messages, then queries them and verifies the right one comes back top.

```javascript
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// We'll test the search function exported from memory-search.js.
// Import will fail until Task 3 Step 2.
const { searchMessages } = require('../../src/search/memory-search.js');
const lancedb = require('../../src/search/node_modules/@lancedb/lancedb');
const { pipeline } = require('../../src/search/node_modules/@xenova/transformers');
const { extractMessages } = require('../../src/search/dream-index.js');

async function run() {
  // Build a temp LanceDB with 3 synthetic rows
  const tmpDb = path.join(os.tmpdir(), `mnem-search-test-${Date.now()}`);
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  const texts = [
    { text: 'How do I configure a rate limit retry in bash scripts?', role: 'user', project: 'ProjectA', project_path: '/p/A', session_id: 'sess1', file_path: '/f1', msg_index: 0, file_mtime: 1 },
    { text: 'The dream cycle consolidates memories every 24 hours.', role: 'assistant', project: 'Mnemosyne', project_path: '/p/M', session_id: 'sess2', file_path: '/f2', msg_index: 0, file_mtime: 2 },
    { text: 'Use fzf to build an interactive picker for projects.', role: 'user', project: 'chloe', project_path: '/p/C', session_id: 'sess3', file_path: '/f3', msg_index: 0, file_mtime: 3 },
  ];

  // Embed all three
  const db = await lancedb.connect(tmpDb);
  const rows = [];
  for (const row of texts) {
    const out = await embedder(row.text, { pooling: 'mean', normalize: true });
    rows.push({ vector: Array.from(out.data), ...row });
  }
  const table = await db.createTable('messages', rows);

  // Query 1: should surface the memory/dream row
  const results1 = await searchMessages('memory consolidation dream', { dbPath: tmpDb, limit: 1 });
  assert.strictEqual(results1.length, 1, 'Should return 1 result');
  assert.strictEqual(results1[0].project, 'Mnemosyne', `Expected Mnemosyne project, got ${results1[0].project}`);

  // Query 2: should surface the fzf/picker row
  const results2 = await searchMessages('fzf project picker', { dbPath: tmpDb, limit: 1 });
  assert.strictEqual(results2[0].project, 'chloe', `Expected chloe project, got ${results2[0].project}`);

  // Query 3: project filter — only return ProjectA results
  const results3 = await searchMessages('bash retry', { dbPath: tmpDb, limit: 3, project: 'ProjectA' });
  assert.ok(results3.every(r => r.project === 'ProjectA'), 'All results should be from ProjectA');

  fs.rmSync(tmpDb, { recursive: true });
  console.log('test-search.js: all assertions passed');
}

run().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run test — should fail (import error)**

```bash
node tests/search/test-search.js
```

Expected: `Error: Cannot find module '../../src/search/memory-search.js'`

- [ ] **Step 3: Write `src/search/memory-search.js`**

```javascript
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
 *
 * Output: formatted search results to stdout.
 * Errors: to stderr.
 */

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const DEFAULT_DB_PATH = path.join(HOME, '.claude', 'lancedb');
const TABLE_NAME = 'messages';

/**
 * Search the LanceDB messages table semantically.
 * @param {string} query  natural-language search query
 * @param {{dbPath?: string, limit?: number, project?: string}} opts
 * @returns {Promise<Array<{text:string, role:string, project:string, project_path:string, session_id:string, file_mtime:number}>>}
 */
async function searchMessages(query, opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const limit = opts.limit || 5;
  const projectFilter = opts.project || null;

  const lancedb = require('@lancedb/lancedb');
  const { pipeline } = require('@xenova/transformers');

  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const out = await embedder(query, { pooling: 'mean', normalize: true });
  const queryVec = Array.from(out.data);

  const db = await lancedb.connect(dbPath);
  const tables = await db.tableNames();
  if (!tables.includes(TABLE_NAME)) {
    return [];
  }

  const table = await db.openTable(TABLE_NAME);
  let search = table.search(queryVec).limit(projectFilter ? limit * 4 : limit);
  const raw = await search.toArray();

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
 * Format a date from epoch seconds into a human-readable relative string.
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
```

- [ ] **Step 4: Run integration test**

```bash
node tests/search/test-search.js
```

Expected: `test-search.js: all assertions passed`

(Note: first run will download the model ~25MB — takes ~10s. Subsequent runs are instant.)

- [ ] **Step 5: Smoke-test the CLI against the real index**

```bash
node src/search/memory-search.js "memory consolidation dream cycle"
```

Expected: formatted results showing sessions from Mnemosyne project. If the index is empty, run: `node src/search/dream-index.js --days 7` first.

- [ ] **Step 6: Commit**

```bash
git add src/search/memory-search.js tests/search/test-search.js
git commit -m "feat: add memory-search.js — semantic CLI search over Tier 4 JSONL"
```

---

## Task 4: /memory-search slash command

**Files:**
- Create: `src/search/search-skill.md`

- [ ] **Step 1: Write `src/search/search-skill.md`**

```markdown
---
name: memory-search
description: "Semantic search over Tier 4 JSONL archive. Finds past sessions matching a natural-language query. Requires /mnemosyne to have been run at least once to build the index."
tags: [memory, search, semantic, mnemosyne, tier4]
---

# /memory-search — Semantic Session History Search

Search your complete session history using natural language.

## Step 1 — Get the query

Extract the search query from the user's request. If not explicitly provided, ask:

> What are you looking for in your session history?

## Step 2 — Check the index exists

```bash
ls ~/.claude/lancedb/indexed.json 2>/dev/null && python3 -c "
import json
d = json.load(open('$HOME/.claude/lancedb/indexed.json'))
total = sum(v['count'] for v in d.values())
print(f'Index: {len(d)} sessions, {total} messages')
" || echo "Index not found — run /mnemosyne first to build it"
```

If the index does not exist, stop and tell the user to run `/mnemosyne`.

## Step 3 — Run the search

Replace `QUERY` with the user's query (quote it):

```bash
node ~/.claude/skills/mnemosyne/search/memory-search.js "QUERY" --limit 5
```

To filter to a specific project:

```bash
node ~/.claude/skills/mnemosyne/search/memory-search.js "QUERY" --limit 5 --project ProjectName
```

## Step 4 — Present results

Report the results to the user. For each result, show:
- Project name and role (user/assistant)
- When the session was (relative time)
- The message excerpt

If results are weak, suggest a broader or different query. If fewer than 3 results, note that a larger index (run `/mnemosyne` to index more sessions) would improve recall.
```

- [ ] **Step 2: Verify the skill renders correctly**

Read the file and confirm it has frontmatter, no placeholders, and all bash blocks are complete.

```bash
head -5 src/search/search-skill.md
grep -c 'TBD\|TODO\|placeholder' src/search/search-skill.md && echo "FAIL: placeholders found" || echo "OK: no placeholders"
```

Expected: frontmatter shown, `0` placeholders, `OK: no placeholders`.

- [ ] **Step 3: Commit**

```bash
git add src/search/search-skill.md
git commit -m "feat: add /memory-search slash command skill"
```

---

## Task 5: Dream cycle integration — INDEX_VECTORS phase

**Files:**
- Modify: `src/dream/SKILL.md` (after the `## Phase 5: INDEX` section, before `## Dream Run Report`)

- [ ] **Step 1: Add Phase 6 to `src/dream/SKILL.md`**

Add the following block immediately after the existing `## Phase 5: INDEX` section (after line ending `Keep MEMORY.md under 200 lines. If over, move oldest entries to \`archive.md\`.`), before `## Dream Run Report`:

```markdown
---

## Phase 6: INDEX_VECTORS

**Goal:** Incrementally update the LanceDB vector index with sessions from the last 30 days.

### 6a: Check search deps are installed

```bash
ls ~/.claude/skills/mnemosyne/search/node_modules/@lancedb 2>/dev/null && echo "deps OK" || echo "MISSING — run: bash ~/projects/Mnemosyne/install.sh"
```

If missing: stop and tell the user to re-run the installer.

### 6b: Run incremental index

```bash
node ~/.claude/skills/mnemosyne/search/dream-index.js --days 30 2>&1
```

Expected output ends with: `[dream-index] Done: N messages from M sessions.`

If it reports `Nothing to index`, all recent sessions are already indexed — that's fine.

### 6c: Verify index stats

```bash
python3 -c "
import json
d = json.load(open('$HOME/.claude/lancedb/indexed.json'))
total = sum(v['count'] for v in d.values())
print(f'Vector index: {len(d)} sessions, {total} messages')
"
```

Add the vector index stats to the Dream Run Report under a `## Vector Index` section.
```

- [ ] **Step 2: Verify the edit is in the right place**

```bash
grep -n 'INDEX_VECTORS\|Phase 5\|Phase 6\|Dream Run Report' src/dream/SKILL.md
```

Expected: `Phase 5` appears before `INDEX_VECTORS`, which appears before `Dream Run Report`.

- [ ] **Step 3: Commit**

```bash
git add src/dream/SKILL.md
git commit -m "feat: add INDEX_VECTORS phase to dream cycle (LanceDB incremental indexing)"
```

---

## Task 6: install.sh update and README

**Files:**
- Modify: `install.sh`
- Modify: `README.md`

- [ ] **Step 1: Add step [10/10] to `install.sh`**

Add the following block after the existing step 9 (deploy chloe), before the `echo ""` / `=== Installation complete ===` line:

```bash
# Step 10: Deploy search/ and install npm deps
echo "[10/10] Deploying Phase 4 vector search..."
SEARCH_DEPLOY="$HOME/.claude/skills/mnemosyne/search"
mkdir -p "$SEARCH_DEPLOY"
cp "$MNEMOSYNE_DIR/src/search/dream-index.js" "$SEARCH_DEPLOY/"
cp "$MNEMOSYNE_DIR/src/search/memory-search.js" "$SEARCH_DEPLOY/"
cp "$MNEMOSYNE_DIR/src/search/package.json" "$SEARCH_DEPLOY/"
echo "  Copied search scripts to $SEARCH_DEPLOY"

# Install npm deps in the deploy dir (idempotent)
npm install --prefix "$SEARCH_DEPLOY" --omit=dev --quiet 2>&1 | tail -3
echo "  npm deps installed in $SEARCH_DEPLOY/node_modules/"

# Deploy /memory-search command
cp "$MNEMOSYNE_DIR/src/search/search-skill.md" "$COMMANDS_DIR/memory-search.md"
echo "  ~/.claude/commands/memory-search.md — OK"
```

- [ ] **Step 2: Update all step counters in install.sh from /9 to /10**

```bash
sed -i 's/\[1\/9\]/[1\/10]/g; s/\[2\/9\]/[2\/10]/g; s/\[3\/9\]/[3\/10]/g; s/\[4\/9\]/[4\/10]/g; s/\[5\/9\]/[5\/10]/g; s/\[6\/9\]/[6\/10]/g; s/\[7\/9\]/[7\/10]/g; s/\[8\/9\]/[8\/10]/g; s/\[9\/9\]/[9\/10]/g' install.sh
```

Verify:

```bash
grep '\[./10\]\|\[10/10\]' install.sh | head -12
```

Expected: 10 lines, each with `[N/10]`.

- [ ] **Step 3: Update README.md installer table**

In `README.md`, find the `### What the installer does` table and update it. Replace the existing table with:

```markdown
| Step | Action |
|------|--------|
| `[1/10]` | Create `~/.claude/memory/permanent/` and `~/.claude/memory/feedback/` |
| `[2/10]` | Deploy Tier 0 seed files (skips if already customised) |
| `[3/10]` | Deploy `mnemosyne-session-start.js` to `~/.claude/scripts/hooks/` |
| `[4/10]` | Deploy `memory-status.md` to `~/.claude/commands/` |
| `[5/10]` | Wire `mnemosyne:session:tiers` as first SessionStart hook in `settings.json` |
| `[6/10]` | Patch `session-start.js` to fix cross-project context bleed |
| `[7/10]` | Deploy `/mnemosyne` dream skill to `~/.claude/skills/mnemosyne/` |
| `[8/10]` | Deploy `mnemosyne-stop.js` and wire it as async Stop hook |
| `[9/10]` | Deploy `chloe` launcher to `~/.local/bin/chloe` |
| `[10/10]` | Deploy Phase 4 search scripts, `npm install`, deploy `/memory-search` command |
```

- [ ] **Step 4: Update README Phase 4 status row**

In the `## Implementation Phases` table in README.md, change:

```
| **Phase 4** — Vector Search | Planned | ChromaDB indexing of Tier 4 JSONL, `/memory-search` command |
```

to:

```
| **Phase 4** — Vector Search | ✅ Complete | LanceDB (embedded) + all-MiniLM-L6-v2 embeddings, `/memory-search` command, dream cycle integration |
```

- [ ] **Step 5: Run the installer to validate step 10**

```bash
bash install.sh 2>&1
```

Expected: all 10 steps print `OK`, no errors. Step 10 should show npm install output and confirmation lines.

- [ ] **Step 6: End-to-end validation**

Run the full pipeline:

```bash
# Index last 7 days
node src/search/dream-index.js --days 7 2>&1

# Search
node src/search/memory-search.js "session memory consolidation"

# Check index stats
python3 -c "import json; d=json.load(open('$HOME/.claude/lancedb/indexed.json')); print(f'{sum(v[\"count\"] for v in d.values())} messages indexed')"
```

Expected: search returns 5 formatted results with project names, roles, and timestamps.

- [ ] **Step 7: Commit and push**

```bash
git add install.sh README.md
git commit -m "feat: Phase 4 complete — wire vector search into installer and dream cycle"
git push origin master
```

---

## Self-Review

**Spec coverage:**
- ✅ LanceDB embedded — no server process, files at `~/.claude/lancedb/`
- ✅ Incremental indexing — manifest tracks mtime, skips unchanged files
- ✅ `--days` flag controls scan window (dream cycle uses 30, standalone defaults to 30)
- ✅ `--all` flag forces full re-index
- ✅ `--dry-run` flag for inspection without writes
- ✅ Batched embedding (BATCH_SIZE=32) for ~4× throughput vs sequential
- ✅ Project filter (`--project`) in CLI and `searchMessages()` API
- ✅ `/memory-search` slash command deployed to `~/.claude/commands/`
- ✅ Dream cycle Phase 6 INDEX_VECTORS integrated
- ✅ install.sh step 10 is idempotent (npm install is safe to re-run)
- ✅ Unit tests for pure functions (`test-extract.js`)
- ✅ Integration test with synthetic LanceDB (`test-search.js`)
- ✅ README updated

**Placeholder scan:** None found.

**Type consistency:**
- `extractMessages()` → `{text, role, project, project_path, session_id, file_path, msg_index, file_mtime}` — used consistently in both dream-index.js and test-extract.js
- `searchMessages()` → same fields minus `vector` — returned by memory-search.js and asserted in test-search.js
- `embedBatch()` takes `embedder` + `string[]`, returns `number[][]` — used only in dream-index.js main()
