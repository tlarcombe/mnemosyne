#!/usr/bin/env node
'use strict';

/**
 * Mnemosyne Phase 1 — memory schema migration.
 *
 * Adds bitemporal frontmatter fields to existing project memory files:
 *   recorded_at  — today's date (approximate)
 *   valid_until  — "indefinite" (dream will refine)
 *   scope        — "project:<name>" derived from directory
 *
 * Safe to run multiple times — skips files that already have recorded_at.
 * Never deletes content. Skips MEMORY.md index files and backup directories.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const TODAY = new Date().toISOString().split('T')[0];

let scanned = 0, migrated = 0, skipped = 0, errors = 0;

const HOME_PREFIX_PATTERNS = [
  `-home-${os.userInfo().username}-projects-`,
  '-mnt-raid0-projects-',
  `-home-${os.userInfo().username}-`,
];

function extractProjectName(encodedDir) {
  for (const prefix of HOME_PREFIX_PATTERNS) {
    if (encodedDir.startsWith(prefix)) {
      return encodedDir.slice(prefix.length);
    }
  }
  return encodedDir;
}

function migrateFile(filePath, projectEncodedDir) {
  scanned++;

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`ERROR reading ${filePath}: ${err.message}`);
    errors++;
    return;
  }

  if (content.includes('recorded_at:')) {
    skipped++;
    return;
  }

  const projectName = extractProjectName(projectEncodedDir);
  const scope = `project:${projectName}`;

  if (!content.startsWith('---\n')) {
    const newFrontmatter = `---
name: ${path.basename(filePath, '.md')}
type: project
recorded_at: ${TODAY}
valid_until: indefinite
scope: ${scope}
---

`;
    try {
      fs.writeFileSync(filePath, newFrontmatter + content);
      console.log(`ADDED frontmatter: ${filePath}`);
      migrated++;
    } catch (err) {
      console.error(`ERROR writing ${filePath}: ${err.message}`);
      errors++;
    }
    return;
  }

  // Has existing frontmatter — inject new fields before closing ---
  const closingIdx = content.indexOf('\n---', 4);
  if (closingIdx === -1) {
    console.warn(`WARN malformed frontmatter in ${filePath} — skipping`);
    skipped++;
    return;
  }

  const injection = `\nrecorded_at: ${TODAY}\nvalid_until: indefinite\nscope: ${scope}`;
  const newContent = content.slice(0, closingIdx) + injection + content.slice(closingIdx);

  try {
    fs.writeFileSync(filePath, newContent);
    console.log(`MIGRATED: ${filePath}`);
    migrated++;
  } catch (err) {
    console.error(`ERROR writing ${filePath}: ${err.message}`);
    errors++;
  }
}

if (!fs.existsSync(PROJECTS_DIR)) {
  console.error(`Projects dir not found: ${PROJECTS_DIR}`);
  process.exit(1);
}

const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

for (const projectDir of projectDirs) {
  const memDir = path.join(PROJECTS_DIR, projectDir, 'memory');
  if (!fs.existsSync(memDir)) continue;
  if (memDir.includes('memory-backup')) continue;

  const files = fs.readdirSync(memDir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'assumptions.md');

  for (const file of files) {
    migrateFile(path.join(memDir, file), projectDir);
  }
}

console.log(`\nMigration complete: ${scanned} scanned, ${migrated} migrated, ${skipped} already had schema, ${errors} errors`);
