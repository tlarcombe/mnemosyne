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
const EMBEDDING_DIMS = 384; // all-MiniLM-L6-v2 output dimension

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
 * Tries sessions-index.json first, then reads cwd from JSONL lines 1-5.
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

  let parseErrors = 0;
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
    } catch {
      parseErrors++;
    }
  }
  if (parseErrors > 0) {
    process.stderr.write(`  [warn] ${path.basename(filePath)}: ${parseErrors} unparseable lines skipped\n`);
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
  const expectedLen = texts.length * EMBEDDING_DIMS;
  if (out.data.length !== expectedLen) {
    throw new Error(`Unexpected embedding output: got ${out.data.length} values, expected ${expectedLen} (${texts.length} texts × ${EMBEDDING_DIMS} dims)`);
  }
  const results = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(Array.from(out.data.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS)));
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
      if (prev && prev.mtime === mtime) continue;

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
      saveManifest(manifest);
      continue;
    }

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
    saveManifest(manifest);
    totalMessages += rows.length;
    totalSessions++;
    process.stderr.write(`  [${totalSessions}/${toIndex.length}] ${projectName}: ${rows.length} messages\n`);
  }
  process.stderr.write(`[dream-index] Done: ${totalMessages} messages from ${totalSessions} sessions.\n`);
}

if (require.main === module) {
  main().catch(err => { process.stderr.write(err.stack + '\n'); process.exit(1); });
}

module.exports = { extractMessages, getProjectName, extractText };
