#!/usr/bin/env node
'use strict';

/**
 * review-lessons.js
 *
 * Interactive review of pending Mnemosyne lessons.
 *
 * Keys:
 *   v — Verify:  lesson is correct, promote to project Tier 2 memory
 *   s — Skip:    leave in pending for later
 *   d — Discard: lesson is wrong or not useful, remove
 *   q — Quit:    save progress and exit
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HOME = os.homedir();
const EPISODES_DIR = path.join(HOME, '.claude', 'memory', 'episodes');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// ── Helpers ──────────────────────────────────────────────────────────────────

function encodeProjectPath(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function findProjectMemoryDir(projectLabel) {
  // Try to locate ~/.claude/projects/<encoded>/memory/ for this label
  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const entry of entries) {
    const name = entry.name;
    // encoded dir ends with the project label segments
    const suffix = `-${projectLabel}`;
    if (name.endsWith(suffix) || name === encodeProjectPath(projectLabel)) {
      const memDir = path.join(PROJECTS_DIR, name, 'memory');
      return memDir;
    }
  }
  return null;
}

function writeVerifiedLesson(projectLabel, sessionDate, lesson) {
  const memDir = findProjectMemoryDir(projectLabel);
  if (!memDir) return false;

  fs.mkdirSync(memDir, { recursive: true });
  const filePath = path.join(memDir, 'verified-lessons.md');

  const exists = fs.existsSync(filePath);
  if (!exists) {
    fs.writeFileSync(filePath, [
      '---',
      'name: verified-lessons',
      'type: feedback',
      `recorded_at: ${new Date().toISOString().split('T')[0]}`,
      'valid_until: indefinite',
      `scope: project:${projectLabel}`,
      '---',
      '',
      '# Verified Lessons',
      '',
    ].join('\n'), 'utf8');
  }

  const entry = `- [${sessionDate}] ${lesson}\n`;
  fs.appendFileSync(filePath, entry, 'utf8');
  return true;
}

// ── Parse all pending lesson files ───────────────────────────────────────────

function parsePendingFiles() {
  const items = []; // { project, sessionDate, lesson, pendingFile, lessonIndex }

  const projectDirs = fs.readdirSync(EPISODES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const proj of projectDirs) {
    const pendingPath = path.join(EPISODES_DIR, proj, 'pending-lessons.md');
    if (!fs.existsSync(pendingPath)) continue;

    const content = fs.readFileSync(pendingPath, 'utf8');
    const sessionBlocks = content.split(/^## Session /m).filter(b => b.trim());

    for (const block of sessionBlocks) {
      const lines = block.split('\n');
      const sessionDate = lines[0].trim();
      if (!sessionDate.match(/^\d{4}-\d{2}-\d{2}/)) continue;

      const lessons = lines
        .filter(l => /^\d+\.\s/.test(l))
        .map(l => l.replace(/^\d+\.\s*/, '').trim())
        .filter(Boolean);

      lessons.forEach((lesson, idx) => {
        items.push({ project: proj, sessionDate, lesson, pendingFile: pendingPath, lessonIndex: idx });
      });
    }
  }

  return items;
}

// ── Rewrite a pending-lessons.md keeping only skipped items ─────────────────

function rewritePending(pendingFile, toKeep) {
  // toKeep: Set of "sessionDate::lessonIndex" strings
  const content = fs.readFileSync(pendingFile, 'utf8');
  const header = content.split(/^## Session /m)[0];
  const sessionBlocks = content.split(/^## Session /m).filter(b => b.trim());

  const outParts = [header.trimEnd() + '\n'];

  for (const block of sessionBlocks) {
    const lines = block.split('\n');
    const sessionDate = lines[0].trim();
    if (!sessionDate.match(/^\d{4}-\d{2}-\d{2}/)) continue;

    const lessons = lines
      .filter(l => /^\d+\.\s/.test(l))
      .map(l => l.replace(/^\d+\.\s*/, '').trim())
      .filter(Boolean);

    const kept = lessons.filter((_, idx) => toKeep.has(`${sessionDate}::${idx}`));
    if (kept.length === 0) continue;

    outParts.push(`\n## Session ${sessionDate}\n\n`);
    kept.forEach((l, i) => outParts.push(`${i + 1}. ${l}\n`));
  }

  if (outParts.length <= 1) {
    // Nothing left — remove the file
    fs.unlinkSync(pendingFile);
  } else {
    fs.writeFileSync(pendingFile, outParts.join(''), 'utf8');
  }
}

// ── Terminal display ──────────────────────────────────────────────────────────

function clear() { process.stdout.write('\x1b[2J\x1b[H'); }

function render(item, index, total, stats) {
  clear();
  const pct = Math.round((index / total) * 100);
  const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));

  console.log('\x1b[36m╔══════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log(`\x1b[36m║\x1b[0m  Mnemosyne Lesson Review  \x1b[33m${index + 1}/${total}\x1b[0m  [${bar}] \x1b[33m${pct}%\x1b[0m                 \x1b[36m║\x1b[0m`);
  console.log('\x1b[36m╚══════════════════════════════════════════════════════════════╝\x1b[0m');
  console.log();
  console.log(`  \x1b[35mProject:\x1b[0m  ${item.project}`);
  console.log(`  \x1b[35mSession:\x1b[0m  ${item.sessionDate}`);
  console.log();
  console.log('\x1b[37m┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\x1b[0m');
  console.log();

  // Word-wrap the lesson at 60 chars
  const words = item.lesson.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > 62) { lines.push(line.trim()); line = word; }
    else { line = (line + ' ' + word).trim(); }
  }
  if (line) lines.push(line.trim());
  lines.forEach(l => console.log(`  \x1b[97m${l}\x1b[0m`));

  console.log();
  console.log('\x1b[37m┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\x1b[0m');
  console.log();
  console.log('  \x1b[32m[v]\x1b[0m Verify   \x1b[33m[s]\x1b[0m Skip   \x1b[31m[d]\x1b[0m Discard   \x1b[90m[q]\x1b[0m Quit');
  console.log();
  console.log(`  \x1b[32m✓ ${stats.verified}\x1b[0m verified   \x1b[31m✗ ${stats.discarded}\x1b[0m discarded   \x1b[33m→ ${stats.skipped}\x1b[0m skipped`);
}

function renderDone(stats, total) {
  clear();
  console.log('\x1b[36m╔══════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[36m║\x1b[0m  Mnemosyne Lesson Review — Complete                          \x1b[36m║\x1b[0m');
  console.log('\x1b[36m╚══════════════════════════════════════════════════════════════╝\x1b[0m');
  console.log();
  console.log(`  Reviewed:   ${stats.verified + stats.discarded + stats.skipped} / ${total}`);
  console.log(`  \x1b[32mVerified:\x1b[0m   ${stats.verified}  (promoted to project memory)`);
  console.log(`  \x1b[31mDiscarded:\x1b[0m  ${stats.discarded}  (removed)`);
  console.log(`  \x1b[33mSkipped:\x1b[0m    ${stats.skipped}  (remain in pending)`);
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const items = parsePendingFiles();

  if (items.length === 0) {
    console.log('No pending lessons to review.');
    return;
  }

  // Track which items to keep (skipped) per pending file
  // key: pendingFile, value: Set of "sessionDate::lessonIndex"
  const keepMap = new Map();
  const stats = { verified: 0, discarded: 0, skipped: 0 };

  // Initialise keepMap — start with everything kept, then remove verified/discarded
  for (const item of items) {
    if (!keepMap.has(item.pendingFile)) keepMap.set(item.pendingFile, new Set());
    keepMap.get(item.pendingFile).add(`${item.sessionDate}::${item.lessonIndex}`);
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  let index = 0;

  const processKey = (key) => {
    if (!key) return;
    const ch = key.toLowerCase();

    if (ch === 'q') {
      // Flush and exit
      flush();
      renderDone(stats, items.length);
      process.exit(0);
    }

    if (index >= items.length) return;
    const item = items[index];

    if (ch === 'v') {
      // Verify: write to project memory, remove from pending
      writeVerifiedLesson(item.project, item.sessionDate, item.lesson);
      keepMap.get(item.pendingFile).delete(`${item.sessionDate}::${item.lessonIndex}`);
      stats.verified++;
      index++;
    } else if (ch === 'd') {
      // Discard: remove from pending
      keepMap.get(item.pendingFile).delete(`${item.sessionDate}::${item.lessonIndex}`);
      stats.discarded++;
      index++;
    } else if (ch === 's') {
      // Skip: leave in pending
      stats.skipped++;
      index++;
    } else {
      return; // unknown key, ignore
    }

    if (index >= items.length) {
      flush();
      renderDone(stats, items.length);
      process.exit(0);
    } else {
      render(items[index], index, items.length, stats);
    }
  };

  function flush() {
    for (const [pendingFile, toKeep] of keepMap.entries()) {
      try {
        rewritePending(pendingFile, toKeep);
      } catch (e) {
        process.stderr.write(`Warning: could not rewrite ${pendingFile}: ${e.message}\n`);
      }
    }
  }

  process.stdin.on('keypress', (str, key) => {
    if (key && key.ctrl && key.name === 'c') {
      flush();
      renderDone(stats, items.length);
      process.exit(0);
    }
    processKey(str);
  });

  render(items[0], 0, items.length, stats);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
