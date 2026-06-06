#!/usr/bin/env node
'use strict';

/**
 * dream-narrate.js
 *
 * Mnemosyne Phase 5 — NARRATE phase utility.
 *
 * Scans recent JSONL session files that do not yet have an episode file,
 * extracts the conversation into a readable summary, then calls the Claude
 * CLI (haiku model for efficiency) to write a narrative episode and a list
 * of candidate lessons for verification.
 *
 * Output: episode .md files in ~/.claude/memory/episodes/<project>/
 *         pending lessons in ~/.claude/memory/episodes/<project>/pending-lessons.md
 *
 * Usage: node dream-narrate.js [--days N] [--project <encoded-dir>] [--dry-run]
 *   --days N          scan sessions modified in last N days (default: 2)
 *   --project <name>  limit to a specific project's sessions
 *   --dry-run         extract only, do not call Claude or write files
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const EPISODES_DIR = path.join(HOME, '.claude', 'memory', 'episodes');

// Noise prefixes to skip when extracting conversation
const NOISE_PREFIXES = [
  'Base directory for this skill:',
  'This session is being continued from a previous conversation',
  '<task-notification>',
  '<system-reminder>',
  '# Mnemosyne',
  '# Session:',
  'SessionStart hook additional context',
];

// Minimum messages to bother narrating (very short sessions are noise)
const MIN_MESSAGES = 6;

// Max characters of a single message to include in the extract sent to Claude
const MAX_MSG_CHARS = 600;

function isNoise(text) {
  const t = text.trimStart();
  return NOISE_PREFIXES.some(p => t.startsWith(p));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 2, project: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[++i], 10);
    if (args[i] === '--project' && args[i + 1]) opts.project = args[++i];
    if (args[i] === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

function extractText(d) {
  const content = d.message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && c.type === 'text')
      .map(c => c.text || '')
      .join(' ');
  }
  return '';
}

/**
 * Read a JSONL session file and return an array of { role, text } objects,
 * filtered for noise and truncated for size.
 */
function extractConversation(filePath) {
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const messages = [];
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.type !== 'user' && d.type !== 'assistant') continue;
      const text = extractText(d).trim();
      if (!text || isNoise(text)) continue;
      messages.push({
        role: d.type === 'user' ? 'Tony' : 'Claude',
        text: text.length > MAX_MSG_CHARS ? text.slice(0, MAX_MSG_CHARS) + '…' : text,
      });
    } catch {
      // skip malformed
    }
  }
  return messages;
}

/**
 * Derive a human-readable project label from the encoded directory name.
 * e.g. "-home-tlarcombe-projects-larcombe-tech-blog" -> "larcombe-tech-blog"
 */
function projectLabel(encodedDir) {
  const parts = encodedDir.replace(/^-/, '').split('-');
  const idx = parts.indexOf('projects');
  if (idx !== -1) return parts.slice(idx + 1).join('-');
  return encodedDir;
}

/**
 * Derive the episodes subdirectory for a project.
 */
function episodesDir(encodedDir) {
  return path.join(EPISODES_DIR, projectLabel(encodedDir));
}

/**
 * Check whether an episode already exists for this session file.
 * We use the session date (from file mtime) as the key.
 */
function episodeExists(epDir, sessionDate) {
  if (!fs.existsSync(epDir)) return false;
  const files = fs.readdirSync(epDir);
  return files.some(f => f.startsWith(sessionDate) && f.endsWith('.md') && !f.includes('pending'));
}

/**
 * Call claude CLI to generate an episode narrative from a conversation extract.
 * Returns the generated markdown text, or null on failure.
 */
function generateNarrative(projectName, sessionDate, messages) {
  const conversationText = messages
    .map(m => `**${m.role}:** ${m.text}`)
    .join('\n\n');

  const prompt = `You are writing an episodic memory entry for a memory system called Mnemosyne.
The memory will be injected at the start of future sessions to give you continuity.

Project: ${projectName}
Session date: ${sessionDate}

Here is the conversation to narrate:

---
${conversationText}
---

Write TWO sections:

## NARRATIVE
A 200-350 word narrative summary of this session. Write in third person ("Tony" and "Claude").
Capture: what was worked on and why, what was significant or surprising, specific details that
are load-bearing (names, places, technical specifics), emotional register if relevant, how it ended.
This is a memory, not a meeting summary. Preserve the texture of what happened, not just the facts.

## CANDIDATE LESSONS
A numbered list of 2-5 things Claude may have learned in this session that could change how
future sessions go. Each lesson should be specific and actionable. These are UNVERIFIED — they
will be presented to Tony for confirmation.
Format: one lesson per line, plain text, no sub-bullets.

Output only the two sections above. No preamble, no closing remarks.`;

  const result = spawnSync('claude', [
    '-p', prompt,
    '--model', 'claude-haiku-4-5-20251001',
    '--output-format', 'text',
  ], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    process.stderr.write(`[dream-narrate] Claude call failed: ${result.error?.message || result.stderr}\n`);
    return null;
  }

  return result.stdout.trim();
}

/**
 * Parse the Claude output into { narrative, lessons[] }
 */
function parseNarrativeOutput(output) {
  const narrativeMatch = output.match(/##\s*NARRATIVE\s*\n([\s\S]*?)(?=##\s*CANDIDATE LESSONS|$)/i);
  const lessonsMatch = output.match(/##\s*CANDIDATE LESSONS\s*\n([\s\S]*?)$/i);

  const narrative = narrativeMatch ? narrativeMatch[1].trim() : output;
  const lessonsText = lessonsMatch ? lessonsMatch[1].trim() : '';

  const lessons = lessonsText
    .split('\n')
    .map(l => l.replace(/^\d+\.\s*/, '').trim())
    .filter(l => l.length > 10);

  return { narrative, lessons };
}

/**
 * Write the episode file.
 */
function writeEpisode(epDir, sessionDate, projectName, narrative, filePath) {
  fs.mkdirSync(epDir, { recursive: true });

  // Create a slug from the session filename
  const sessionSlug = path.basename(filePath, '.jsonl').slice(0, 8);
  const episodePath = path.join(epDir, `${sessionDate}-${sessionSlug}.md`);

  const content = `---
name: episode-${sessionDate}-${sessionSlug}
type: episode
recorded_at: ${sessionDate}
valid_until: indefinite
scope: project:${projectName}
significance: normal
lessons_verified: false
---

# Episode: ${sessionDate}

**Project:** ${projectName}
**Session:** ${path.basename(filePath)}

---

${narrative}
`;

  fs.writeFileSync(episodePath, content, 'utf8');
  return episodePath;
}

/**
 * Append unverified lessons to the project's pending-lessons.md file.
 */
function appendPendingLessons(epDir, sessionDate, projectName, lessons) {
  if (lessons.length === 0) return;

  fs.mkdirSync(epDir, { recursive: true });
  const pendingPath = path.join(epDir, 'pending-lessons.md');

  const existing = fs.existsSync(pendingPath) ? fs.readFileSync(pendingPath, 'utf8') : '';
  if (!existing.includes('# Pending Lessons')) {
    fs.writeFileSync(pendingPath, '# Pending Lessons\n\nThese lessons are unverified. At the start of the next session, Claude should surface them to Tony for confirmation.\n\n', 'utf8');
  }

  const entry = `## Session ${sessionDate}\n\n` +
    lessons.map((l, i) => `${i + 1}. ${l}`).join('\n') + '\n\n';

  fs.appendFileSync(pendingPath, entry, 'utf8');
}

async function main() {
  const opts = parseArgs();
  const cutoffMs = Date.now() - opts.days * 24 * 60 * 60 * 1000;

  if (!fs.existsSync(PROJECTS_DIR)) {
    process.stderr.write(`[dream-narrate] Projects dir not found: ${PROJECTS_DIR}\n`);
    return;
  }

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => !opts.project || name === opts.project);

  const results = { narrated: [], skipped: [], failed: [] };

  for (const encodedDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, encodedDir);
    const projName = projectLabel(encodedDir);
    const epDir = episodesDir(encodedDir);

    let entries;
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const jsonlFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => path.join(projectPath, e.name));

    for (const filePath of jsonlFiles) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoffMs) continue;

        const sessionDate = new Date(stat.mtime).toISOString().split('T')[0];

        if (episodeExists(epDir, sessionDate)) {
          results.skipped.push({ project: projName, date: sessionDate, reason: 'episode already exists' });
          continue;
        }

        const messages = extractConversation(filePath);
        if (messages.length < MIN_MESSAGES) {
          results.skipped.push({ project: projName, date: sessionDate, reason: `too short (${messages.length} messages)` });
          continue;
        }

        process.stderr.write(`[dream-narrate] Narrating ${projName} / ${sessionDate} (${messages.length} messages)…\n`);

        if (opts.dryRun) {
          results.narrated.push({ project: projName, date: sessionDate, dryRun: true, messageCount: messages.length });
          continue;
        }

        const output = generateNarrative(projName, sessionDate, messages);
        if (!output) {
          results.failed.push({ project: projName, date: sessionDate, reason: 'claude call failed' });
          continue;
        }

        const { narrative, lessons } = parseNarrativeOutput(output);
        const episodePath = writeEpisode(epDir, sessionDate, projName, narrative, filePath);
        appendPendingLessons(epDir, sessionDate, projName, lessons);

        results.narrated.push({
          project: projName,
          date: sessionDate,
          episodePath,
          lessonCount: lessons.length,
        });

        process.stderr.write(`[dream-narrate] ✓ ${projName} / ${sessionDate} → ${path.basename(episodePath)} (${lessons.length} lessons)\n`);

      } catch (err) {
        results.failed.push({ project: encodedDir, error: err.message });
      }
    }
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.stderr.write(
    `[dream-narrate] Done: ${results.narrated.length} narrated, ` +
    `${results.skipped.length} skipped, ${results.failed.length} failed\n`
  );
}

main().catch(err => {
  process.stderr.write(`[dream-narrate] Fatal: ${err.message}\n`);
  process.exit(1);
});
