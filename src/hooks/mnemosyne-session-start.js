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
 * Project-scoped memories (Tier 2) are handled by Claude Code's native auto-memory.
 * Session summaries (Tier 3) are handled by the existing ECC session-start.js.
 *
 * Token budget: 3000 tokens total (chars / 4 approximation).
 * Tier 0 always loads in full. Tier 1 loads up to the remaining budget.
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

const TOKEN_BUDGET = 3000;
const CHARS_PER_TOKEN = 4;
const CHAR_BUDGET = TOKEN_BUDGET * CHARS_PER_TOKEN;

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function readMemoryFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
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

  if (tier0Files.length === 0 && tier1Files.length === 0) {
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
    const { text } = buildSection(1, tier1Files, remainingChars);
    if (text) {
      sections.push(`## Tier 1 — Global Feedback Memory\n\n${text}`);
    }
  }

  const totalTokens = estimateTokens(sections.join('\n\n'));
  const cwd = (event && event.cwd) ? event.cwd : process.cwd();

  process.stderr.write(
    `[Mnemosyne] Tier 0: ${tier0Files.length} files | Tier 1: ${tier1Files.length} files | ~${totalTokens} tokens | cwd: ${cwd}\n`
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
