# Mnemosyne Phase 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Mnemosyne memory tier foundations: schema migration, global tier directories, context bleed fix, global tier injection hook, token budget, and `/memory-status` command.

**Architecture:** A new SessionStart hook (`mnemosyne-session-start.js`) reads Tier 0 (permanent global) and Tier 1 (feedback global) memories and injects them into session context via `additionalContext`. A minimal patch to `session-start.js` eliminates context bleed by skipping the project-agnostic recency fallback. A migration script adds bitemporal frontmatter to all 51 existing project memory files without destructive changes.

**Tech Stack:** Node.js (matching ECC hook convention), Bash (install.sh), Markdown (memory files, commands)

---

## File Map

| Action | Path |
|--------|------|
| Create | `src/hooks/mnemosyne-session-start.js` — SessionStart hook, Tier 0+1 injector |
| Create | `src/commands/memory-status.md` — `/memory-status` slash command |
| Create | `scripts/migrate-memories.js` — one-time schema migration |
| Create | `seeds/permanent/user-identity.md` — Tier 0 seed: who is Tony |
| Create | `seeds/permanent/global-workflow.md` — Tier 0 seed: global dev preferences |
| Create | `install.sh` — idempotent installer |
| Create | `docs/patches/session-start-bleed-fix.md` — patch instructions for ECC file |
| Modify | `~/.claude/scripts/hooks/session-start.js` lines 191-205 — add bleed guard |
| Modify | `~/.claude/settings.json` — add Mnemosyne SessionStart hook entry |
| Create | `~/.claude/memory/permanent/` — Tier 0 directory |
| Create | `~/.claude/memory/feedback/` — Tier 1 directory |
| Create | `~/.claude/commands/memory-status.md` — deployed command |

---

## Task 1: Tier 0 Seed Files

**Files:**
- Create: `seeds/permanent/user-identity.md`
- Create: `seeds/permanent/global-workflow.md`

- [ ] **Step 1: Write user-identity.md**

```markdown
---
name: User identity and background
type: user
recorded_at: 2026-04-17
valid_until: indefinite
scope: global
---

Tony Larcombe (tlarcombe). Experienced developer and technical architect. Primary machine: winifred (Linux, Manjaro). Projects at ~/projects/ on NAS-mounted filesystem shared across lab machines.

Claude Code environment: enriched ~/.claude/ with 38 agents, 85 skills, 74 commands, 16 rule dirs, 35 hooks. Launcher: claude++ with fzf project picker. bypassPermissions is standard.

**How to apply:** Permanent user identity. Don't repeat basic facts back — Tony knows who he is.
```

- [ ] **Step 2: Write global-workflow.md**

```markdown
---
name: Global workflow preferences
type: feedback
recorded_at: 2026-04-17
valid_until: indefinite
scope: global
---

- Deploy via GitHub only: commit → push → pull on server. Never rsync or direct file copy.
- All projects committed to private GitHub repos before deployment.
- Node.js for hook scripts (not Python or bash for logic-heavy hooks).
- Prefer concise responses. No trailing summaries after completing work.
- Conventional commits format. No Co-Authored-By attribution in commits.

**How to apply:** Apply to all projects, all sessions.
```

- [ ] **Step 3: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add seeds/
git commit -m "feat: add Tier 0 seed files for permanent global memory"
```

Expected: commit succeeds

---

## Task 2: Schema Migration Script

**Files:**
- Create: `scripts/migrate-memories.js`

- [ ] **Step 1: Write the migration script**

```javascript
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
  '-home-tlarcombe-projects-',
  '-mnt-raid0-projects-',
  '-home-tlarcombe-',
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
```

- [ ] **Step 2: Run the migration**

```bash
node /home/tlarcombe/projects/Mnemosyne/scripts/migrate-memories.js
```

Expected output ends with: `Migration complete: 51 scanned, N migrated, 0 errors`

- [ ] **Step 3: Spot-check a migrated file**

```bash
head -10 /home/tlarcombe/.claude/projects/-home-tlarcombe-projects-AskDiana-Master/memory/project_askdiana.md
```

Expected: shows `recorded_at:`, `valid_until:`, and `scope:` lines in frontmatter

- [ ] **Step 4: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add scripts/migrate-memories.js
git commit -m "feat: add memory schema migration script (adds recorded_at/valid_until/scope)"
```

---

## Task 3: Fix Context Bleed in session-start.js

**Files:**
- Modify: `~/.claude/scripts/hooks/session-start.js` (lines ~191-205)
- Create: `docs/patches/session-start-bleed-fix.md`

The current `selectMatchingSession` function falls back to the most recent session across ALL projects when no worktree or project name match is found. This is the context bleed vector. The fix: when the match reason is `recency-fallback`, skip loading the session rather than injecting unrelated content.

- [ ] **Step 1: Back up the original**

```bash
cp /home/tlarcombe/.claude/scripts/hooks/session-start.js \
   /home/tlarcombe/.claude/scripts/hooks/session-start.js.pre-mnemosyne
```

- [ ] **Step 2: Apply the patch**

In `~/.claude/scripts/hooks/session-start.js`, find the block (around line 191):

```javascript
    if (result) {
      log(`[SessionStart] Selected: ${result.session.path} (match: ${result.matchReason})`);

      // Use the already-read content from selectMatchingSession (no duplicate I/O)
      const content = stripAnsi(result.content);
      if (content && !content.includes('[Session context goes here]')) {
        additionalContextParts.push(`Previous session summary:\n${content}`);
      }
    } else {
      log('[SessionStart] No matching session found');
    }
```

Replace with:

```javascript
    if (result) {
      // Mnemosyne Tier-3 isolation: skip recency-fallback to prevent cross-project bleed
      if (result.matchReason === 'recency-fallback') {
        log(`[SessionStart] Skipping session (recency-fallback — Mnemosyne isolation): ${result.session.path}`);
      } else {
        log(`[SessionStart] Selected: ${result.session.path} (match: ${result.matchReason})`);
        const content = stripAnsi(result.content);
        if (content && !content.includes('[Session context goes here]')) {
          additionalContextParts.push(`Previous session summary:\n${content}`);
        }
      }
    } else {
      log('[SessionStart] No matching session found');
    }
```

- [ ] **Step 3: Verify the diff**

```bash
diff /home/tlarcombe/.claude/scripts/hooks/session-start.js.pre-mnemosyne \
     /home/tlarcombe/.claude/scripts/hooks/session-start.js
```

Expected: ~6 line diff, no other changes

- [ ] **Step 4: Write the patch documentation**

```markdown
# session-start.js Context Bleed Fix

Applied by Mnemosyne Phase 1. Must be re-applied after ECC updates to session-start.js.

## Problem

`selectMatchingSession()` returns `matchReason: 'recency-fallback'` when no worktree or
project name match is found. This loads the most recent session from ANY project,
causing cross-project context bleed.

## Fix

In `main()` in `~/.claude/scripts/hooks/session-start.js`, around the block that reads
the session content (~line 191), add a guard for `recency-fallback`:

```diff
-    if (result) {
-      log(`[SessionStart] Selected: ${result.session.path} (match: ${result.matchReason})`);
-      const content = stripAnsi(result.content);
-      if (content && !content.includes('[Session context goes here]')) {
-        additionalContextParts.push(`Previous session summary:\n${content}`);
-      }
+    if (result) {
+      if (result.matchReason === 'recency-fallback') {
+        log(`[SessionStart] Skipping session (recency-fallback — Mnemosyne isolation): ${result.session.path}`);
+      } else {
+        log(`[SessionStart] Selected: ${result.session.path} (match: ${result.matchReason})`);
+        const content = stripAnsi(result.content);
+        if (content && !content.includes('[Session context goes here]')) {
+          additionalContextParts.push(`Previous session summary:\n${content}`);
+        }
+      }
     } else {
       log('[SessionStart] No matching session found');
     }
```

Re-apply by running: `bash ~/projects/Mnemosyne/install.sh`
```

- [ ] **Step 5: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add docs/patches/session-start-bleed-fix.md
git commit -m "docs: document session-start.js context bleed fix for re-application after ECC updates"
```

---

## Task 4: Global Tier Directories

**Files:**
- Create: `~/.claude/memory/permanent/`
- Create: `~/.claude/memory/feedback/`

- [ ] **Step 1: Create directories and deploy seeds**

```bash
mkdir -p /home/tlarcombe/.claude/memory/permanent
mkdir -p /home/tlarcombe/.claude/memory/feedback
```

- [ ] **Step 2: Deploy seed files (don't overwrite if already customised)**

```bash
for f in /home/tlarcombe/projects/Mnemosyne/seeds/permanent/*.md; do
  target="/home/tlarcombe/.claude/memory/permanent/$(basename "$f")"
  if [[ ! -f "$target" ]]; then
    cp "$f" "$target"
    echo "Deployed: $(basename "$f")"
  else
    echo "Skipped (exists): $(basename "$f")"
  fi
done
```

- [ ] **Step 3: Verify**

```bash
ls -la /home/tlarcombe/.claude/memory/permanent/
cat /home/tlarcombe/.claude/memory/permanent/user-identity.md
```

Expected: two `.md` files with correct frontmatter

---

## Task 5: mnemosyne-session-start.js

**Files:**
- Create: `src/hooks/mnemosyne-session-start.js`

- [ ] **Step 1: Write the hook**

```javascript
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
    const { text, charsUsed } = buildSection(1, tier1Files, remainingChars);
    if (text) {
      sections.push(`## Tier 1 — Global Feedback Memory\n\n${text}`);
      remainingChars -= charsUsed;
    }
  }

  const totalTokens = estimateTokens(sections.join('\n\n'));
  const cwd = event.cwd || process.cwd();

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
```

- [ ] **Step 2: Deploy**

```bash
cp /home/tlarcombe/projects/Mnemosyne/src/hooks/mnemosyne-session-start.js \
   /home/tlarcombe/.claude/scripts/hooks/
```

- [ ] **Step 3: Test manually**

```bash
echo '{"session_id":"test","cwd":"/home/tlarcombe/projects/Mnemosyne"}' | \
  node /home/tlarcombe/.claude/scripts/hooks/mnemosyne-session-start.js 2>&1
```

Expected stderr: `[Mnemosyne] Tier 0: 2 files | Tier 1: 0 files | ~X tokens | cwd: ...`
Expected stdout: valid JSON with `hookSpecificOutput.additionalContext` containing `## Tier 0`

- [ ] **Step 4: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add src/hooks/mnemosyne-session-start.js
git commit -m "feat: add mnemosyne-session-start.js for Tier 0/1 global memory injection"
```

---

## Task 6: Wire into settings.json

**Files:**
- Modify: `~/.claude/settings.json` — prepend Mnemosyne hook to SessionStart array

- [ ] **Step 1: Add the hook**

```bash
node -e "
const fs = require('fs');
const p = process.env.HOME + '/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const hook = {
  matcher: '*',
  hooks: [{
    type: 'command',
    command: 'node \"' + process.env.HOME + '/.claude/scripts/hooks/mnemosyne-session-start.js\"'
  }],
  description: 'Mnemosyne: inject Tier 0 (permanent) and Tier 1 (feedback) global memories',
  id: 'mnemosyne:session:tiers'
};
const existing = s.hooks.SessionStart || [];
if (existing.some(h => h.id === 'mnemosyne:session:tiers')) {
  console.log('Already wired — skipping');
} else {
  s.hooks.SessionStart = [hook, ...existing];
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  console.log('Wired: mnemosyne:session:tiers added as first SessionStart hook');
}
"
```

- [ ] **Step 2: Verify hook order**

```bash
node -e "
const s = JSON.parse(require('fs').readFileSync(process.env.HOME + '/.claude/settings.json'));
console.log(s.hooks.SessionStart.map(h => h.id));
"
```

Expected: `[ 'mnemosyne:session:tiers', 'session:start' ]`

---

## Task 7: /memory-status Command

**Files:**
- Create: `src/commands/memory-status.md`

- [ ] **Step 1: Write the command**

```markdown
---
name: memory-status
description: Show Mnemosyne memory tiers loaded in this session — files, token counts, and validity.
---

# /memory-status

Run these steps in order to report the current Mnemosyne memory state.

## Step 1 — Tier 0 (Permanent Global)

```bash
echo "=== Tier 0: Permanent Global ==="
echo "Dir: $HOME/.claude/memory/permanent/"
ls "$HOME/.claude/memory/permanent/"*.md 2>/dev/null | while read f; do
  chars=$(wc -c < "$f")
  tokens=$(( chars / 4 ))
  name=$(grep '^name:' "$f" | head -1 | cut -d' ' -f2-)
  echo "  $name (~${tokens} tokens) — $(basename $f)"
done || echo "  (empty)"
```

## Step 2 — Tier 1 (Global Feedback)

```bash
echo ""
echo "=== Tier 1: Global Feedback (cap: 50) ==="
echo "Dir: $HOME/.claude/memory/feedback/"
count=0
ls "$HOME/.claude/memory/feedback/"*.md 2>/dev/null | while read f; do
  valid=$(grep '^valid_until:' "$f" | cut -d' ' -f2-)
  name=$(grep '^name:' "$f" | head -1 | cut -d' ' -f2-)
  echo "  $name [valid_until: $valid] — $(basename $f)"
  count=$((count+1))
done || echo "  (empty)"
```

## Step 3 — Tier 2 (Project Memory)

```bash
echo ""
echo "=== Tier 2: Project Memory ==="
echo "Working directory: $(pwd)"
ENCODED=$(pwd | sed "s|$HOME||" | sed 's|[^a-zA-Z0-9]|-|g' | sed "s|^|-home-$(whoami)|")
MEM_DIR="$HOME/.claude/projects/${ENCODED}/memory"
echo "Memory dir: $MEM_DIR"
ls "$MEM_DIR/"*.md 2>/dev/null | grep -v MEMORY.md | while read f; do
  name=$(grep '^name:' "$f" | head -1 | cut -d' ' -f2-)
  echo "  $name — $(basename $f)"
done || echo "  (not found or empty)"
echo "Note: Tier 2 injected by Claude Code native auto-memory (not by Mnemosyne hook)"
```

## Step 4 — Tier 3 (Session Summaries)

```bash
echo ""
echo "=== Tier 3: Session Summaries ==="
SESSION_DIR="$HOME/.claude/session-data"
PROJ=$(basename "$(pwd)")
echo "Looking for sessions matching project: $PROJ or worktree: $(pwd)"
found=0
for f in "$SESSION_DIR/"*-session.tmp 2>/dev/null; do
  [ -f "$f" ] || continue
  if grep -q "Worktree:.*$(pwd)\|Project:.*$PROJ" "$f" 2>/dev/null; then
    mtime=$(stat -c '%y' "$f" | cut -d' ' -f1)
    echo "  MATCH [$mtime]: $(basename $f)"
    found=$((found+1))
    [ $found -ge 3 ] && break
  fi
done
[ $found -eq 0 ] && echo "  (no matching sessions — bleed guard active)"
echo "Note: recency-fallback disabled by Mnemosyne to prevent cross-project bleed"
```

## Step 5 — Token Budget Summary

```bash
echo ""
echo "=== Token Budget ==="
T0=$(cat "$HOME/.claude/memory/permanent/"*.md 2>/dev/null | wc -c)
T1=$(cat "$HOME/.claude/memory/feedback/"*.md 2>/dev/null | wc -c)
T0_TOKENS=$(( T0 / 4 ))
T1_TOKENS=$(( T1 / 4 ))
TOTAL=$(( T0_TOKENS + T1_TOKENS ))
echo "  Tier 0 (permanent):  ~${T0_TOKENS} tokens"
echo "  Tier 1 (feedback):   ~${T1_TOKENS} tokens"
echo "  Mnemosyne hook total: ~${TOTAL} / 3000 tokens"
echo "  Remaining for Tier 2+3: ~$(( 3000 - TOTAL )) tokens"
```

Summarise findings as: `Mnemosyne active: Tier 0 (N files), Tier 1 (N files), ~X/3000 tokens. Context bleed: disabled. Project tier: [project-name].`
```

- [ ] **Step 2: Deploy**

```bash
cp /home/tlarcombe/projects/Mnemosyne/src/commands/memory-status.md \
   /home/tlarcombe/.claude/commands/
```

- [ ] **Step 3: Verify**

```bash
ls /home/tlarcombe/.claude/commands/memory-status.md
```

Expected: file exists

- [ ] **Step 4: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add src/commands/memory-status.md
git commit -m "feat: add /memory-status command for Mnemosyne tier inspection"
```

---

## Task 8: install.sh

**Files:**
- Modify: `install.sh` (write from placeholder)

- [ ] **Step 1: Write install.sh**

```bash
#!/usr/bin/env bash
# Mnemosyne installer — idempotent, safe to re-run after ECC updates.
# Usage: bash ~/projects/Mnemosyne/install.sh

set -euo pipefail

MNEMOSYNE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
HOOKS_DIR="$CLAUDE_DIR/scripts/hooks"
COMMANDS_DIR="$CLAUDE_DIR/commands"
MEMORY_DIR="$CLAUDE_DIR/memory"
SETTINGS="$CLAUDE_DIR/settings.json"

echo "=== Mnemosyne Phase 1 Installer ==="
echo "Source: $MNEMOSYNE_DIR"
echo "Target: $CLAUDE_DIR"
echo ""

# Step 1: Global tier directories
echo "[1/6] Creating global memory tier directories..."
mkdir -p "$MEMORY_DIR/permanent"
mkdir -p "$MEMORY_DIR/feedback"
echo "  ~/.claude/memory/permanent/ — OK"
echo "  ~/.claude/memory/feedback/ — OK"

# Step 2: Seed files (skip if already customised)
echo "[2/6] Deploying Tier 0 seed files..."
for seed in "$MNEMOSYNE_DIR/seeds/permanent/"*.md; do
  target="$MEMORY_DIR/permanent/$(basename "$seed")"
  if [[ ! -f "$target" ]]; then
    cp "$seed" "$target"
    echo "  Deployed: $(basename "$seed")"
  else
    echo "  Skipped (exists): $(basename "$seed")"
  fi
done

# Step 3: Hook
echo "[3/6] Deploying mnemosyne-session-start.js..."
cp "$MNEMOSYNE_DIR/src/hooks/mnemosyne-session-start.js" "$HOOKS_DIR/"
echo "  ~/.claude/scripts/hooks/mnemosyne-session-start.js — OK"

# Step 4: Command
echo "[4/6] Deploying memory-status command..."
cp "$MNEMOSYNE_DIR/src/commands/memory-status.md" "$COMMANDS_DIR/"
echo "  ~/.claude/commands/memory-status.md — OK"

# Step 5: Wire SessionStart hook
echo "[5/6] Wiring Mnemosyne SessionStart hook..."
node -e "
const fs = require('fs');
const p = '$SETTINGS';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const hook = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'node \"$HOOKS_DIR/mnemosyne-session-start.js\"' }],
  description: 'Mnemosyne: inject Tier 0 (permanent) and Tier 1 (feedback) global memories',
  id: 'mnemosyne:session:tiers'
};
const existing = s.hooks.SessionStart || [];
if (existing.some(h => h.id === 'mnemosyne:session:tiers')) {
  console.log('  Already wired — updating hook command...');
  const idx = existing.findIndex(h => h.id === 'mnemosyne:session:tiers');
  existing[idx] = hook;
  s.hooks.SessionStart = existing;
} else {
  s.hooks.SessionStart = [hook, ...existing];
  console.log('  Wired: mnemosyne:session:tiers added as first SessionStart hook');
}
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
"

# Step 6: session-start.js bleed patch
echo "[6/6] Applying context bleed fix to session-start.js..."
SESSION_START="$HOOKS_DIR/session-start.js"
if grep -q 'Mnemosyne Tier-3 isolation' "$SESSION_START" 2>/dev/null; then
  echo "  Already patched — skipping"
else
  # Apply patch using Node.js for reliable string replacement
  node -e "
const fs = require('fs');
const p = '$SESSION_START';
let content = fs.readFileSync(p, 'utf8');
const OLD = \`      log(\\\`[SessionStart] Selected: \\\${result.session.path} (match: \\\${result.matchReason})\\\`);

      // Use the already-read content from selectMatchingSession (no duplicate I/O)
      const content = stripAnsi(result.content);
      if (content && !content.includes('[Session context goes here]')) {
        additionalContextParts.push(\\\`Previous session summary:\\\n\\\${content}\\\`);
      }\`;
  const NEW = \`      // Mnemosyne Tier-3 isolation: skip recency-fallback to prevent cross-project bleed
      if (result.matchReason === 'recency-fallback') {
        log(\\\`[SessionStart] Skipping session (recency-fallback — Mnemosyne isolation): \\\${result.session.path}\\\`);
      } else {
        log(\\\`[SessionStart] Selected: \\\${result.session.path} (match: \\\${result.matchReason})\\\`);
        const content = stripAnsi(result.content);
        if (content && !content.includes('[Session context goes here]')) {
          additionalContextParts.push(\\\`Previous session summary:\\\n\\\${content}\\\`);
        }
      }\`;
  if (content.includes(OLD)) {
    fs.writeFileSync(p, content.replace(OLD, NEW));
    console.log('  Patched: recency-fallback guard added');
  } else {
    console.log('  WARNING: patch target not found in session-start.js — manual patch may be needed');
    console.log('  See: docs/patches/session-start-bleed-fix.md');
  }
"
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "Post-install steps:"
echo "  1. Run migration: node $MNEMOSYNE_DIR/scripts/migrate-memories.js"
echo "  2. Restart Claude Code to activate the new SessionStart hook"
echo "  3. Run /memory-status in any session to verify"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x /home/tlarcombe/projects/Mnemosyne/install.sh
```

- [ ] **Step 3: Commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add install.sh
git commit -m "feat: add idempotent install.sh for Mnemosyne Phase 1"
```

---

## Task 9: Full Integration Test

- [ ] **Step 1: Run the installer end-to-end**

```bash
bash /home/tlarcombe/projects/Mnemosyne/install.sh
```

Expected: all 6 steps complete with no errors

- [ ] **Step 2: Run migration**

```bash
node /home/tlarcombe/projects/Mnemosyne/scripts/migrate-memories.js
```

Expected: `Migration complete: 51 scanned, N migrated, 0 errors`

- [ ] **Step 3: Smoke-test the Mnemosyne hook**

```bash
echo '{"session_id":"test","cwd":"/home/tlarcombe/projects/Mnemosyne"}' | \
  node /home/tlarcombe/.claude/scripts/hooks/mnemosyne-session-start.js 2>&1 | \
  node -e "
let d=''; process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const lines = d.split('\n');
  const stderr = lines.filter(l => l.startsWith('[Mnemosyne]'));
  const jsonLine = lines.find(l => l.startsWith('{'));
  if (stderr.length) console.log('HOOK STDERR:', stderr[0]);
  if (jsonLine) {
    const out = JSON.parse(jsonLine);
    const ctx = out?.hookSpecificOutput?.additionalContext || '';
    console.log('Has Tier 0 content:', ctx.includes('Tier 0'));
    console.log('Context length (chars):', ctx.length);
  } else {
    console.log('ERROR: no JSON output found');
  }
});"
```

Expected:
```
HOOK STDERR: [Mnemosyne] Tier 0: 2 files | Tier 1: 0 files | ~X tokens | cwd: ...
Has Tier 0 content: true
Context length (chars): N
```

- [ ] **Step 4: Verify context bleed fix**

```bash
node /home/tlarcombe/.claude/scripts/hooks/session-start.js <<'EOF' 2>&1 | grep -E 'recency-fallback|Skipping|Selected|No matching'
{"session_id":"test","cwd":"/tmp/definitely-not-a-real-project-xyz123"}
EOF
```

Expected: `[SessionStart] Skipping session (recency-fallback — Mnemosyne isolation):`
NOT expected: `[SessionStart] Selected: ...` with a random other project's session

- [ ] **Step 5: Verify settings.json hook order**

```bash
node -e "
const s = JSON.parse(require('fs').readFileSync(process.env.HOME + '/.claude/settings.json'));
const ids = (s.hooks.SessionStart || []).map(h => h.id);
console.log('SessionStart hook order:', ids);
const mnemosyneFirst = ids[0] === 'mnemosyne:session:tiers';
const eccPresent = ids.includes('session:start');
console.log('Mnemosyne first:', mnemosyneFirst ? 'PASS' : 'FAIL');
console.log('ECC hook present:', eccPresent ? 'PASS' : 'FAIL');
"
```

Expected: both lines show `PASS`

- [ ] **Step 6: Final commit**

```bash
cd /home/tlarcombe/projects/Mnemosyne
git add -A
git commit -m "feat: Phase 1 complete — Mnemosyne foundations installed and verified"
```

---

## Self-Review Against Spec

| Spec Requirement | Covered By |
|-----------------|------------|
| Tier 0 permanent/ directory | Task 4 |
| Tier 1 feedback/ directory | Task 4 |
| Project isolation for Tier 2/3 | Task 3 (bleed fix) + native auto-memory |
| Frontmatter schema migration | Task 2 |
| recorded_at / valid_until / scope fields | Task 2 migration + Task 1 seeds |
| Bitemporal validity check (skip superseded) | Task 5, `isValid()` |
| Token budget cap (~3000) | Task 5, CHAR_BUDGET |
| Tier 1 cap at 50 entries | Task 5, `.slice(0, 50)` |
| SessionStart injection | Task 5 + Task 6 |
| /memory-status command | Task 7 |
| install.sh | Task 8 |
| No fallback to most recent unrelated session | Task 3 |
