#!/usr/bin/env node
'use strict';

/**
 * dream-evict.js
 *
 * Mnemosyne Phase 2 — automated EVICT phase.
 *
 * Scans all Tier 0, 1, and 2 memory files. Marks entries whose valid_until
 * date has passed using the bitemporal pattern: never deletes, sets
 * valid_until to superseded-<today> and records the eviction reason.
 *
 * Also warns about memories approaching expiry within 14 days.
 *
 * Usage: node dream-evict.js [--dry-run]
 *   --dry-run   report what would be evicted without writing any files
 *
 * Output (stdout): JSON eviction report
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const TODAY = new Date().toISOString().split('T')[0];
const TODAY_MS = Date.now();
const WARN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function parseArgs() {
  return { dryRun: process.argv.includes('--dry-run') };
}

function getMemoryDirs() {
  const dirs = [];

  const t0 = path.join(CLAUDE_DIR, 'memory', 'permanent');
  if (fs.existsSync(t0)) dirs.push({ tier: 0, dir: t0 });

  const t1 = path.join(CLAUDE_DIR, 'memory', 'feedback');
  if (fs.existsSync(t1)) dirs.push({ tier: 1, dir: t1 });

  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const memDir = path.join(projectsDir, entry.name, 'memory');
      if (fs.existsSync(memDir) && !entry.name.includes('memory-backup')) {
        dirs.push({ tier: 2, dir: memDir, project: entry.name });
      }
    }
  }

  return dirs;
}

function checkFile(filePath, tier, opts) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  if (!content.includes('valid_until:')) return null;

  const validUntilMatch = content.match(/^valid_until:\s*(.+)$/m);
  if (!validUntilMatch) return null;

  const validUntil = validUntilMatch[1].trim();

  if (validUntil === 'indefinite') return null;
  if (validUntil.startsWith('superseded-')) return null;

  let expiryMs;
  try {
    expiryMs = new Date(validUntil).getTime();
    if (isNaN(expiryMs)) return null;
  } catch {
    return null;
  }

  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : path.basename(filePath, '.md');

  if (expiryMs < TODAY_MS) {
    if (!opts.dryRun) {
      const newContent = content.replace(
        /^valid_until:\s*.+$/m,
        `valid_until: superseded-${TODAY}\neviction_reason: expired (was: ${validUntil})`
      );
      try {
        fs.writeFileSync(filePath, newContent);
      } catch (err) {
        return { action: 'error', name, file: filePath, tier, error: err.message };
      }
    }
    return {
      action: 'evicted',
      name,
      file: filePath,
      tier,
      validUntil,
      reason: 'expired',
    };
  }

  if (expiryMs - TODAY_MS < WARN_WINDOW_MS) {
    const daysLeft = Math.round((expiryMs - TODAY_MS) / (24 * 60 * 60 * 1000));
    return {
      action: 'warn',
      name,
      file: filePath,
      tier,
      validUntil,
      reason: `expires in ${daysLeft} days`,
    };
  }

  return null;
}

function main() {
  const opts = parseArgs();
  const dirs = getMemoryDirs();

  const results = { evicted: [], warnings: [], errors: [], scanned: 0 };

  for (const { tier, dir } of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter(
        f => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'assumptions.md'
      );
    } catch {
      continue;
    }

    for (const file of files) {
      results.scanned++;
      const result = checkFile(path.join(dir, file), tier, opts);
      if (!result) continue;
      if (result.action === 'evicted') results.evicted.push(result);
      if (result.action === 'warn') results.warnings.push(result);
      if (result.action === 'error') results.errors.push(result);
    }
  }

  const report = {
    runAt: new Date().toISOString(),
    dryRun: opts.dryRun,
    scanned: results.scanned,
    evicted: results.evicted,
    warnings: results.warnings,
    errors: results.errors,
    summary: `Scanned ${results.scanned} files: ${results.evicted.length} evicted, ${results.warnings.length} approaching expiry, ${results.errors.length} errors`,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(`[dream-evict] ${report.summary}\n`);
}

main();
