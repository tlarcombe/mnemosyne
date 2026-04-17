# Mnemosyne Phase 2 — Dream Rebuilt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/dream` as `/mnemosyne` — a 5-phase consolidation engine with CIA-grounded scoring, bitemporal eviction, automated JSONL signal extraction, and a structured run report.

**Architecture:** A new `mnemosyne` skill at `~/.claude/skills/mnemosyne/` replaces the `/dream` invocation path. Two Node.js utilities handle the automatable parts: `dream-gather.js` scans recent JSONL sessions and extracts curated signal snippets for Claude to score; `dream-evict.js` automatically marks expired/superseded memories. Claude performs the judgment work (scoring, tier assignment, contradiction detection) guided by the SKILL.md. The run report at `~/.claude/memory/dream-last-run.md` records what was promoted, evicted, and skipped.

**Tech Stack:** Node.js (utilities), Markdown (SKILL.md + memory files), Bash (should-dream.sh)

---

## File Map

| Action | Path |
|--------|------|
| Create | `src/dream/SKILL.md` — the new `/mnemosyne` skill (5-phase guided dream) |
| Create | `src/dream/dream-gather.js` — JSONL signal extractor (automated GATHER phase) |
| Create | `src/dream/dream-evict.js` — bitemporal eviction (automated EVICT phase) |
| Modify | `install.sh` — add dream deployment steps |
| Modify | `~/.claude/CLAUDE.md` — update auto-dream trigger from `/dream` to `/mnemosyne` |

Deployed targets:
- `~/.claude/skills/mnemosyne/SKILL.md`
- `~/.claude/skills/mnemosyne/dream-gather.js`
- `~/.claude/skills/mnemosyne/dream-evict.js`

---

## Task 1: dream-gather.js — JSONL Signal Extractor

**Files:**
- Create: `src/dream/dream-gather.js`

Scans JSONL session files modified in the last N days, extracts snippets around high-signal keywords, and outputs a structured JSON report. Claude uses this output during the SCORE phase instead of reading raw JSONL files.

- [ ] **Step 1: Write dream-gather.js**

```javascript
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
 * Output (stdout): JSON array of signal candidates
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

const SIGNAL_PATTERNS = [
  { pattern: /\b(actually|no,|wrong|incorrect|not right|stop doing|don't do that|that's not|correction|I said|I meant)\b/i, category: 'correction', weight: 1.0 },
  { pattern: /\b(I prefer|always use|never use|I like|I don't like|I want you to|from now on|going forward|remember that|keep in mind|make sure to|default to)\b/i, category: 'preference', weight: 0.85 },
  { pattern: /\b(let's go with|I decided|we're using|the plan is|switch to|move to|chosen|picked|we agreed|decision|we'll use)\b/i, category: 'decision', weight: 0.8 },
  { pattern: /\b(again|every time|keep forgetting|as usual|same as before|like last time|we always|the usual)\b/i, category: 'recurring', weight: 0.7 },
  { pattern: /\b(perfect|exactly right|yes that|good approach|keep doing|that's better)\b/i, category: 'validation', weight: 0.75 },
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

function extractTextFromMessage(msg) {
  const content = msg.message?.content;
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

function scanFile(filePath, projectName, cutoffMs) {
  const stat = fs.statSync(filePath);
  if (stat.mtimeMs < cutoffMs) return [];

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

  const candidates = [];
  const sessionDate = new Date(stat.mtime).toISOString().split('T')[0];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue; // only scan user messages for signal

    for (const { pattern, category, weight } of SIGNAL_PATTERNS) {
      if (!pattern.test(msg.text)) continue;

      // Extract surrounding context (user msg + following assistant response)
      const snippet = msg.text.slice(0, 300);
      const response = messages[i + 1] && messages[i + 1].role === 'assistant'
        ? messages[i + 1].text.slice(0, 200)
        : '';

      candidates.push({
        project: projectName,
        session: path.basename(filePath),
        sessionDate,
        category,
        signalWeight: weight,
        userMessage: snippet,
        assistantResponse: response,
      });
      break; // one signal per message
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

    // Find JSONL files directly in the project dir (not in subdirs/subagents)
    let jsonlFiles;
    try {
      jsonlFiles = fs.readdirSync(projectPath)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(projectPath, f));
    } catch {
      continue;
    }

    for (const file of jsonlFiles) {
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < cutoffMs) continue;
        scannedFiles++;
        const candidates = scanFile(file, projectDir, cutoffMs);
        allCandidates.push(...candidates);
      } catch {
        // skip unreadable files
      }
    }
  }

  // Sort by signal weight descending, then by date descending
  allCandidates.sort((a, b) =>
    b.signalWeight - a.signalWeight || b.sessionDate.localeCompare(a.sessionDate)
  );

  const output = {
    generatedAt: new Date().toISOString(),
    cutoffDays: opts.days,
    scannedFiles,
    totalCandidates: allCandidates.length,
    candidates: allCandidates,
  };

  process.stdout.write(JSON.stringify(output, null, 2));
  process.stderr.write(`[dream-gather] Scanned ${scannedFiles} sessions, found ${allCandidates.length} signal candidates\n`);
}

main();
```

- [ ] **Step 2: Test it**

```bash
node /home/tlarcombe/projects/Mnemosyne/src/dream/dream-gather.js --days 30 2>&1 | tail -3
```

Expected stderr: `[dream-gather] Scanned N sessions, found M signal candidates`

- [ ] **Step 3: Spot-check output**

```bash
node /home/tlarcombe/projects/Mnemosyne/src/dream/dream-gather.js --days 30 2>/dev/null | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Files: {d[\"scannedFiles\"]}, Candidates: {d[\"totalCandidates\"]}'); [print(f'  [{c[\"category\"]}] {c[\"project\"]}: {c[\"userMessage\"][:60]}') for c in d['candidates'][:5]]"
```

Expected: shows scanned file count and up to 5 sample candidates with categories

- [ ] **Step 4: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add src/dream/dream-gather.js
git commit -m "feat: add dream-gather.js — JSONL signal extractor for dream GATHER phase"
```

---

## Task 2: dream-evict.js — Bitemporal Eviction

**Files:**
- Create: `src/dream/dream-evict.js`

Scans all Tier 0, 1, and 2 memory files. Marks entries where `valid_until` has passed by setting `valid_until: superseded-<date>` (bitemporal pattern — never deletes). Reports what was evicted.

- [ ] **Step 1: Write dream-evict.js**

```javascript
#!/usr/bin/env node
'use strict';

/**
 * dream-evict.js
 *
 * Mnemosyne Phase 2 — automated EVICT phase.
 *
 * Scans memory files across all tiers and marks entries whose valid_until
 * date has passed. Uses bitemporal pattern: never deletes, sets
 * valid_until to superseded-<today> and adds eviction reason.
 *
 * Also reports memories approaching expiry (within 14 days) as warnings.
 *
 * Usage: node dream-evict.js [--dry-run]
 *   --dry-run   report what would be evicted without writing
 *
 * Output (stdout): JSON eviction report
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const TODAY = new Date().toISOString().split('T')[0];
const TODAY_MS = new Date(TODAY).getTime();
const WARN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function parseArgs() {
  return { dryRun: process.argv.includes('--dry-run') };
}

function getMemoryDirs() {
  const dirs = [];

  // Tier 0
  const t0 = path.join(CLAUDE_DIR, 'memory', 'permanent');
  if (fs.existsSync(t0)) dirs.push({ tier: 0, dir: t0 });

  // Tier 1
  const t1 = path.join(CLAUDE_DIR, 'memory', 'feedback');
  if (fs.existsSync(t1)) dirs.push({ tier: 1, dir: t1 });

  // Tier 2 — all project memory dirs
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const memDir = path.join(projectsDir, entry.name, 'memory');
      if (fs.existsSync(memDir) && !memDir.includes('memory-backup')) {
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
  if (validUntil.startsWith('superseded-')) return null; // already evicted

  // Parse expiry date
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
    // Expired — evict
    if (!opts.dryRun) {
      const newContent = content.replace(
        /^valid_until:\s*.+$/m,
        `valid_until: superseded-${TODAY}\neviction_reason: expired (was: ${validUntil})`
      );
      fs.writeFileSync(filePath, newContent);
    }
    return { action: 'evicted', name, file: filePath, tier, validUntil, reason: 'expired' };
  }

  if (expiryMs - TODAY_MS < WARN_WINDOW_MS) {
    // Approaching expiry
    const daysLeft = Math.round((expiryMs - TODAY_MS) / (24 * 60 * 60 * 1000));
    return { action: 'warn', name, file: filePath, tier, validUntil, reason: `expires in ${daysLeft} days` };
  }

  return null;
}

function main() {
  const opts = parseArgs();
  const dirs = getMemoryDirs();

  const results = { evicted: [], warnings: [], scanned: 0 };

  for (const { tier, dir } of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'assumptions.md');
    } catch {
      continue;
    }

    for (const file of files) {
      results.scanned++;
      const result = checkFile(path.join(dir, file), tier, opts);
      if (!result) continue;
      if (result.action === 'evicted') results.evicted.push(result);
      if (result.action === 'warn') results.warnings.push(result);
    }
  }

  const report = {
    runAt: new Date().toISOString(),
    dryRun: opts.dryRun,
    scanned: results.scanned,
    evicted: results.evicted,
    warnings: results.warnings,
    summary: `Scanned ${results.scanned} files: ${results.evicted.length} evicted, ${results.warnings.length} approaching expiry`,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(`[dream-evict] ${report.summary}\n`);
}

main();
```

- [ ] **Step 2: Test dry-run**

```bash
node /home/tlarcombe/projects/Mnemosyne/src/dream/dream-evict.js --dry-run 2>&1 | grep -E 'dream-evict|evicted|scanned'
```

Expected: `[dream-evict] Scanned N files: 0 evicted, 0 approaching expiry` (nothing expired yet — all set to indefinite)

- [ ] **Step 3: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add src/dream/dream-evict.js
git commit -m "feat: add dream-evict.js — automated bitemporal eviction for EVICT phase"
```

---

## Task 3: The /mnemosyne SKILL.md

**Files:**
- Create: `src/dream/SKILL.md`

The dream skill that Claude executes when triggered by `.dream-pending`. Guides through 5 phases: GATHER (automated) → SCORE (Claude judgment) → PROMOTE (Claude writes memories) → EVICT (automated + Claude) → INDEX (Claude rebuilds MEMORY.md files).

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: mnemosyne
description: "CIA-grounded memory consolidation. Runs the 5-phase dream cycle: gather signal from recent sessions, score it, promote high-value findings to the right tier, evict stale memories, and rebuild memory indexes. Triggered automatically every 24hrs via .dream-pending flag."
tags: [memory, consolidation, dream, autonomous, mnemosyne]
---

# /mnemosyne — Memory Consolidation Engine

Runs the 5-phase dream cycle. Execute phases in strict order. Do not skip.

```
GATHER → SCORE → PROMOTE → EVICT → INDEX
```

---

## Setup Check

Before first run, verify the Mnemosyne directory structure:

```bash
ls ~/.claude/memory/permanent/ 2>/dev/null && echo "Tier 0 OK" || echo "Tier 0 MISSING — run install.sh"
ls ~/.claude/memory/feedback/ 2>/dev/null && echo "Tier 1 OK" || echo "Tier 1 MISSING — run install.sh"
ls ~/.claude/skills/mnemosyne/dream-gather.js 2>/dev/null && echo "gather OK" || echo "dream-gather.js MISSING"
ls ~/.claude/skills/mnemosyne/dream-evict.js 2>/dev/null && echo "evict OK" || echo "dream-evict.js MISSING"
```

If anything is missing: `bash ~/projects/Mnemosyne/install.sh`

---

## Phase 1: GATHER

**Goal:** Extract signal candidates from recent sessions. Automated — run the utility.

```bash
node ~/.claude/skills/mnemosyne/dream-gather.js --days 7 2>/dev/null
```

This scans JSONL session files modified in the last 7 days and extracts message
snippets around high-signal patterns (corrections, preferences, decisions, validations).

The output is a JSON array of candidates with fields:
- `project`: which project's session
- `category`: correction | preference | decision | recurring | validation
- `signalWeight`: 0.7–1.0 initial estimate
- `userMessage`: the user message containing the signal
- `assistantResponse`: Claude's immediate response

Save the output to review in Phase 2:

```bash
node ~/.claude/skills/mnemosyne/dream-gather.js --days 7 2>/dev/null > /tmp/dream-candidates.json
python3 -c "
import json
d = json.load(open('/tmp/dream-candidates.json'))
print(f'Sessions scanned: {d[\"scannedFiles\"]}')
print(f'Candidates found: {d[\"totalCandidates\"]}')
for c in d['candidates'][:20]:
    print(f'  [{c[\"category\"]}] {c[\"project\"]}: {c[\"userMessage\"][:80]}')
"
```

---

## Phase 2: SCORE

**Goal:** Apply the CIA scoring function to each candidate. This is Claude's judgment work.

For each candidate in `/tmp/dream-candidates.json`, apply the scoring rubric:

### Scoring Rubric

| Dimension | High (0.8–1.0) | Medium (0.4–0.7) | Low (0.0–0.3) |
|-----------|----------------|------------------|---------------|
| **Recency** | Session within 3 days | 4–14 days | 15+ days |
| **Relevance** | Fits an existing memory category directly | Fits with interpretation | Marginal fit |
| **Confidence** | Explicit instruction ("always", "never", "remember", correction) | Clear preference | Implied or ambiguous |
| **Currency** | Still matches current code/config/state | Partially applicable | Contradicts current state |

**Composite score = Recency × Relevance × Confidence × Currency**

### Tier Assignment

| Composite Score | Scope | Action |
|----------------|-------|--------|
| > 0.7 | Universal, applies to all projects always | Promote to **Tier 0** |
| > 0.6 | Cross-project, applies regardless of which project | Promote to **Tier 1** |
| > 0.4 | Specific to this project | Promote/update **Tier 2** |
| < 0.2 | Stale, contradicted, or too ambiguous | Skip or mark for eviction |

### Special Rules

- **Corrections always score ≥ 0.9 for Confidence** — explicit corrections are the highest-value signal
- **Validations score 0.75 for Confidence** — user confirming Claude's approach is valuable
- **Check against existing memories before promoting** — if a Tier 2 memory already captures this, update it rather than adding a duplicate
- **For `recurring` category**: only promote if the same pattern appeared in ≥ 2 sessions

---

## Phase 3: PROMOTE

**Goal:** Write high-scoring candidates to the appropriate tier.

For each candidate that scored above threshold:

1. Check whether the fact is already in memory (read existing files first)
2. If exists and is accurate: skip (no action needed)
3. If exists but is superseded by the new signal: update the old entry's `valid_until` to `superseded-<today>`, then write the new entry
4. If new: write a new memory file

### Memory File Format

```markdown
---
name: <descriptive name>
type: feedback | user | project | reference
recorded_at: <today>
valid_until: indefinite
scope: global | project:<project-name>
---

<The memory content — concise, actionable>

**How to apply:** <when and how this should affect behavior>
```

### Tier Placement

- **Tier 0** → `~/.claude/memory/permanent/<name>.md`
- **Tier 1** → `~/.claude/memory/feedback/<name>.md`
- **Tier 2** → `~/.claude/projects/<encoded-dir>/memory/<name>.md`

### Naming Convention

Use `snake_case` for filenames: `feedback_<topic>.md`, `user_<aspect>.md`, `project_<feature>.md`

---

## Phase 4: EVICT

**Goal:** Remove stale, expired, and superseded memories. Two sub-steps.

### 4a: Automated eviction (run the utility)

```bash
node ~/.claude/skills/mnemosyne/dream-evict.js 2>/dev/null
```

This marks all memories with a passed `valid_until` date as `superseded-<today>`.
Review the JSON output — it lists everything that was evicted and warns about upcoming expirations.

### 4b: Currency check (Claude judgment)

For each project that had active sessions in the last 7 days, scan its Tier 2 memories
and check currency: does the memory still reflect the current state of the project?

For each Tier 2 memory file, ask:
- Is this still true, given what you saw in the recent sessions?
- Does anything from the GATHER phase candidates contradict it?

If a memory is no longer current, mark it superseded:
```
valid_until: superseded-<today>
```
Then write a replacement entry if a corrected version exists.

**Do not check Tier 0 for currency during routine dreams** — permanent memories are only updated by explicit user instruction.

---

## Phase 5: INDEX

**Goal:** Rebuild MEMORY.md index files for each tier and each project that was touched.

### Tier 0 and Tier 1 index

Write `~/.claude/memory/permanent/MEMORY.md`:
```markdown
# Tier 0 — Permanent Global Memory Index

Last consolidated: <today>

| File | Name | Updated |
|------|------|---------|
<row per .md file>
```

Write `~/.claude/memory/feedback/MEMORY.md`:
```markdown
# Tier 1 — Global Feedback Memory Index

Last consolidated: <today>

| File | Name | Valid Until | Updated |
|------|------|-------------|---------|
<row per valid (non-superseded) .md file>
```

### Tier 2 project indexes

For each project with modified memories, rebuild its MEMORY.md:
```markdown
# <Project Name> — Memory Index

Last consolidated: <today>

- [<name>](<file>.md) — <one-line description>
```

Keep MEMORY.md under 200 lines. If over, demote oldest entries to `archive.md`.

---

## Dream Run Report

After completing all 5 phases, write the run report:

```bash
cat > ~/.claude/memory/dream-last-run.md << 'EOF'
# Dream Run Report

**Run at:** <timestamp>
**Sessions scanned:** N
**Signal candidates found:** N

## Promoted
- [Tier N] <name>: <one-line summary of what was promoted>

## Evicted
- [Tier N] <name>: <reason (expired/superseded/contradicted)>

## Skipped
- N candidates below threshold (score < 0.4)
- N already captured in existing memories

## Warnings
- <any memories approaching expiry>
EOF
```

Then write the timestamp and clean up:
```bash
date +%s > ~/.claude/memory/.last-dream
rm -f ~/.claude/.dream-pending
```

---

## Safety Rules

1. **Never delete memory files** — set `valid_until: superseded-<date>` instead
2. **Read before writing** — always check the current file content before editing
3. **No duplicates** — check all existing entries before promoting
4. **Convert relative dates** — "yesterday", "last week" → absolute YYYY-MM-DD dates
5. **Tier 0 is immutable without explicit user instruction** — do not promote to Tier 0 during automated runs
```

- [ ] **Step 2: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add src/dream/SKILL.md
git commit -m "feat: add /mnemosyne SKILL.md — 5-phase CIA dream cycle with scoring rubric"
```

---

## Task 4: Update install.sh

**Files:**
- Modify: `install.sh` — add dream deployment block

- [ ] **Step 1: Add dream deployment to install.sh**

After the existing step 6, add a step 7 block that creates the skills directory and deploys dream components:

```bash
# Step 7: Deploy Mnemosyne skill (dream engine)
echo "[7/7] Deploying /mnemosyne skill..."
mkdir -p "$HOME/.claude/skills/mnemosyne"
cp "$MNEMOSYNE_DIR/src/dream/SKILL.md" "$HOME/.claude/skills/mnemosyne/"
cp "$MNEMOSYNE_DIR/src/dream/dream-gather.js" "$HOME/.claude/skills/mnemosyne/"
cp "$MNEMOSYNE_DIR/src/dream/dream-evict.js" "$HOME/.claude/skills/mnemosyne/"
echo "  ~/.claude/skills/mnemosyne/ — OK"
```

Also update the summary at the bottom to add the mnemosyne skill info.

- [ ] **Step 2: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add install.sh
git commit -m "feat: update install.sh to deploy /mnemosyne dream skill"
```

---

## Task 5: Update Auto-Dream Trigger

**Files:**
- Modify: `~/.claude/CLAUDE.md` — update `/dream` reference to `/mnemosyne`

- [ ] **Step 1: Update the auto-dream instruction**

Find and replace the Auto Dream section in `~/.claude/CLAUDE.md`:

Old:
```
If the file `~/.claude/.dream-pending` exists at session start, run `/dream` as a subagent in the background, then delete the flag file: `rm ~/.claude/.dream-pending`. This is the memory consolidation system - it runs automatically every 24 hours.
```

New:
```
If the file `~/.claude/.dream-pending` exists at session start, run `/mnemosyne` as a subagent in the background, then delete the flag file: `rm ~/.claude/.dream-pending`. This is the Mnemosyne memory consolidation system — it runs the 5-phase CIA dream cycle automatically every 24 hours.
```

- [ ] **Step 2: Verify**

```bash
grep -A2 "Auto Dream" ~/.claude/CLAUDE.md
```

Expected: shows `/mnemosyne` not `/dream`

---

## Task 6: Integration Test

- [ ] **Step 1: Run install.sh**

```bash
bash /home/tlarcombe/projects/Mnemosyne/install.sh
```

Expected: all 7 steps complete, step 7 shows mnemosyne skill deployed

- [ ] **Step 2: Verify skill deployed**

```bash
ls ~/.claude/skills/mnemosyne/
```

Expected: `SKILL.md`, `dream-gather.js`, `dream-evict.js`

- [ ] **Step 3: Run gather on 30 days**

```bash
node ~/.claude/skills/mnemosyne/dream-gather.js --days 30 2>&1 | grep 'dream-gather'
```

Expected: `[dream-gather] Scanned N sessions, found M signal candidates` (N > 0)

- [ ] **Step 4: Run evict dry-run**

```bash
node ~/.claude/skills/mnemosyne/dream-evict.js --dry-run 2>&1 | grep 'dream-evict'
```

Expected: `[dream-evict] Scanned N files: 0 evicted, 0 approaching expiry`

- [ ] **Step 5: Verify /mnemosyne skill is accessible**

```bash
ls ~/.claude/skills/mnemosyne/SKILL.md && echo "PASS"
grep -l "mnemosyne" ~/.claude/CLAUDE.md && echo "trigger PASS"
```

Expected: both PASS

- [ ] **Step 6: Final commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add -A
git commit -m "feat: Phase 2 complete — /mnemosyne dream skill with gather/evict utilities"
```
