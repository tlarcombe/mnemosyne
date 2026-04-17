#!/usr/bin/env node
'use strict';

/**
 * mnemosyne-stop.js
 *
 * Mnemosyne Phase 3 — Stop hook (async).
 *
 * Extracts implicit assumption signals from the current session JSONL transcript.
 * Appends new, deduplicated assumptions to:
 *   ~/.claude/projects/<encoded-cwd>/memory/assumptions.md
 *
 * Wired as async: true — fires in the background, does not block Claude Code.
 *
 * Stdin JSON shape: { transcript_path: string, ... }
 * cwd: process.cwd() (Claude Code runs hooks in the project directory)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const TODAY = new Date().toISOString().split('T')[0];

const ASSUMPTION_PATTERNS = [
  {
    pattern: /\b(I (assumed|thought|was assuming|expected|figured)|I thought you (knew|understood|had))\b(.{0,120})/i,
    category: 'correction',
  },
  {
    pattern: /\b(let'?s assume|assuming that|given that|we'?re assuming|on the assumption that)\b(.{0,120})/i,
    category: 'explicit',
  },
  {
    pattern: /\b(this (project|repo|codebase|app) (uses?|is using|runs?|is built (with|in)|is written in))\b(.{0,120})/i,
    category: 'tech-stack',
  },
  {
    pattern: /\b((you|we|it) (should|must) already|should (already be|be there|exist|work|be done))\b(.{0,120})/i,
    category: 'state',
  },
  {
    pattern: /\b(we'?re using|we (agreed|decided|chose)|the (plan|approach|architecture) is)\b(.{0,120})/i,
    category: 'decision',
  },
];

function extractTextFromMessage(d) {
  // d.message?.content is the Claude Code JSONL format; d.content is a legacy fallback
  const content = d.message?.content ?? d.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ');
  }
  return '';
}

function scanTranscript(transcriptPath) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const candidates = [];

  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    const role = d.type || d.message?.role;
    if (role !== 'user') continue;

    const text = extractTextFromMessage(d).trim();
    if (!text) continue;

    for (const { pattern, category } of ASSUMPTION_PATTERNS) {
      const m = pattern.exec(text);
      if (!m) continue;

      const raw = m[0].replace(/\s+/g, ' ').trim();
      const normalized = raw.length > 150 ? raw.slice(0, 147) + '...' : raw;
      candidates.push({ normalized, category });
      break;
    }
  }

  // Cap to avoid excessive processing on very long sessions
  return candidates.slice(0, 30);
}

function getSessionId(transcriptPath) {
  return path.basename(transcriptPath, '.jsonl').slice(0, 8);
}

function findProjectDir(cwd) {
  // Walk up the directory tree — sessions may run in subdirs of the project root
  // Returns { projectDir, matchedCwd } so callers can derive a reliable project name
  let current = cwd;
  while (current && current !== path.dirname(current)) {
    const encoded = current.replace(/\//g, '-');
    const projectDir = path.join(CLAUDE_DIR, 'projects', encoded);
    if (fs.existsSync(projectDir)) return { projectDir, matchedCwd: current };
    current = path.dirname(current);
  }
  return null;
}

function getProjectName(matchedCwd) {
  // Derive the project name from the real filesystem path — avoids decoding ambiguity
  // with hyphenated project names (e.g. 'my-project', 'four-square').
  return path.basename(matchedCwd);
}

function readAssumptions(assumptionsPath) {
  try {
    return fs.readFileSync(assumptionsPath, 'utf8');
  } catch {
    return null;
  }
}

function buildInitialFile(projectName) {
  return `---
name: Assumption Register
type: project
recorded_at: ${TODAY}
valid_until: indefinite
scope: project:${projectName}
---

## Active Assumptions

`;
}

function isDuplicate(existingContent, normalized) {
  const lower = normalized.toLowerCase();
  return existingContent.toLowerCase().includes(lower.slice(0, 80));
}

function appendAssumptions(assumptionsPath, newCandidates, sessionId, projectName) {
  const memDir = path.dirname(assumptionsPath);
  const fileExists = fs.existsSync(assumptionsPath);

  if (!fileExists) {
    // Create initial file with frontmatter + section header
    if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(assumptionsPath, buildInitialFile(projectName));
  }

  // Read current content for deduplication check
  const currentContent = readAssumptions(assumptionsPath) || '';

  let added = 0;
  for (const { normalized, category } of newCandidates) {
    if (isDuplicate(currentContent, normalized)) continue;
    const entry = `- [${TODAY}] (${category}) ${normalized} (session:${sessionId})\n`;
    fs.appendFileSync(assumptionsPath, entry);
    added++;
  }

  if (!fileExists || added > 0) {
    const action = !fileExists ? 'created' : 'updated';
    process.stderr.write(`[Mnemosyne] assumptions: +${added} entries (${action}) → ${assumptionsPath}\n`);
  }
}

function main() {
  let transcriptPath = null;
  let stdinData = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { stdinData += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(stdinData);
      transcriptPath = input.transcript_path;
    } catch {
      transcriptPath = process.env.CLAUDE_TRANSCRIPT_PATH || null;
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

    const cwd = process.cwd();
    const found = findProjectDir(cwd);
    if (!found) {
      process.stderr.write(`[Mnemosyne] assumptions: no project dir found for cwd: ${cwd}\n`);
      return;
    }

    const { projectDir, matchedCwd } = found;
    const projectName = getProjectName(matchedCwd);
    const assumptionsPath = path.join(projectDir, 'memory', 'assumptions.md');
    const sessionId = getSessionId(transcriptPath);

    const candidates = scanTranscript(transcriptPath);
    if (candidates.length === 0) return;

    appendAssumptions(assumptionsPath, candidates, sessionId, projectName);
  });
}

main();
