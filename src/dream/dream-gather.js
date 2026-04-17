#!/usr/bin/env node
'use strict';

/**
 * dream-gather.js
 *
 * Mnemosyne Phase 2 — GATHER phase utility.
 *
 * Scans recent JSONL session files for high-signal patterns (corrections,
 * preferences, decisions, recurring patterns). Extracts message snippets
 * with context and outputs a structured JSON report for Claude to score.
 *
 * Usage: node dream-gather.js [--days N] [--project <encoded-dir>]
 *   --days N          scan sessions modified in last N days (default: 7)
 *   --project <name>  limit to a specific project's sessions
 *
 * Output (stdout): JSON report with signal candidates
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

const SIGNAL_PATTERNS = [
  { pattern: /\b(actually|no,\s|wrong|incorrect|not right|stop doing|don't do that|that's not|correction|I said|I meant)\b/i, category: 'correction', weight: 1.0 },
  { pattern: /\b(I prefer|always use|never use|I like|I don't like|I want you to|from now on|going forward|remember that|keep in mind|make sure to|default to)\b/i, category: 'preference', weight: 0.85 },
  { pattern: /\b(let's go with|I decided|we're using|the plan is|switch to|move to|chosen|picked|we agreed|decision|we'll use)\b/i, category: 'decision', weight: 0.8 },
  { pattern: /\b(again|every time|keep forgetting|as usual|same as before|like last time|we always|the usual)\b/i, category: 'recurring', weight: 0.7 },
  { pattern: /\b(perfect|exactly right|yes that|good approach|keep doing|that's better|exactly what I wanted)\b/i, category: 'validation', weight: 0.75 },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, project: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[++i], 10);
    if (args[i] === '--project' && args[i + 1]) opts.project = args[++i];
  }
  return opts;
}

function extractTextFromMessage(d) {
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

function scanFile(filePath, projectName) {
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
      if (d.type === 'user' || d.type === 'assistant') {
        const text = extractTextFromMessage(d);
        if (text.trim()) {
          messages.push({
            role: d.type,
            text: text.trim(),
            timestamp: d.timestamp || '',
          });
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  if (messages.length === 0) return [];

  const stat = fs.statSync(filePath);
  const sessionDate = new Date(stat.mtime).toISOString().split('T')[0];
  const candidates = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;

    for (const { pattern, category, weight } of SIGNAL_PATTERNS) {
      if (!pattern.test(msg.text)) continue;

      const response = messages[i + 1] && messages[i + 1].role === 'assistant'
        ? messages[i + 1].text.slice(0, 200)
        : '';

      candidates.push({
        project: projectName,
        session: path.basename(filePath),
        sessionDate,
        category,
        signalWeight: weight,
        userMessage: msg.text.slice(0, 300),
        assistantResponse: response,
      });
      break; // one signal per user message
    }
  }

  return candidates;
}

function main() {
  const opts = parseArgs();
  const cutoffMs = Date.now() - opts.days * 24 * 60 * 60 * 1000;

  if (!fs.existsSync(PROJECTS_DIR)) {
    process.stderr.write(`[dream-gather] Projects dir not found: ${PROJECTS_DIR}\n`);
    process.stdout.write(JSON.stringify({ candidates: [], scannedFiles: 0, cutoffDays: opts.days }));
    return;
  }

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(name => !opts.project || name === opts.project);

  const allCandidates = [];
  let scannedFiles = 0;

  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);

    let entries;
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const jsonlFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => path.join(projectPath, e.name));

    for (const file of jsonlFiles) {
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < cutoffMs) continue;
        scannedFiles++;
        const candidates = scanFile(file, projectDir);
        allCandidates.push(...candidates);
      } catch {
        // skip unreadable
      }
    }
  }

  // Sort: corrections first, then by weight desc, then by date desc
  allCandidates.sort((a, b) => {
    if (a.category === 'correction' && b.category !== 'correction') return -1;
    if (b.category === 'correction' && a.category !== 'correction') return 1;
    return b.signalWeight - a.signalWeight || b.sessionDate.localeCompare(a.sessionDate);
  });

  const output = {
    generatedAt: new Date().toISOString(),
    cutoffDays: opts.days,
    scannedFiles,
    totalCandidates: allCandidates.length,
    candidates: allCandidates,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.stderr.write(`[dream-gather] Scanned ${scannedFiles} sessions, found ${allCandidates.length} signal candidates\n`);
}

main();
