#!/usr/bin/env node
'use strict';

/**
 * mnemosyne-session-start.js
 *
 * Mnemosyne Phase 1 — SessionStart hook.
 *
 * Injects Tier 0 (permanent global) and Tier 1 (global feedback) memory content
 * into every session via the Claude Code SessionStart additionalContext mechanism.
 *
 * Phase 5 additions:
 *   - Pending lesson verification: surfaces unverified lessons from recent sessions
 *   - Episode loading: injects the 3 most recent episodic summaries for current project
 *
 * Project-scoped memories (Tier 2) are handled by Claude Code's native auto-memory.
 * Session summaries (Tier 3) are handled by the existing ECC session-start.js.
 *
 * Token budget: 5000 tokens total (chars / 4 approximation).
 * Tier 0 always loads in full. Remaining budget shared by Tier 1, episodes, pending lessons.
 * Tier 1 entries with expired or superseded valid_until are skipped.
 * Tier 1 capped at 50 entries per spec.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PERMANENT_DIR = path.join(CLAUDE_DIR, 'memory', 'permanent');
const FEEDBACK_DIR = path.join(CLAUDE_DIR, 'memory', 'feedback');
const EPISODES_BASE_DIR = path.join(CLAUDE_DIR, 'memory', 'episodes');

const TOKEN_BUDGET = 5000;
const CHARS_PER_TOKEN = 4;
const CHAR_BUDGET = TOKEN_BUDGET * CHARS_PER_TOKEN;

const EPISODE_CHAR_CAP = 6000;
const PENDING_CHAR_CAP = 1200;
const MAX_EPISODES = 3;

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function readMemoryFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    .sort()
    .map(f => {
      const filePath = path.join(dir, f);
      try {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        return { file: f, content };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isValid(content) {
  const match = content.match(/^valid_until:\s*(.+)$/m);
  if (!match) return true;
  const validUntil = match[1].trim();
  if (validUntil === 'indefinite') return true;
  if (validUntil.startsWith('superseded-')) return false;
  try {
    return new Date(validUntil) >= new Date();
  } catch {
    return true;
  }
}

function extractName(content, file) {
  const match = content.match(/^name:\s*(.+)$/m);
  return match ? match[1].trim() : path.basename(file, '.md');
}

function stripFrontmatter(content) {
  if (!content.startsWith('---\n')) return content;
  const closingIdx = content.indexOf('\n---', 4);
  if (closingIdx === -1) return content;
  return content.slice(closingIdx + 4).trim();
}

function buildSection(tier, files, charBudget) {
  const parts = [];
  let charsUsed = 0;
  let omitted = 0;

  for (const { file, content } of files) {
    const body = stripFrontmatter(content);
    if (!body) continue;

    const name = extractName(content, file);
    const entry = `### ${name}\n${body}`;

    if (charsUsed + entry.length > charBudget && parts.length > 0) {
      omitted = files.length - parts.length;
      break;
    }

    parts.push(entry);
    charsUsed += entry.length;
  }

  if (omitted > 0) {
    parts.push(`[${omitted} more Tier ${tier} entries omitted — token budget reached]`);
  }

  return { text: parts.join('\n\n'), charsUsed };
}

function encodeProjectPath(p) {
  // Claude Code encodes project paths by replacing all non-alphanumeric chars with '-'
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function findProjectDir(cwd) {
  let current = cwd;
  while (current && current !== path.dirname(current)) {
    const encoded = encodeProjectPath(current);
    const projectDir = path.join(CLAUDE_DIR, 'projects', encoded);
    if (fs.existsSync(projectDir)) return { projectDir, encodedDir: encoded };
    current = path.dirname(current);
  }
  return null;
}

function projectLabel(encodedDir) {
  const parts = encodedDir.replace(/^-/, '').split('-');
  const idx = parts.indexOf('projects');
  if (idx !== -1) return parts.slice(idx + 1).join('-');
  return encodedDir;
}

function loadRecentEpisodes(encodedDir, charBudget) {
  const label = projectLabel(encodedDir);
  const epDir = path.join(EPISODES_BASE_DIR, label);
  if (!fs.existsSync(epDir)) return { text: '', charsUsed: 0, count: 0 };

  const files = fs.readdirSync(epDir)
    .filter(f => f.endsWith('.md') && !f.includes('pending') && f !== 'MEMORY.md')
    .sort().reverse()
    .slice(0, MAX_EPISODES);

  if (files.length === 0) return { text: '', charsUsed: 0, count: 0 };

  const parts = [];
  let charsUsed = 0;
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(epDir, file), 'utf8').trim();
      const body = stripFrontmatter(content);
      if (!body) continue;
      const entry = `### ${file.replace('.md', '')}\n${body}`;
      if (charsUsed + entry.length > charBudget) break;
      parts.push(entry);
      charsUsed += entry.length;
    } catch { /* skip */ }
  }

  return { text: parts.join('\n\n---\n\n'), charsUsed, count: parts.length };
}

function loadPendingLessons(encodedDir, charBudget) {
  const label = projectLabel(encodedDir);
  const pendingPath = path.join(EPISODES_BASE_DIR, label, 'pending-lessons.md');
  if (!fs.existsSync(pendingPath)) return { text: '', charsUsed: 0 };
  try {
    const content = fs.readFileSync(pendingPath, 'utf8').trim();
    const body = stripFrontmatter(content);
    if (!body || body.length > charBudget) return { text: '', charsUsed: 0 };
    return { text: body, charsUsed: body.length };
  } catch {
    return { text: '', charsUsed: 0 };
  }
}

function loadTopAssumptions(projectDir, maxCount) {
  const assumptionsPath = path.join(projectDir, 'memory', 'assumptions.md');
  let content;
  try {
    content = fs.readFileSync(assumptionsPath, 'utf8');
  } catch {
    return [];
  }

  const sectionMatch = content.match(/## Active Assumptions\n([\s\S]*?)(?=\n##|$)/);
  if (!sectionMatch) return [];

  const lines = sectionMatch[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- ['));

  return lines.slice(-maxCount);
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.stdout.write(raw);
    return;
  }

  const tier0Files = readMemoryFiles(PERMANENT_DIR);

  const tier1Files = readMemoryFiles(FEEDBACK_DIR)
    .filter(({ content }) => isValid(content))
    .slice(0, 50);

  const cwd = (event && event.cwd) ? event.cwd : process.cwd();
  const found = findProjectDir(cwd);
  const projectDir = found ? found.projectDir : null;
  const encodedDir = found ? found.encodedDir : null;
  const assumptionLines = projectDir ? loadTopAssumptions(projectDir, 3) : [];

  if (tier0Files.length === 0 && tier1Files.length === 0 && assumptionLines.length === 0) {
    process.stdout.write(raw);
    return;
  }

  let remainingChars = CHAR_BUDGET;
  const sections = [];

  if (tier0Files.length > 0) {
    const { text, charsUsed } = buildSection(0, tier0Files, remainingChars);
    if (text) {
      sections.push(`## Tier 0 — Permanent Global Memory\n\n${text}`);
      remainingChars -= charsUsed;
    }
  }

  if (tier1Files.length > 0 && remainingChars > 0) {
    const { text, charsUsed } = buildSection(1, tier1Files, remainingChars);
    if (text) {
      sections.push(`## Tier 1 — Global Feedback Memory\n\n${text}`);
      remainingChars -= charsUsed;
    }
  }

  if (assumptionLines.length > 0 && remainingChars > 0) {
    const assumptionText = `## Active Assumptions (Project)\n\n${assumptionLines.join('\n')}`;
    if (assumptionText.length <= remainingChars && assumptionText.length <= 1200) {
      sections.push(assumptionText);
      remainingChars -= assumptionText.length;
    }
  }

  if (encodedDir && remainingChars > 0) {
    const { text, charsUsed } = loadPendingLessons(encodedDir, Math.min(remainingChars, PENDING_CHAR_CAP));
    if (text) {
      sections.push(`## Pending Lesson Verification\n\n${text}\n\n*Please confirm, correct, or add to these.*`);
      remainingChars -= charsUsed;
    }
  }

  if (encodedDir && remainingChars > 0) {
    const { text, charsUsed, count } = loadRecentEpisodes(encodedDir, Math.min(remainingChars, EPISODE_CHAR_CAP));
    if (text) {
      sections.push(`## Recent Episodes (${count})\n\n${text}`);
      remainingChars -= charsUsed;
    }
  }

  const totalTokens = estimateTokens(sections.join('\n\n'));

  process.stderr.write(
    `[Mnemosyne] Tier 0: ${tier0Files.length} files | Tier 1: ${tier1Files.length} files | Assumptions: ${assumptionLines.length} | ~${totalTokens} tokens | cwd: ${cwd}\n`
  );

  const additionalContext = sections.length > 0
    ? `# Mnemosyne Memory (Tiers 0–1)\n\n${sections.join('\n\n')}`
    : '';

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    }
  }));
}

main();
